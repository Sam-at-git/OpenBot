/**
 * Keeping a long conversation small enough for the model, without changing what the person sees.
 *
 * Every model call is sent the whole conversation, and most of a long one is old tool results: page snapshots,
 * command output, file reads. A Bot rarely needs a snapshot of a page it left ten steps ago, but it keeps paying for
 * it on every call, and a local model slows down and then loses the thread past about 100k tokens.
 *
 * So when the conversation is over its budget, the oldest tool results are replaced by a short note with the first
 * lines of what they said. Everything the person and the Bot said to each other is kept, the most recent tool
 * results are always kept whole, and so is any short result (a "saved" or an error is cheap and often matters).
 * Only what is sent to the model changes; the stored conversation is untouched.
 *
 * Results are left out in blocks rather than one at a time, so the start of the conversation stays the same for many
 * calls in a row and a provider's prompt cache keeps working.
 */

export type HistoryBudget = {
  /** Above this many estimated tokens, old tool results are left out. 0 turns trimming off. */
  maxTokens: number;
  /** The most recent tool results that are always kept whole. */
  keepRecent: number;
  /** A tool result estimated below this is always kept. */
  minTokens: number;
  /** Tool results are left out in multiples of this, so the cut moves rarely. */
  block: number;
  /** How much of a left-out result is kept as a preview, in characters. */
  previewChars: number;
};

export const DEFAULT_HISTORY_BUDGET: HistoryBudget = {
  maxTokens: 60_000,
  keepRecent: 3,
  minTokens: 300,
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

/**
 * A rough token count, good enough to decide what to leave out: about four ASCII characters to a token, and one
 * token for anything else (Chinese text is close to one token per character).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** One message as this module sees it: whether it is a tool result, and its estimated size. */
export type HistoryItem = { toolResult: boolean; tokens: number };

/**
 * Which tool results to leave out, by index, so the conversation fits its budget.
 *
 * Oldest first. Never one of the last `keepRecent` tool results, and never one smaller than `minTokens`. The count is
 * rounded up to a whole `block`, so the cut only moves every few results.
 */
export function toolResultsToLeaveOut(
  items: readonly HistoryItem[],
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
): Set<number> {
  const out = new Set<number>();
  if (budget.maxTokens <= 0) return out;
  let total = items.reduce((sum, item) => sum + item.tokens, 0);
  if (total <= budget.maxTokens) return out;

  const toolIndexes = items.flatMap((item, index) =>
    item.toolResult ? [index] : [],
  );
  const candidates = toolIndexes
    .slice(0, Math.max(0, toolIndexes.length - budget.keepRecent))
    .filter((index) => items[index].tokens >= budget.minTokens);

  let needed = 0;
  for (const index of candidates) {
    if (total <= budget.maxTokens) break;
    total -= items[index].tokens;
    needed++;
  }
  const rounded = Math.min(
    candidates.length,
    Math.ceil(needed / Math.max(1, budget.block)) * Math.max(1, budget.block),
  );
  for (const index of candidates.slice(0, rounded)) out.add(index);
  return out;
}

/** What a left-out tool result becomes: a note the model can act on, with the start of the original. */
export function leftOutNote(
  original: string,
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
): string {
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
): M[] {
  const items = messages.map((message) => ({
    toolResult: shape.isToolResult(message),
    tokens: estimateTokens(
      shape.isToolResult(message)
        ? shape.text(message)
        : JSON.stringify(message),
    ),
  }));
  const out = toolResultsToLeaveOut(items, budget);
  if (out.size === 0) return [...messages];
  return messages.map((message, index) =>
    out.has(index)
      ? shape.withContent(message, leftOutNote(shape.text(message), budget))
      : message,
  );
}

/** {@link trimHistory} for AG-UI messages, where a tool result is `role: "tool"` with string content. */
export function trimAgUiHistory<
  M extends { role: string; content?: unknown },
>(messages: readonly M[], budget?: HistoryBudget): M[] {
  return trimHistory(
    messages,
    {
      isToolResult: (message) => message.role === "tool",
      text: (message) => contentText(message.content),
      withContent: (message, content) => ({ ...message, content }),
    },
    budget,
  );
}
