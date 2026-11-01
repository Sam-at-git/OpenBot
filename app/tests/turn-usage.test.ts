import { describe, expect, test } from "bun:test";
import { type TurnUsage, usageLabel } from "@/lib/copilot/turn-usage";

const report = (patch: Partial<TurnUsage>): TurnUsage => ({
  runId: "r1",
  messageId: "m1",
  model: "deepseek-chat",
  calls: 1,
  inputTokens: 1200,
  outputTokens: 34,
  ...patch,
});

describe("usageLabel", () => {
  test("names the model and the tokens in and out", () => {
    expect(usageLabel([report({})])).toBe(
      "deepseek-chat · 1,200 tokens in · 34 out",
    );
  });

  test("sums every report for one reply and counts model calls", () => {
    expect(
      usageLabel([
        report({ calls: 3 }),
        report({ runId: "r2", inputTokens: 800, outputTokens: 6, calls: 2 }),
      ]),
    ).toBe("deepseek-chat · 2,000 tokens in · 40 out · 5 model calls");
  });

  test("says so when the provider reported no tokens", () => {
    expect(
      usageLabel([report({ inputTokens: null, outputTokens: null })]),
    ).toBe("deepseek-chat · tokens not reported");
  });

  test("nothing to show without a report", () => {
    expect(usageLabel([])).toBeUndefined();
  });
});

describe("turnUsageLabels", () => {
  const text = (id: string, role: "user" | "assistant") => ({
    kind: "text",
    id,
    role,
  });

  test("sums a whole turn, tool-only steps included, under its last reply", async () => {
    const { turnUsageLabels, PENDING } = await import(
      "@/lib/copilot/turn-usage"
    );
    const items = [
      text("u1", "user"),
      text("a1", "assistant"),
      { kind: "tools", id: "t1" },
      text("a2", "assistant"),
      text("u2", "user"),
      text("a3", "assistant"),
    ];
    const reports = new Map([
      ["a1", [report({ messageId: "a1", inputTokens: 100, outputTokens: 1 })]],
      [
        "a2",
        [
          report({
            runId: "tool-only",
            messageId: null,
            inputTokens: 200,
            outputTokens: 2,
          }),
          report({
            runId: "r3",
            messageId: "a2",
            inputTokens: 300,
            outputTokens: 3,
          }),
        ],
      ],
      [
        PENDING,
        [
          report({
            runId: "r9",
            messageId: null,
            inputTokens: 50,
            outputTokens: 5,
          }),
        ],
      ],
    ]);

    const labels = turnUsageLabels(items, reports);
    expect(labels.get("a1")).toBeUndefined();
    expect(labels.get("a2")).toBe(
      "deepseek-chat · 600 tokens in · 6 out · 3 model calls",
    );
    // The second turn has only the pending tool-only report so far.
    expect(labels.get("a3")).toBe("deepseek-chat · 50 tokens in · 5 out");
  });
});
