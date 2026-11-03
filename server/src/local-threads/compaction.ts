/**
 * Compacting a long conversation for the model, the way Claude Code compacts its own context.
 *
 * WHY. Every model call is sent the whole conversation. Past its budget, `shared/history-budget.ts`
 * leaves the oldest tool results out, but that only reaches tool results: what the person and the Bot
 * said, and anything attached to a message, stays in full however long the conversation gets. A
 * conversation with eight manuals pasted into one message passed 200k tokens, every step re-read it,
 * and the cut that left tool results out moved every few steps, so a local model's prompt cache kept
 * starting over: minutes per step.
 *
 * WHAT. When what the model would be sent reaches COMPACT_AT of the budget, the earlier part of the
 * conversation is summarised by the Bot's own model, in sections that keep what a Bot needs to carry
 * on (what was asked, facts, files, errors, progress, every one of the person's messages, the work in
 * hand, the next step). From then on the model is sent that summary in place of the earlier part,
 * followed by the most recent part of the conversation word for word (KEEP_RECENT of the budget). The
 * summary does not change between calls, so the start of the prompt stays the same and the cache
 * holds. When the conversation reaches COMPACT_AT again, the new part is folded into a new summary.
 *
 * WHAT IT DOES NOT DO. It changes only what the model is sent. The stored conversation, and what the
 * person sees after any reload, keep every message as it was written.
 */
import type { Message } from "@ag-ui/client";
import { estimateTokens } from "@openbot/shared/history-budget";

/** Compact when what the model would be sent reaches this share of its budget. */
export const COMPACT_AT = 0.8;
/** How much of the budget the most recent messages keep, word for word, after compacting. */
export const KEEP_RECENT = 0.3;
/** The id of the summary in what the model is sent. Never stored as a message. */
export const SUMMARY_MESSAGE_ID = "openbot-conversation-summary";

export type StoredSummary = {
  /** The last message the summary covers. Everything after it is sent word for word. */
  throughMessageId: string;
  summary: string;
};

/** What compacting needs from the deployment: the budget, and a model call. */
export type CompactionDeps = {
  /** The conversation budget of the model this Bot uses, in tokens. Undefined uses `defaultBudget`. */
  budgetFor: (agentId: string) => Promise<number | undefined>;
  defaultBudget: number;
  /** One call to the Bot's own model, answered with text. */
  complete: (agentId: string, prompt: string) => Promise<string>;
  /**
   * About how many tokens each attached file costs the model, by attachment id. A stored message
   * names its files and nothing more; their text is put in only when the model is called, so without
   * this a message carrying eight manuals counts as a few hundred tokens.
   */
  attachmentTokens?: (ids: readonly string[]) => Promise<Map<string, number>>;
};

export function messageTokens(message: Message): number {
  return estimateTokens(JSON.stringify(message));
}

/** The attached files a message names, by attachment id. */
export function attachmentIdsOf(message: Message): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content as Record<string, unknown>[]) {
    const metadata = part?.metadata as { attachmentId?: unknown } | undefined;
    const source = part?.source as { value?: unknown } | undefined;
    const id =
      typeof metadata?.attachmentId === "string"
        ? metadata.attachmentId
        : typeof source?.value === "string"
          ? /\/api\/attachments\/([^/?#]+)/.exec(source.value)?.[1]
          : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

/** The summary as the model reads it, in place of the messages it covers. */
export function summaryMessage(summary: string): Message {
  return {
    id: SUMMARY_MESSAGE_ID,
    role: "user",
    content: `[This conversation was compacted. The summary below stands in for its earlier part, which you no longer see. The person still sees every message. Continue from where it left off.]\n\n${summary}`,
  } as Message;
}

/**
 * What the model is sent instead of `messages`, or null when there is no summary that applies: the
 * summary, then every message after the last one it covers. A summary whose last message is not in
 * the conversation (somebody edited or regenerated past it) does not apply.
 */
export function compactedView(
  messages: readonly Message[],
  stored: StoredSummary | null,
): Message[] | null {
  if (!stored) return null;
  const through = messages.findIndex(
    (message) => message.id === stored.throughMessageId,
  );
  if (through < 0) return null;
  return [summaryMessage(stored.summary), ...messages.slice(through + 1)];
}

/**
 * Whether to compact, and where: the messages from `from` up to (not including) `cut` are folded into
 * the summary. Null when the conversation is under COMPACT_AT of `budget`, or nothing can be folded.
 *
 * The cut lands on one of the person's messages, so what stays begins where they spoke, and a tool
 * call is never separated from its result.
 */
export function planCompaction(
  messages: readonly Message[],
  stored: StoredSummary | null,
  budget: number,
  options: {
    /** What each message's attached files add, by position. */
    extraTokens?: readonly number[];
    /**
     * How many tokens the model itself said it read on the last call. Larger than the estimate when
     * the estimate missed something, and then it is the one believed.
     */
    measuredTokens?: number;
  } = {},
): { from: number; cut: number; tokens: number } | null {
  if (budget <= 0) return null;
  const covered = stored
    ? messages.findIndex((message) => message.id === stored.throughMessageId)
    : -1;
  const from = covered + 1;
  const sizes = messages.map(
    (message, index) =>
      messageTokens(message) + (options.extraTokens?.[index] ?? 0),
  );
  const estimated =
    (covered >= 0 && stored ? estimateTokens(stored.summary) : 0) +
    sizes.slice(from).reduce((sum, size) => sum + size, 0);
  const tokens = Math.max(estimated, options.measuredTokens ?? 0);
  if (tokens < COMPACT_AT * budget) return null;

  // Walk back from the end until the recent part holds KEEP_RECENT of the budget.
  let keepFrom = messages.length;
  let kept = 0;
  for (let index = messages.length - 1; index > from; index -= 1) {
    kept += sizes[index] ?? 0;
    keepFrom = index;
    if (kept >= KEEP_RECENT * budget) break;
  }
  /*
   * Where the kept part may begin. The person's messages first, so it begins where they spoke; then the
   * start of one of the Bot's steps, which never parts a tool call from its result (results follow the
   * call they answer, so every call before an assistant message has been answered). After the message
   * that crossed KEEP_RECENT, so a message too big to keep (eight manuals, say) is folded rather than
   * kept; failing that at it, and failing that the nearest one before.
   */
  const role = (index: number) => messages[index]?.role;
  const firstAfter = (start: number, wanted: (index: number) => boolean) => {
    for (let index = start; index < messages.length; index += 1)
      if (wanted(index)) return index;
    return -1;
  };
  const isPerson = (index: number) => role(index) === "user";
  const isStep = (index: number) =>
    role(index) === "user" || role(index) === "assistant";
  // Folded only when it is big on its own; an ordinary message there is where the kept part starts.
  const start =
    (sizes[keepFrom] ?? 0) > (KEEP_RECENT * budget) / 2 ? keepFrom + 1 : keepFrom;
  let cut = firstAfter(start, isPerson);
  if (cut < 0) cut = firstAfter(start, isStep);
  if (cut < 0 && isStep(keepFrom)) cut = keepFrom;
  if (cut < 0)
    for (let index = keepFrom - 1; index > from; index -= 1)
      if (isStep(index)) {
        cut = index;
        break;
      }
  if (cut <= from) return null;
  return { from, cut, tokens };
}

const CAPS = {
  user: 6_000,
  assistant: 4_000,
  toolArguments: 400,
  toolResult: 1_500,
};

function capped(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)} …[${text.length - limit} more characters]`;
}

/** A message's content as text: a string, or its text parts with attachments named. */
function contentOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Record<string, unknown>) => {
      if (part?.type === "text" && typeof part.text === "string")
        return part.text;
      const metadata = part?.metadata as { filename?: unknown } | undefined;
      const name =
        typeof metadata?.filename === "string" ? metadata.filename : "a file";
      return `[attached: ${name}]`;
    })
    .join("\n");
}

/** The messages as a plain transcript for the summariser, each one bounded. */
export function renderTranscript(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const role = message.role;
      if (role === "user")
        return `PERSON:\n${capped(contentOf(message), CAPS.user)}`;
      if (role === "tool")
        return `TOOL RESULT:\n${capped(contentOf(message), CAPS.toolResult)}`;
      if (role === "assistant") {
        const calls = (
          (message as { toolCalls?: unknown }).toolCalls as
            | { function?: { name?: string; arguments?: string } }[]
            | undefined
        )
          ?.map(
            (call) =>
              `[calls ${call.function?.name ?? "a tool"}(${capped(call.function?.arguments ?? "", CAPS.toolArguments)})]`,
          )
          .join("\n");
        const text = capped(contentOf(message), CAPS.assistant);
        return `BOT:\n${[text, calls].filter(Boolean).join("\n")}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Split a transcript's messages into pieces the model can read in one call. */
export function chunksOf(
  messages: readonly Message[],
  chunkTokens: number,
): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let size = 0;
  for (const message of messages) {
    const tokens = estimateTokens(renderTranscript([message]));
    if (current.length > 0 && size + tokens > chunkTokens) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The instruction the summariser is given. Sectioned the way Claude Code compacts its own context. */
export function summaryPrompt(
  previousSummary: string | null,
  transcript: string,
): string {
  return [
    "You are compacting a long conversation between a person and an AI assistant (a Bot), so the Bot can continue it with less context. For the Bot only, the earlier part of the conversation will be replaced by your summary. The person still sees everything.",
    "",
    "Write a summary detailed enough that the Bot can carry on as if it had read everything. Use exactly these sections:",
    "1. Primary request and intent: everything the person asked for, in detail.",
    "2. Key facts and decisions: names, numbers, IDs, addresses, settings, and conclusions reached.",
    "3. Files and data: every file, folder, page or record that was read, written or changed, with its path and what it holds.",
    "4. Errors and fixes: what went wrong and how it was resolved, including every correction the person made.",
    "5. Progress: what is done, item by item, so nothing is done twice.",
    "6. All of the person's messages: each one, in order, as close to their own words as possible.",
    "7. Pending tasks: what was asked and is not done yet.",
    "8. Current work: exactly what was being worked on at the end, with the latest details.",
    "9. Next step: what the Bot should do next, quoting the person's latest instruction where there is one.",
    "",
    "Write in the language the conversation is mostly in. Prefer exact values to descriptions. Leave out nothing the Bot would need to avoid repeating work or asking again. Output only the summary.",
    ...(previousSummary
      ? [
          "",
          "<earlier-summary>",
          "The conversation was compacted before. Fold this summary in, keeping its details:",
          previousSummary,
          "</earlier-summary>",
        ]
      : []),
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

/** Below this, an answer is not a summary of anything: kept out rather than standing in for a conversation. */
const MIN_SUMMARY_CHARS = 200;

/**
 * The new summary of `messages[from, cut)`, folded onto `stored`'s, read in pieces when the part to
 * fold is larger than one call can take. Throws when the model gives no usable summary.
 */
export async function summarise(input: {
  messages: readonly Message[];
  from: number;
  cut: number;
  stored: StoredSummary | null;
  budget: number;
  complete: (prompt: string) => Promise<string>;
}): Promise<string> {
  const covered = input.stored ? input.stored.summary : null;
  // A piece leaves room for the instruction, the summary so far and the answer.
  const chunkTokens = Math.max(8_000, Math.floor(input.budget * 0.6));
  let summary = covered;
  for (const chunk of chunksOf(
    input.messages.slice(input.from, input.cut),
    chunkTokens,
  )) {
    const answer = (
      await input.complete(summaryPrompt(summary, renderTranscript(chunk)))
    )
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();
    if (answer.length < MIN_SUMMARY_CHARS)
      throw new Error("the model gave no usable summary");
    summary = answer;
  }
  if (!summary) throw new Error("there was nothing to summarise");
  return summary;
}
