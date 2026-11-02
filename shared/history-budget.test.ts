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

  test("a short result is never left out", () => {
    const items = [
      { toolResult: true, tokens: 50 },
      ...Array.from({ length: 8 }, () => ({ toolResult: true, tokens: 3_000 })),
    ];
    expect(toolResultsToLeaveOut(items, budget).has(0)).toBe(false);
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

  test("a budget of 0 turns it off, and the environment sets it", () => {
    const messages = conversation(20);
    expect(trimAgUiHistory(messages, { ...budget, maxTokens: 0 })).toEqual(
      messages,
    );
    expect(historyBudgetFrom({}).maxTokens).toBe(60_000);
    expect(historyBudgetFrom({ HISTORY_TOKEN_BUDGET: "40000" }).maxTokens).toBe(
      40_000,
    );
    expect(historyBudgetFrom({ HISTORY_TOKEN_BUDGET: "0" }).maxTokens).toBe(0);
    expect(historyBudgetFrom({ HISTORY_TOKEN_BUDGET: "lots" }).maxTokens).toBe(
      60_000,
    );
  });

  test("Chinese text counts close to a token a character", () => {
    expect(estimateTokens("员工花名册")).toBe(5);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});
