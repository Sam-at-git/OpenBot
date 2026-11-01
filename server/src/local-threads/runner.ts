/**
 * Conversations kept on this machine: an AG-UI runner backed by one SQLite file.
 *
 * WHAT THIS REPLACES. With `OPENBOT_THREADS=local` (config.ts `runtimeCapabilities`), the runtime runs
 * in its own SSE mode instead of handing every run to CopilotKit Intelligence. A run executes in this
 * process, its events stream back over the run request itself, and its events and messages are kept
 * here. Nothing about a conversation is sent anywhere but the model the Bot calls.
 *
 * PORTED FROM `@copilotkit/sqlite-runner` 1.83.0 (MIT, CopilotKit), `src/sqlite-runner.ts`, with these
 * changes:
 *
 * - `bun:sqlite` instead of `better-sqlite3`, a native module this Bun server would have to build.
 * - The local Thread endpoints (`LocalThreadEndpointRunner`), which the upstream runner does not
 *   implement and the runtime needs for `GET /threads/:id/messages`. Shapes follow
 *   `InMemoryAgentRunner` in `@copilotkit/runtime/v2`.
 * - A message snapshot per run, the way `InMemoryAgentRunner` keeps one, so a thread's messages can
 *   be read without replaying its events.
 * - `persistedInputMessages` is honoured, as Intelligence honours it. A handoff or a routine sends
 *   the model a prompt it does not want in the transcript; what the conversation keeps is this list.
 * - The conversation lock that Intelligence used to issue (see `acquireLock`), so a headless turn and
 *   a person's run never write into one thread at once.
 * - No legacy (pre-owner) threads: this store starts with owners from its first row.
 *
 * ONE PROCESS PER FILE. Run state and locks are reset when the runner opens, because a run cannot
 * outlive the process that ran it. That is only true while a single server process uses the file,
 * which is how a local deployment runs: one `server` container. Two replicas sharing a file would
 * reset each other's running threads.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
  RunStartedEvent,
} from "@ag-ui/client";
import { compactEvents, EventType } from "@ag-ui/client";
import type {
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
  LocalThreadEndpointRecord,
  LocalThreadEndpointScope,
} from "@copilotkit/runtime/v2";
import {
  AgentRunner,
  finalizeRunEvents,
  ThreadAccessDeniedError,
  ThreadAlreadyRunningError,
  ɵresolveThreadOwner,
} from "@copilotkit/runtime/v2";
import type { Observable } from "rxjs";
import { ReplaySubject } from "rxjs";

/** Bumped when the tables below change shape. */
const SCHEMA_VERSION = 1;

type StoredRun = {
  runId: string;
  agentId: string;
  events: BaseEvent[];
  createdAt: number;
};

type ActiveConnection = {
  subject: ReplaySubject<BaseEvent>;
  agent?: AbstractAgent;
  runSubject?: ReplaySubject<BaseEvent>;
  stopRequested?: boolean;
};

type HeldLock = { runId: string; expiresAt: number };

/** Why a lock call was refused, with the status a platform client would have answered. */
export class LocalThreadLockError extends Error {
  constructor(
    message: string,
    readonly status: 409,
  ) {
    super(message);
    this.name = "LocalThreadLockError";
  }
}

export class LocalAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;

  private readonly db: Database;

  /** Live runs of this process, by thread, for streaming, reconnecting and stopping. */
  private readonly activeConnections = new Map<string, ActiveConnection>();

  /** Conversation locks, by thread. In memory: a lock never outlives the process that took it. */
  private readonly locks = new Map<string, HeldLock>();

  constructor(options: { dbPath: string }) {
    super();
    if (options.dbPath !== ":memory:")
      mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { create: true });
    // WAL keeps readers (a history read, a thread list) off the writer's back; NORMAL is durable
    // across a process crash, which is the failure a local deployment actually has.
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.initializeSchema();
    // A run cannot outlive the process that ran it. See ONE PROCESS PER FILE above.
    this.db.run(
      "UPDATE run_state SET is_running = 0, current_run_id = NULL, updated_at = ?",
      [Date.now()],
    );
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        agent_id TEXT,
        name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS threads_owner ON threads(owner_id, updated_at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        parent_run_id TEXT,
        agent_id TEXT NOT NULL,
        events TEXT NOT NULL,
        input TEXT NOT NULL,
        messages TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS agent_runs_thread ON agent_runs(thread_id, id)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_state (
        thread_id TEXT PRIMARY KEY,
        is_running INTEGER NOT NULL DEFAULT 0,
        current_run_id TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    this.db.run(
      "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)",
      [SCHEMA_VERSION, Date.now()],
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Owners

  /** The thread's owner, or undefined for a thread nobody has created yet. */
  private ownerOf(threadId: string): string | undefined {
    const row = this.db
      .query<{ owner_id: string }, [string]>(
        "SELECT owner_id FROM threads WHERE thread_id = ?",
      )
      .get(threadId);
    return row?.owner_id ?? undefined;
  }

  /** False when the thread is held by an owner other than `scope`'s. An unknown thread is claimable. */
  isThreadAccessible(
    threadId: string,
    scope: LocalThreadEndpointScope,
  ): boolean {
    const owner = this.ownerOf(threadId);
    return owner === undefined || owner === ɵresolveThreadOwner(scope.ownerId);
  }

  /** True when the thread exists and `ownerId` holds it. */
  private isOwnedBy(threadId: string, ownerId: string | undefined): boolean {
    return this.ownerOf(threadId) === ɵresolveThreadOwner(ownerId);
  }

  /**
   * Create the thread for `ownerId` if nobody has, and say whether `ownerId` holds it afterwards.
   * One IMMEDIATE transaction, so two claims of a new thread cannot both win.
   */
  claimThread(
    threadId: string,
    ownerId: string | undefined,
    agentId?: string,
  ): boolean {
    const owner = ɵresolveThreadOwner(ownerId);
    return this.db
      .transaction(() => {
        const now = Date.now();
        this.db.run(
          "INSERT INTO threads (thread_id, owner_id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO NOTHING",
          [threadId, owner, agentId ?? null, now, now],
        );
        if (agentId)
          this.db.run(
            "UPDATE threads SET agent_id = ? WHERE thread_id = ? AND agent_id IS NULL",
            [agentId, threadId],
          );
        return this.ownerOf(threadId) === owner;
      })
      .immediate();
  }

  /** Whether `ownerId` holds this thread. For callers outside the runtime (thread-status, history). */
  hasThread(threadId: string, ownerId: string): boolean {
    return this.isOwnedBy(threadId, ownerId);
  }

  // ---------------------------------------------------------------------------------------------
  // Locks: the conversation lock Intelligence used to issue.

  private heldLock(threadId: string): HeldLock | undefined {
    const lock = this.locks.get(threadId);
    if (!lock) return undefined;
    if (lock.expiresAt <= Date.now()) {
      this.locks.delete(threadId);
      return undefined;
    }
    return lock;
  }

  /**
   * Take the conversation for one run. Refused (409) while another run holds it or is running in it,
   * which is what a platform lock answered.
   */
  acquireLock(input: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }): void {
    const held = this.heldLock(input.threadId);
    if (held && held.runId !== input.runId)
      throw new LocalThreadLockError(
        "Somebody else is running in this conversation.",
        409,
      );
    if (this.getRunState(input.threadId).isRunning)
      throw new LocalThreadLockError(
        "A run is already in progress in this conversation.",
        409,
      );
    this.locks.set(input.threadId, {
      runId: input.runId,
      expiresAt: Date.now() + input.ttlSeconds * 1000,
    });
  }

  /** Keep the lock. Refused (409) when this run no longer holds it, so the caller stops. */
  renewLock(input: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }): void {
    const held = this.heldLock(input.threadId);
    if (!held || held.runId !== input.runId)
      throw new LocalThreadLockError(
        "This run no longer holds the conversation.",
        409,
      );
    held.expiresAt = Date.now() + input.ttlSeconds * 1000;
  }

  /** Give the lock back. Only the run holding it can. */
  releaseLock(input: { threadId: string; runId: string }): void {
    if (this.locks.get(input.threadId)?.runId === input.runId)
      this.locks.delete(input.threadId);
  }

  // ---------------------------------------------------------------------------------------------
  // Storage

  private storeRun(input: {
    threadId: string;
    runId: string;
    parentRunId: string | null;
    agentId: string;
    events: BaseEvent[];
    runInput: RunAgentInput;
    messages: Message[] | null;
  }): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO agent_runs (thread_id, run_id, parent_run_id, agent_id, events, input, messages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          input.threadId,
          input.runId,
          input.parentRunId,
          input.agentId,
          JSON.stringify(compactEvents(input.events)),
          JSON.stringify(input.runInput),
          input.messages ? JSON.stringify(input.messages) : null,
          now,
        ],
      );
      this.db.run("UPDATE threads SET updated_at = ? WHERE thread_id = ?", [
        now,
        input.threadId,
      ]);
    })();
  }

  private storedRuns(threadId: string): StoredRun[] {
    return this.db
      .query<
        {
          run_id: string;
          agent_id: string;
          events: string;
          created_at: number;
        },
        [string]
      >(
        "SELECT run_id, agent_id, events, created_at FROM agent_runs WHERE thread_id = ? ORDER BY id ASC",
      )
      .all(threadId)
      .map((row) => ({
        runId: row.run_id,
        agentId: row.agent_id,
        events: JSON.parse(row.events) as BaseEvent[],
        createdAt: row.created_at,
      }));
  }

  private latestRunId(threadId: string): string | null {
    const row = this.db
      .query<{ run_id: string }, [string]>(
        "SELECT run_id FROM agent_runs WHERE thread_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(threadId);
    return row?.run_id ?? null;
  }

  /** The thread's latest non-empty message snapshot, or none. */
  private latestSnapshot(threadId: string): Message[] {
    const row = this.db
      .query<{ messages: string }, [string]>(
        "SELECT messages FROM agent_runs WHERE thread_id = ? AND messages IS NOT NULL AND messages != '[]' ORDER BY id DESC LIMIT 1",
      )
      .get(threadId);
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }

  private setRunState(threadId: string, isRunning: boolean, runId?: string) {
    this.db.run(
      "INSERT OR REPLACE INTO run_state (thread_id, is_running, current_run_id, updated_at) VALUES (?, ?, ?, ?)",
      [threadId, isRunning ? 1 : 0, runId ?? null, Date.now()],
    );
  }

  private getRunState(threadId: string): {
    isRunning: boolean;
    currentRunId: string | null;
  } {
    const row = this.db
      .query<{ is_running: number; current_run_id: string | null }, [string]>(
        "SELECT is_running, current_run_id FROM run_state WHERE thread_id = ?",
      )
      .get(threadId);
    return {
      isRunning: row?.is_running === 1,
      currentRunId: row?.current_run_id ?? null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // AgentRunner

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId } = request;
    const runId = request.input.runId;
    const owner = ɵresolveThreadOwner(request.ownerId);
    if (!this.isThreadAccessible(threadId, { ownerId: owner }))
      throw new ThreadAccessDeniedError();
    if (this.getRunState(threadId).isRunning)
      throw new ThreadAlreadyRunningError();
    // A conversation another run has taken (a routine, a hop) refuses this one until it is given back.
    const held = this.heldLock(threadId);
    if (held && held.runId !== runId) throw new ThreadAlreadyRunningError();
    if (!this.claimThread(threadId, owner, request.agent.agentId))
      throw new ThreadAccessDeniedError();

    this.setRunState(threadId, true, runId);

    const parentRunId = this.latestRunId(threadId);
    const previousSnapshot = this.latestSnapshot(threadId);
    const historicRuns = this.storedRuns(threadId);
    const historicMessageIds = new Set<string>(
      previousSnapshot.map((message) => message.id),
    );
    for (const run of historicRuns) {
      for (const event of run.events) {
        if ("messageId" in event && typeof event.messageId === "string")
          historicMessageIds.add(event.messageId);
        if (event.type === EventType.RUN_STARTED) {
          for (const message of (event as RunStartedEvent).input?.messages ??
            [])
            historicMessageIds.add(message.id);
        }
      }
    }

    /*
     * What this run's record says it was asked: the caller's persisted list when it gave one, which
     * is what Intelligence did with it, and otherwise the input minus what the thread already holds.
     */
    const recordedInputMessages = (
      request.persistedInputMessages ??
      request.input.messages ??
      []
    ).filter((message) => !historicMessageIds.has(message.id));

    const currentRunEvents: BaseEvent[] = [];
    const nextSubject = new ReplaySubject<BaseEvent>(Infinity);
    const runSubject = new ReplaySubject<BaseEvent>(Infinity);
    const prevSubject = this.activeConnections.get(threadId)?.subject;
    const connection: ActiveConnection = {
      subject: nextSubject,
      agent: request.agent,
      runSubject,
      stopRequested: false,
    };
    this.activeConnections.set(threadId, connection);

    const emit = (event: BaseEvent) => {
      runSubject.next(event);
      nextSubject.next(event);
    };

    const ensureStoppedRunStarted = () => {
      if (
        !connection.stopRequested ||
        currentRunEvents.some((event) => event.type === EventType.RUN_STARTED)
      )
        return;
      // Stop can arrive before the agent sends its first event.
      const started: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        input: { ...request.input, messages: recordedInputMessages },
      };
      currentRunEvents.unshift(started);
      emit(started);
    };

    /** The thread's messages after this run, for `getThreadMessages`. */
    const snapshotAfterRun = (): Message[] => {
      const agentMessages = Array.isArray(request.agent.messages)
        ? [...request.agent.messages]
        : [];
      if (request.persistedInputMessages === undefined) return agentMessages;
      // The caller narrowed what is kept: the history, what it chose to keep of the input, and
      // whatever the run itself produced.
      const inputIds = new Set(
        (request.input.messages ?? []).map((message) => message.id),
      );
      const kept = [...previousSnapshot];
      const keptIds = new Set(kept.map((message) => message.id));
      for (const message of [
        ...request.persistedInputMessages,
        ...agentMessages.filter((message) => !inputIds.has(message.id)),
      ]) {
        if (keptIds.has(message.id)) continue;
        keptIds.add(message.id);
        kept.push(message);
      }
      return kept;
    };

    const finish = (failure?: unknown) => {
      if (failure !== undefined && !connection.stopRequested)
        console.error(
          "[local-threads] a run failed",
          { threadId, runId },
          failure,
        );
      ensureStoppedRunStarted();
      // Closes whatever the run left open; appends to `currentRunEvents` itself and returns what it added.
      for (const event of finalizeRunEvents(currentRunEvents, {
        stopRequested: connection.stopRequested ?? false,
        protocolVersion: request.input.protocolVersion,
        ...(failure !== undefined
          ? {
              interruptionMessage:
                failure instanceof Error ? failure.message : String(failure),
            }
          : {}),
      }))
        emit(event);
      if (currentRunEvents.length > 0)
        this.storeRun({
          threadId,
          runId,
          parentRunId,
          agentId: request.agent.agentId ?? "default",
          events: currentRunEvents,
          runInput: { ...request.input, messages: recordedInputMessages },
          messages: snapshotAfterRun(),
        });
      this.setRunState(threadId, false);
      connection.agent = undefined;
      connection.runSubject = undefined;
      connection.stopRequested = false;
      runSubject.complete();
      nextSubject.complete();
      if (this.activeConnections.get(threadId) === connection)
        this.activeConnections.delete(threadId);
    };

    const runAgent = async () => {
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let processed: BaseEvent = event;
            if (event.type === EventType.RUN_STARTED) {
              const started = event as RunStartedEvent;
              // The record names what the conversation keeps, never the whole prompt a caller sent.
              if (!started.input || request.persistedInputMessages)
                processed = {
                  ...started,
                  input: {
                    ...(started.input ?? request.input),
                    messages: recordedInputMessages,
                  },
                } as RunStartedEvent;
            }
            currentRunEvents.push(processed);
            emit(processed);
          },
        });
        finish();
      } catch (error) {
        finish(error);
      }
    };

    if (prevSubject)
      prevSubject.subscribe({
        next: (event) => nextSubject.next(event),
        error: (error) => nextSubject.error(error),
      });

    // Started now, not on subscription. A failure while storing must not leave the thread marked
    // running, where it would refuse every later run until the process restarts.
    runAgent().catch((error) => {
      console.error(
        "[local-threads] a run could not be finished",
        { threadId, runId },
        error,
      );
      try {
        const state = this.getRunState(threadId);
        if (state.currentRunId === null || state.currentRunId === runId)
          this.setRunState(threadId, false);
      } catch {}
      if (this.activeConnections.get(threadId) === connection)
        this.activeConnections.delete(threadId);
      runSubject.complete();
      nextSubject.complete();
    });

    return runSubject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    // A thread owned by somebody else replays like an unknown one.
    if (!this.isOwnedBy(request.threadId, request.ownerId)) {
      subject.complete();
      return subject.asObservable();
    }
    const emitted = new Set<string>();
    for (const event of compactEvents(
      this.storedRuns(request.threadId).flatMap((run) => run.events),
    )) {
      subject.next(event);
      if ("messageId" in event && typeof event.messageId === "string")
        emitted.add(event.messageId);
    }
    const active = this.activeConnections.get(request.threadId);
    if (
      active &&
      (this.getRunState(request.threadId).isRunning || active.stopRequested)
    ) {
      active.subject.subscribe({
        next: (event) => {
          if (
            "messageId" in event &&
            typeof event.messageId === "string" &&
            emitted.has(event.messageId)
          )
            return;
          subject.next(event);
        },
        complete: () => subject.complete(),
        error: (error) => subject.error(error),
      });
    } else {
      subject.complete();
    }
    return subject.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    if (!this.isOwnedBy(request.threadId, request.ownerId))
      return Promise.resolve(false);
    return Promise.resolve(this.getRunState(request.threadId).isRunning);
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const state = this.getRunState(request.threadId);
    if (!state.isRunning) return Promise.resolve(false);
    if (!this.isOwnedBy(request.threadId, request.ownerId))
      return Promise.resolve(false);
    // A run-scoped stop never stops a newer run on the thread.
    if (request.runId !== undefined && state.currentRunId !== request.runId)
      return Promise.resolve(false);
    const connection = this.activeConnections.get(request.threadId);
    const agent = connection?.agent;
    if (!connection || !agent || connection.stopRequested)
      return Promise.resolve(false);
    connection.stopRequested = true;
    this.setRunState(request.threadId, false);
    try {
      agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      console.error("[local-threads] a run could not be stopped", error);
      connection.stopRequested = false;
      this.setRunState(request.threadId, true, state.currentRunId ?? undefined);
      return Promise.resolve(false);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Local Thread endpoints (LocalThreadEndpointRunner)

  listThreads(scope?: LocalThreadEndpointScope): LocalThreadEndpointRecord[] {
    const owner = ɵresolveThreadOwner(scope?.ownerId);
    return this.db
      .query<
        {
          thread_id: string;
          owner_id: string;
          agent_id: string | null;
          name: string | null;
          created_at: number;
          updated_at: number;
        },
        [string]
      >(
        "SELECT thread_id, owner_id, agent_id, name, created_at, updated_at FROM threads WHERE owner_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE agent_runs.thread_id = threads.thread_id) ORDER BY updated_at DESC",
      )
      .all(owner)
      .map((row) => ({
        id: row.thread_id,
        name: row.name,
        agentId: row.agent_id ?? "default",
        organizationId: "",
        createdById: row.owner_id,
        archived: false,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
  }

  getThreadMessages(
    threadId: string,
    scope?: LocalThreadEndpointScope,
  ): Message[] {
    if (!this.isOwnedBy(threadId, scope?.ownerId)) return [];
    return this.latestSnapshot(threadId);
  }

  getThreadEvents(
    threadId: string,
    scope?: LocalThreadEndpointScope,
  ): BaseEvent[] {
    if (!this.isOwnedBy(threadId, scope?.ownerId)) return [];
    return compactEvents(
      this.storedRuns(threadId).flatMap((run) => run.events),
    );
  }

  getThreadState(
    threadId: string,
    scope?: LocalThreadEndpointScope,
  ): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId, scope);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event?.type === EventType.STATE_SNAPSHOT)
        return (
          (event as { snapshot?: Record<string, unknown> }).snapshot ?? null
        );
    }
    return null;
  }

  /** Removes the owner's threads that are not running. */
  clearThreads(scope?: LocalThreadEndpointScope): void {
    const owner = ɵresolveThreadOwner(scope?.ownerId);
    this.db.transaction(() => {
      const idle = this.db
        .query<{ thread_id: string }, [string]>(
          "SELECT thread_id FROM threads WHERE owner_id = ? AND thread_id NOT IN (SELECT thread_id FROM run_state WHERE is_running = 1)",
        )
        .all(owner)
        .map((row) => row.thread_id);
      for (const threadId of idle) {
        this.db.run("DELETE FROM agent_runs WHERE thread_id = ?", [threadId]);
        this.db.run("DELETE FROM run_state WHERE thread_id = ?", [threadId]);
        this.db.run("DELETE FROM threads WHERE thread_id = ?", [threadId]);
      }
    })();
  }

  close(): void {
    this.db.close();
  }
}
