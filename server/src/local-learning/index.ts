/**
 * Automatic Learning on this machine (`OPENBOT_THREADS=local`).
 *
 * WHAT THIS REPLACES. With Intelligence, finished conversations were studied in CopilotKit's cloud, Skills were
 * proposed and published there, and runs downloaded them. Here the same three steps stay local:
 *
 * 1. Study: on a schedule (default daily) or when an administrator asks, the analyzer reads conversations that changed
 *    since it last read them, from the local conversation store, and asks this deployment's own model (analyze.ts) for
 *    Skills worth keeping.
 * 2. Review: every proposal waits in the local store (store.ts) until an administrator puts it into use, edits it or
 *    declines it, under Admin, Automatic learning.
 * 3. Use: a Bot's run is handed its approved Skills the way Intelligence delivery hands them (`learnedSkillInvocation`):
 *    a catalog of names and descriptions in the prompt, and a tool that loads one when it is relevant.
 *
 * Learned Skills belong to a Bot, not to a person: a Skill learned from one person's conversation reaches everyone who
 * uses that Bot. That is why nothing is used until an administrator has read it.
 */
import { createHash } from "node:crypto";
import type { Message } from "@ag-ui/client";
import type { VerifiedSnapshot } from "@copilotkit/runtime/internal/learned-skills";
import type {
  LocalLearnedSkill,
  LocalLearningSettings,
  LocalLearningState,
} from "@openbot/shared/learning";
import {
  type AcquireLearnedSkills,
  learnedSkillInvocation,
} from "../learning/runtime";
import type { LearningThreadRecord } from "../local-threads/runner";
import {
  analysisPrompt,
  parseProposals,
  personLanguage,
  transcriptOf,
  worthReading,
} from "./analyze";
import type { LocalLearningStore } from "./store";

/** A conversation is read once it has been quiet this long, so one still going is not studied half-way. */
const SETTLE_MS = 15 * 60_000;
/** How often the schedule is checked. */
const TICK_MS = 10 * 60_000;
/** At most this many conversations per run, so one run never holds the model for hours. The rest wait for the next. */
const MAX_PER_RUN = 25;

export type LocalLearningThreads = {
  learningThreads(): LearningThreadRecord[];
  getThreadMessages(threadId: string, scope: { ownerId: string }): Message[];
};

/** A learned Skill as a Bot loads it: SKILL.md with its name and description up top. */
export function skillMarkdown(
  skill: Pick<LocalLearnedSkill, "name" | "description" | "instructions">,
): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions.trim()}\n`;
}

/** A Bot's approved Skills as the snapshot shape the SDK's catalog and loader read. */
export function snapshotOf(
  skills: readonly LocalLearnedSkill[],
): VerifiedSnapshot {
  const entries = skills.map((skill) => {
    const text = skillMarkdown(skill);
    return Object.freeze({
      name: skill.name,
      description: skill.description,
      files: Object.freeze([
        Object.freeze({
          path: "SKILL.md",
          size: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
          text,
        }),
      ]),
    });
  });
  const identity = createHash("sha256")
    .update(JSON.stringify(entries.map((entry) => entry.files[0]?.sha256)))
    .digest("hex");
  return Object.freeze({
    revision: `local:${identity}`,
    etag: `"${identity}"`,
    skills: Object.freeze(entries),
  });
}

export function createLocalLearning(options: {
  store: LocalLearningStore;
  threads: LocalLearningThreads;
  /** One prompt in, the model's text out. The deployment's own model and key. */
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
  botName?: (agentId: string) => Promise<string | undefined>;
  now?: () => number;
  settleMs?: number;
  maxPerRun?: number;
}) {
  const { store, threads, complete } = options;
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const maxPerRun = options.maxPerRun ?? MAX_PER_RUN;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const excluded = (settings: LocalLearningSettings, agentId: string) =>
    settings.excludedAgents.includes(agentId);

  /** Conversations with runs the analyzer has not read, quiet or not. */
  const unread = (settings: LocalLearningSettings) => {
    const read = store.analyzedRunCounts();
    return threads
      .learningThreads()
      .filter(
        (thread) =>
          thread.runCount > (read.get(thread.threadId) ?? 0) &&
          !excluded(settings, thread.agentId),
      );
  };

  const acquire: AcquireLearnedSkills = async (agentId, signal) => {
    signal?.throwIfAborted();
    const settings = store.settings();
    if (!settings.enabled || excluded(settings, agentId)) return undefined;
    const approved = store.approvedFor(agentId);
    // A Bot with nothing approved runs exactly as one without Learning does.
    if (approved.length === 0) return undefined;
    return learnedSkillInvocation(snapshotOf(approved));
  };

  async function analyze(signal?: AbortSignal): Promise<void> {
    const runId = store.startRun();
    let read = 0;
    let proposed = 0;
    try {
      const settings = store.settings();
      const quietBefore = now() - settleMs;
      const due = unread(settings)
        .filter((thread) => thread.updatedAt <= quietBefore)
        .slice(0, maxPerRun);
      const names = new Map<string, string>();
      for (const thread of due) {
        signal?.throwIfAborted();
        const messages = threads.getThreadMessages(thread.threadId, {
          ownerId: thread.ownerId,
        });
        if (worthReading(messages)) {
          if (!names.has(thread.agentId))
            names.set(
              thread.agentId,
              (await options
                .botName?.(thread.agentId)
                .catch(() => undefined)) ?? thread.agentId,
            );
          const answer = await complete(
            analysisPrompt({
              botName: names.get(thread.agentId) ?? thread.agentId,
              transcript: transcriptOf(messages),
              known: store.knownFor(thread.agentId),
              declined: store.rejectedNamesFor(thread.agentId),
              language: personLanguage(messages),
            }),
            signal,
          );
          for (const proposal of parseProposals(answer)) {
            store.propose({
              ...proposal,
              agentId: thread.agentId,
              threadId: thread.threadId,
            });
            proposed++;
          }
        }
        // Marked only once read: a model that failed leaves the conversation for the next run.
        store.markAnalyzed(thread.threadId, thread.runCount);
        read++;
        store.progressRun(runId, read, proposed);
      }
      store.finishRun(runId);
    } catch (error) {
      // Never log the conversation or the model's answer; the kind of failure is enough to act on.
      console.error(
        JSON.stringify({
          type: "local-learning-run-failed",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
      store.progressRun(runId, read, proposed);
      store.finishRun(
        runId,
        "The analysis stopped before it finished. Check that the model is running, then try again.",
      );
    }
  }

  /** Start a run unless one is going. Resolves when it is under way, not when it ends. */
  function runNow(): { started: boolean } {
    if (running) return { started: false };
    running = analyze().finally(() => {
      running = undefined;
    });
    return { started: true };
  }

  function nextRunAt(settings: LocalLearningSettings): number | undefined {
    if (!settings.enabled) return undefined;
    const last = store.lastRunStartedAt();
    return last === undefined
      ? now()
      : last + settings.intervalHours * 3_600_000;
  }

  function tick() {
    const settings = store.settings();
    const next = nextRunAt(settings);
    if (next !== undefined && next <= now()) runNow();
  }

  return {
    acquire,
    runNow,
    /** Whether a run is going. Resolves when it ends (tests and shutdown). */
    idle: () => running ?? Promise.resolve(),
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    state(): LocalLearningState {
      const settings = store.settings();
      const latestRun = store.latestRun();
      const next = nextRunAt(settings);
      return {
        settings,
        latestRun,
        nextRunAt:
          next === undefined
            ? null
            : new Date(Math.max(next, now())).toISOString(),
        waitingConversations: unread(settings).length,
        skills: store.listSkills(),
      };
    },
    store,
  };
}
export type LocalLearning = ReturnType<typeof createLocalLearning>;
