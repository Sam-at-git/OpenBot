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
