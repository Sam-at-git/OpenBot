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
 * Results are left out in large steps rather than one at a time, so the start of the conversation stays the same for
 * many calls in a row and a provider's prompt cache keeps working.
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
  /** The cut between left-out and kept tool results moves in multiples of this many results. */
  block: number;
  /** How much of a left-out result is kept as a preview, in characters. */
  previewChars: number;
};

export const DEFAULT_HISTORY_BUDGET: HistoryBudget = {
  maxTokens: 80_000,
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
 * When the cut moves, it saves at least this share of the budget more, so it then stays put while the conversation
 * grows by that much. Every move changes the start of what the model reads and a local model then reads all of it
 * again: about 80k tokens took 3.5 minutes on the M5 (2026-11-14). With blocks of eight alone, a browser task moved
 * the cut every eight steps.
 */
export const CUT_STEP = 0.25;

/**
 * Which tool results to leave out, by index, so the conversation fits what the budget leaves it after
 * `reservedTokens` (the system prompt and tools).
 *
 * The cut is a position in the list of tool results: before it, results are left out; after it, they are kept. It is
 * never inside the last `keepRecent` results, and it moves in whole `block`s. What is left out depends only on where
 * the cut is, never on how many results came after it, so the start of the conversation stays the same until the cut
 * moves. A short result is left out only once it is `keepRecentShort` results behind the cut (a "saved" or an error is
 * cheap and often matters), and one too small to be worth a note is never left out.
 *
 * The saving the cut must reach is rounded up to a whole {@link CUT_STEP} of the budget, so the cut moves rarely.
 */
export function toolResultsToLeaveOut(
  items: readonly HistoryItem[],
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
  reservedTokens = 0,
): Set<number> {
  if (budget.maxTokens <= 0) return new Set();
  const limit = Math.max(
    budget.maxTokens - reservedTokens,
    MIN_CONVERSATION_TOKENS,
  );
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  if (total <= limit) return new Set();

  const toolIndexes = items.flatMap((item, index) =>
    item.toolResult ? [index] : [],
  );
  const isShort = (index: number) => items[index].tokens < budget.minTokens;
  const saving = (index: number) =>
    items[index].tokens - (isShort(index) ? SHORT_NOTE_TOKENS : NOTE_TOKENS);
  const leftOutBefore = (cut: number) =>
    toolIndexes
      .slice(0, cut)
      .filter(
        (index, order) =>
          saving(index) > 0 &&
          (!isShort(index) || order < cut - budget.keepRecentShort),
      );

  const step = Math.max(1, Math.round(limit * CUT_STEP));
  const required = Math.ceil((total - limit) / step) * step;
  const furthest = Math.max(0, toolIndexes.length - budget.keepRecent);
  const block = Math.max(1, budget.block);
  let cut = 0;
  let saved = 0;
  while (cut < furthest && saved < required) {
    cut = Math.min(furthest, cut + block);
    saved = leftOutBefore(cut).reduce((sum, index) => sum + saving(index), 0);
  }
  return new Set(leftOutBefore(cut));
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
