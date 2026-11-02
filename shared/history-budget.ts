/**
 * Keeping a long conversation small enough for the model, without changing what the person sees.
 *
 * Every model call is sent the whole conversation, and most of a long one is old tool results: page snapshots,
 * command output, file reads. A Bot rarely needs a snapshot of a page it left ten steps ago, but it keeps paying for
 * it on every call, and a local model slows down and then loses the thread past about 100k tokens.
 *
 * So when the conversation is over its budget, the oldest tool results are replaced by a short note with the first
 * lines of what they said. Everything the person and the Bot said to each other is kept, the most recent tool
 * results are always kept whole, and so are the recent short ones (a "saved" or an error is cheap and often
 * matters). A long browser task makes hundreds of short results, though, so past the recent ones they are left out
 * too, as a one-line note. Only what is sent to the model changes; the stored conversation is untouched.
 *
 * The budget is for everything the model reads: the system prompt and tool definitions are counted first
 * (`reservedTokens`), and the conversation gets what is left.
 *
 * Results are left out in blocks rather than one at a time, so the start of the conversation stays the same for many
 * calls in a row and a provider's prompt cache keeps working.
 */

export type HistoryBudget = {
  /** Above this many estimated tokens, old tool results are left out. 0 turns trimming off. */
  maxTokens: number;
  /** The most recent tool results that are always kept whole. */
  keepRecent: number;
  /** A tool result estimated below this is short: kept among the last `keepRecentShort`, else a one-line note. */
  minTokens: number;
  /** How many of the most recent tool results keep their short results whole. */
  keepRecentShort: number;
  /** Tool results are left out in multiples of this, so the cut moves rarely. */
  block: number;
  /** How much of a left-out result is kept as a preview, in characters. */
  previewChars: number;
};

export const DEFAULT_HISTORY_BUDGET: HistoryBudget = {
  maxTokens: 60_000,
  keepRecent: 3,
  minTokens: 300,
  keepRecentShort: 20,
  block: 8,
  previewChars: 300,
};

/** The budget from `HISTORY_TOKEN_BUDGET` (0 turns trimming off), or the default. */
export function historyBudgetFrom(
  environment: Record<string, string | undefined>,
): HistoryBudget {
  const raw = environment.HISTORY_TOKEN_BUDGET?.trim();
  if (!raw) return DEFAULT_HISTORY_BUDGET;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_HISTORY_BUDGET;
  return { ...DEFAULT_HISTORY_BUDGET, maxTokens: Math.floor(value) };
}

/** How much the plain character estimate is raised by. See {@link estimateTokens}. */
export const ESTIMATE_FACTOR = 1.2;

/**
 * A rough token count, good enough to decide what to leave out: about four ASCII characters to a token and one token
 * for anything else (Chinese text is close to one a character), then a fifth more. Measured on a real browser task
 * with qwen3.8, the model counted 1.16 times the plain estimate, mostly because JSON and English split finer than
 * four characters to a token; erring high keeps a conversation under its budget rather than just over it.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) ascii++;
    else other++;
  }
  return Math.ceil((ascii / 4 + other) * ESTIMATE_FACTOR);
}

/** One message as this module sees it: whether it is a tool result, and its estimated size. */
export type HistoryItem = { toolResult: boolean; tokens: number };

/** However much the system prompt and tools take, the conversation keeps at least this much. */
export const MIN_CONVERSATION_TOKENS = 8_000;

/** About what a left-out result's note costs: with a preview, and the one-line note for a short result. */
const NOTE_TOKENS = 120;
const SHORT_NOTE_TOKENS = 12;

/**
 * Which tool results to leave out, by index, so the conversation fits what the budget leaves it after
 * `reservedTokens` (the system prompt and tools).
 *
 * Oldest first. Never one of the last `keepRecent` tool results, never a short one among the last `keepRecentShort`,
 * and never one too small to be worth a note. The count is rounded up to a whole `block`, so the cut only moves every
 * few results.
 */
export function toolResultsToLeaveOut(
  items: readonly HistoryItem[],
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
  reservedTokens = 0,
): Set<number> {
  const out = new Set<number>();
  if (budget.maxTokens <= 0) return out;
  const limit = Math.max(
    budget.maxTokens - reservedTokens,
    MIN_CONVERSATION_TOKENS,
  );
  let total = items.reduce((sum, item) => sum + item.tokens, 0);
  if (total <= limit) return out;

  const toolIndexes = items.flatMap((item, index) =>
    item.toolResult ? [index] : [],
  );
  const saving = (index: number) =>
    items[index].tokens -
    (items[index].tokens < budget.minTokens ? SHORT_NOTE_TOKENS : NOTE_TOKENS);
  const recentShort = new Set(toolIndexes.slice(-budget.keepRecentShort));
  const candidates = toolIndexes
    .slice(0, Math.max(0, toolIndexes.length - budget.keepRecent))
    .filter(
      (index) =>
        saving(index) > 0 &&
        (items[index].tokens >= budget.minTokens || !recentShort.has(index)),
    );

  let needed = 0;
  for (const index of candidates) {
    if (total <= limit) break;
    total -= saving(index);
    needed++;
  }
  const rounded = Math.min(
    candidates.length,
    Math.ceil(needed / Math.max(1, budget.block)) * Math.max(1, budget.block),
  );
  for (const index of candidates.slice(0, rounded)) out.add(index);
  return out;
}

/**
 * What a left-out tool result becomes: a note the model can act on, with the start of the original. A short result
 * gets a one-line note, since a preview would be most of it.
 */
export function leftOutNote(
  original: string,
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
): string {
  if (estimateTokens(original) < budget.minTokens)
    return "[Earlier tool result left out.]";
  const preview = original.slice(0, budget.previewChars).trimEnd();
  return `[Earlier tool result left out to keep the conversation short (about ${estimateTokens(original)} tokens). It began:\n${preview}${original.length > budget.previewChars ? "\n…" : ""}\nRun the tool again if you need it.]`;
}

/** The text of a message's content, whether a string or a list of parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/**
 * The same messages with old tool results left out, for any message shape: `isToolResult` says which are results and
 * `withContent` makes a copy of one with new text. Messages that are kept are returned as they are.
 */
export function trimHistory<M>(
  messages: readonly M[],
  shape: {
    isToolResult: (message: M) => boolean;
    text: (message: M) => string;
    withContent: (message: M, content: string) => M;
  },
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
  /** What the model reads besides the conversation: the system prompt and the tool definitions. */
  reservedTokens = 0,
): M[] {
  const items = messages.map((message) => ({
    toolResult: shape.isToolResult(message),
    tokens: estimateTokens(
      shape.isToolResult(message)
        ? shape.text(message)
        : JSON.stringify(message),
    ),
  }));
  const out = toolResultsToLeaveOut(items, budget, reservedTokens);
  if (out.size === 0) return [...messages];
  return messages.map((message, index) =>
    out.has(index)
      ? shape.withContent(message, leftOutNote(shape.text(message), budget))
      : message,
  );
}

/** {@link trimHistory} for AG-UI messages, where a tool result is `role: "tool"` with string content. */
export function trimAgUiHistory<M extends { role: string; content?: unknown }>(
  messages: readonly M[],
  budget?: HistoryBudget,
  reservedTokens?: number,
): M[] {
  return trimHistory(
    messages,
    {
      isToolResult: (message) => message.role === "tool",
      text: (message) => contentText(message.content),
      withContent: (message, content) => ({ ...message, content }),
    },
    budget,
    reservedTokens,
  );
}
