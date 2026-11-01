/**
 * The part of the Intelligence client OpenBot calls outside a person's run, kept on this machine.
 *
 * Routines, responsibilities, handoffs, approvals, channel names and delivery all reach a thread
 * through a handful of client methods: create it, read its history, take and give back its lock. In
 * local mode (`OPENBOT_THREADS=local`) they get this object instead, with the same method names and
 * the same answers, so none of them needs a second code path. It is backed by the runner that runs
 * people's chats (runner.ts), so a routine's reply is in the same thread the person opens.
 */
import type { Message } from "@ag-ui/client";
import { LocalAgentRunner, LocalThreadLockError } from "./runner";

/** One row of history in the platform's shape, which every caller of `getThreadMessages` reads. */
export type LocalThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/** A thread this deployment has not heard of, answered the way the platform answers: status 404. */
export class LocalThreadNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super("That conversation does not exist.");
    this.name = "LocalThreadNotFoundError";
  }
}

/** AG-UI's message, as the platform's history row. Mirrors the runtime's own local thread route. */
function toThreadMessage(message: Message): LocalThreadMessage {
  const row: LocalThreadMessage = { id: message.id, role: message.role };
  if ("content" in message && message.content !== undefined)
    row.content = message.content;
  if (message.role === "activity" && "activityType" in message)
    row.activityType = message.activityType;
  if (message.role === "assistant" && message.toolCalls?.length)
    row.toolCalls = message.toolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
    }));
  if (message.role === "tool") row.toolCallId = message.toolCallId;
  return row;
}

export type LocalThreadsClient = ReturnType<typeof createLocalThreadsClient>;

export function createLocalThreadsClient(runner: LocalAgentRunner) {
  return {
    /** Create the thread for this person if nobody has. Idempotent, as the platform's is. */
    async getOrCreateThread(params: {
      threadId: string;
      userId: string;
      agentId: string;
      learningContainerId?: string;
    }): Promise<{ thread: { id: string } }> {
      if (!runner.claimThread(params.threadId, params.userId, params.agentId))
        throw new LocalThreadNotFoundError();
      return { thread: { id: params.threadId } };
    },

    /** The thread, or a 404 when this person has none by that id. */
    async getThread(params: {
      threadId: string;
      userId: string;
    }): Promise<{ thread: { id: string } }> {
      if (!runner.hasThread(params.threadId, params.userId))
        throw new LocalThreadNotFoundError();
      return { thread: { id: params.threadId } };
    },

    /** Its messages as of the last run that finished. A thread nobody has run reads as empty. */
    async getThreadMessages(params: {
      threadId: string;
      userId: string;
    }): Promise<{ messages: LocalThreadMessage[] }> {
      return {
        messages: runner
          .getThreadMessages(params.threadId, { ownerId: params.userId })
          .map(toThreadMessage),
      };
    },

    /** Take the conversation for one run. A conflict is a 409, which callers read as "not now". */
    async ɵacquireThreadLock(params: {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
      ttlSeconds?: number;
      learningContainerId?: string;
    }): Promise<{ threadId: string; runId: string }> {
      if (!runner.claimThread(params.threadId, params.userId, params.agentId))
        throw new LocalThreadLockError(
          "That conversation belongs to somebody else.",
          409,
        );
      runner.acquireLock({
        threadId: params.threadId,
        runId: params.runId,
        ttlSeconds: params.ttlSeconds ?? 120,
      });
      return { threadId: params.threadId, runId: params.runId };
    },

    async ɵrenewThreadLock(params: {
      threadId: string;
      runId: string;
      ttlSeconds: number;
    }): Promise<void> {
      runner.renewLock(params);
    },

    async ɵcleanupThreadLock(params: {
      threadId: string;
      runId: string;
    }): Promise<void> {
      runner.releaseLock(params);
    },
  };
}

/**
 * One runner and one client per database file, for the whole process.
 *
 * Shared, not built per caller: the runner holds the live runs and the locks, and a second instance
 * on the same file would neither see a run the first is streaming nor respect its lock.
 */
const opened = new Map<
  string,
  { runner: LocalAgentRunner; client: LocalThreadsClient }
>();

export function localThreads(dbPath: string): {
  runner: LocalAgentRunner;
  client: LocalThreadsClient;
} {
  let entry = opened.get(dbPath);
  if (!entry) {
    const runner = new LocalAgentRunner({ dbPath });
    entry = { runner, client: createLocalThreadsClient(runner) };
    opened.set(dbPath, entry);
  }
  return entry;
}
