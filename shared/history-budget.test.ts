import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HISTORY_BUDGET,
  estimateTokens,
  historyBudgetFrom,
  toolResultsToLeaveOut,
  trimAgUiHistory,
} from "./history-budget";

const budget = { ...DEFAULT_HISTORY_BUDGET, maxTokens: 10_000, block: 2 };

/** A conversation: a question, then `steps` tool calls each with a 2,000-token result, then an answer. */
function conversation(steps: number) {
  const messages: { id: string; role: string; content?: string }[] = [
    { id: "u", role: "user", content: "录入这几个人" },
  ];
  for (let step = 0; step < steps; step++) {
    messages.push({
      id: `a${step}`,
      role: "assistant",
      content: `step ${step}`,
    });
    messages.push({
      id: `t${step}`,
      role: "tool",
      content: `snapshot ${step} ${"x".repeat(8_000)}`,
    });
  }
  messages.push({ id: "end", role: "assistant", content: "done" });
  return messages;
}

describe("keeping a long conversation within its budget", () => {
  test("a conversation under its budget is sent as it is", () => {
    const messages = conversation(3);
    expect(trimAgUiHistory(messages, budget)).toEqual(messages);
  });

  test("past it, the oldest tool results are left out and the newest kept whole", () => {
    const messages = conversation(10);
    const trimmed = trimAgUiHistory(messages, budget);
    const results = trimmed.filter((message) => message.role === "tool");
    const leftOut = results.filter((message) =>
      message.content?.startsWith("[Earlier tool result left out"),
    );
    expect(leftOut.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("snapshot 0");
    expect(results[0]?.content).toContain("Run the tool again");
    for (const kept of results.slice(-3))
      expect(kept.content?.startsWith("snapshot")).toBe(true);
    expect(
      trimmed.reduce(
        (sum, message) => sum + estimateTokens(JSON.stringify(message)),
        0,
      ),
    ).toBeLessThanOrEqual(budget.maxTokens + 1_000);
  });

  test("what the person and the Bot said, and every id, are kept", () => {
    const messages = conversation(10);
    const trimmed = trimAgUiHistory(messages, budget);
    expect(trimmed.map((message) => message.id)).toEqual(
      messages.map((message) => message.id),
    );
    expect(trimmed.filter((message) => message.role !== "tool")).toEqual(
      messages.filter((message) => message.role !== "tool"),
    );
  });

  test("a recent short result is kept, and an old one goes as one line", () => {
    const items = [
      ...Array.from({ length: 30 }, () => ({ toolResult: true, tokens: 250 })),
      ...Array.from({ length: 4 }, () => ({ toolResult: true, tokens: 3_000 })),
    ];
    const out = toolResultsToLeaveOut(items, { ...budget, block: 1 });
    // The first ten short results are older than the last twenty tool results.
    expect(out.has(0)).toBe(true);
    for (let index = 14; index < 30; index++)
      expect(out.has(index)).toBe(false);
    expect(
      trimAgUiHistory(
        [
          { role: "tool", content: "clicked" },
          ...Array.from({ length: 25 }, () => ({
            role: "tool",
            content: "y".repeat(40_000),
          })),
        ],
        { ...budget, block: 1, keepRecentShort: 3 },
      )[0]?.content,
    ).toBe("clicked");
  });

  test("the system prompt and tools are counted before the conversation", () => {
    const items = Array.from({ length: 10 }, () => ({
      toolResult: true,
      tokens: 900,
    }));
    // 9,000 tokens fits 10,000 on its own, but not beside a 5,000-token prompt.
    expect(toolResultsToLeaveOut(items, budget).size).toBe(0);
    expect(toolResultsToLeaveOut(items, budget, 5_000).size).toBeGreaterThan(0);
  });

  test("results are left out in whole blocks, so the cut moves rarely", () => {
    const items = Array.from({ length: 10 }, () => ({
      toolResult: true,
      tokens: 1_500,
    }));
    // 15,000 tokens against 10,000: four must go, which is already two blocks of two.
    expect(toolResultsToLeaveOut(items, budget).size).toBe(4);
    const odd = { ...budget, block: 3 };
    // Four needed, rounded up to two blocks of three.
    expect(toolResultsToLeaveOut(items, odd).size).toBe(6);
  });

  test("as a browser task grows, the cut only moves forward, and only every quarter of the budget", () => {
    // A long browser task: mostly short results (a click, a type), every third a page snapshot.
    const grown = { ...DEFAULT_HISTORY_BUDGET, maxTokens: 20_000 };
    const items: { toolResult: boolean; tokens: number }[] = [];
    let previous = new Set<number>();
    let moves = 0;
    for (let step = 0; step < 200; step++) {
      items.push({ toolResult: true, tokens: step % 3 === 0 ? 1_500 : 150 });
      const out = toolResultsToLeaveOut(items, grown);
      for (const index of previous) expect(out.has(index)).toBe(true);
      if (out.size !== previous.size) moves++;
      previous = out;
    }
    const total = items.reduce((sum, item) => sum + item.tokens, 0);
    // The saving needed only grows a whole step (5,000 tokens here) at a time.
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(Math.ceil(total / 5_000));
    // With blocks of eight alone it could move every eight results.
    expect(moves).toBeLessThan(200 / 8);
  });

  test("a short result reaching the end of the recent ones does not move the cut", () => {
    const items = [
      ...Array.from({ length: 40 }, (_, index) => ({
        toolResult: true,
        tokens: index % 2 === 0 ? 2_000 : 100,
      })),
    ];
    const before = toolResultsToLeaveOut(items, budget);
    // Two more short results push older short ones out of the most recent twenty.
    const after = toolResultsToLeaveOut(
      [
        ...items,
        { toolResult: true, tokens: 0 },
        { toolResult: true, tokens: 0 },
      ],
      budget,
    );
    expect([...after]).toEqual([...before]);
  });

  test("a budget of 0 turns it off, and the environment sets it", () => {
    const messages = conversation(20);
    expect(trimAgUiHistory(messages, { ...budget, maxTokens: 0 })).toEqual(
      messages,
    );
    expect(historyBudgetFrom({}).maxTokens).toBe(80_000);
    expect(historyBudgetFrom({ HISTORY_TOKEN_BUDGET: "40000" }).maxTokens).toBe(
      40_000,
    );
    expect(historyBudgetFrom({ HISTORY_TOKEN_BUDGET: "0" }).maxTokens).toBe(0);
    expect(historyBudgetFrom({ HISTORY_TOKEN_BUDGET: "lots" }).maxTokens).toBe(
      80_000,
    );
  });

  test("Chinese text counts close to a token a character, erring a fifth high", () => {
    expect(estimateTokens("员工花名册")).toBe(6);
    expect(estimateTokens("abcdefghijklmnopqrst")).toBe(6);
  });
});
