import { describe, expect, test } from "bun:test";
import {
  formatModelsText,
  mergeModelIds,
  parseModelsText,
} from "@/lib/llm/models-text";

describe("parseModelsText", () => {
  test("reads an ID alone, a label, and both prices", () => {
    expect(
      parseModelsText(
        "deepseek-chat\n\ndeepseek-reasoner | Reasoner\ngpt-5.5 | GPT | 1.25 | 10\n",
      ),
    ).toEqual({
      ok: true,
      models: [
        { id: "deepseek-chat" },
        { id: "deepseek-reasoner", label: "Reasoner" },
        {
          id: "gpt-5.5",
          label: "GPT",
          inputPricePerMillion: 1.25,
          outputPricePerMillion: 10,
        },
      ],
    });
  });

  test("allows prices without a label and keeps the first of a repeated ID", () => {
    expect(parseModelsText("a |  | 0.5\na | Again")).toEqual({
      ok: true,
      models: [{ id: "a", inputPricePerMillion: 0.5 }],
    });
  });

  test("names the line of a bad price or a missing ID", () => {
    const badPrice = parseModelsText("a\nb | B | cheap");
    expect(badPrice.ok).toBe(false);
    if (!badPrice.ok) expect(badPrice.error).toContain("Line 2");

    const noId = parseModelsText(" | label");
    expect(noId).toEqual({ ok: false, error: "Line 1 has no model ID." });

    expect(parseModelsText("a | b | 1 | 2 | 3").ok).toBe(false);
    expect(parseModelsText("a | b | -1").ok).toBe(false);
  });
});

describe("formatModelsText", () => {
  test("round-trips through the parser", () => {
    const models = [
      { id: "plain" },
      { id: "priced", inputPricePerMillion: 0.27, outputPricePerMillion: 1.1 },
      { id: "named", label: "Named" },
    ];
    const text = formatModelsText(models);
    expect(text).toBe("plain\npriced |  | 0.27 | 1.1\nnamed | Named");
    expect(parseModelsText(text)).toEqual({ ok: true, models });
  });
});

describe("mergeModelIds", () => {
  test("appends only IDs the editor doesn't list", () => {
    expect(mergeModelIds("a | A\n", ["a", "b", "c"])).toBe("a | A\nb\nc");
    expect(mergeModelIds("", ["x"])).toBe("x");
    expect(mergeModelIds("a", ["a"])).toBe("a");
  });
});

describe("a model's conversation budget", () => {
  test("is the fifth field, written as tokens, k or m", () => {
    expect(
      parseModelsText(
        "deepseek-v4-pro | | | | 200k\nqwen3:27b | Qwen | | | 40000\nbig | | | | 1m",
      ),
    ).toEqual({
      ok: true,
      models: [
        { id: "deepseek-v4-pro", historyTokens: 200_000 },
        { id: "qwen3:27b", label: "Qwen", historyTokens: 40_000 },
        { id: "big", historyTokens: 1_000_000 },
      ],
    });
  });

  test("outside 4k to 2m, or not a number, names its line", () => {
    const small = parseModelsText("m | | | | 100");
    expect(small.ok).toBe(false);
    expect(!small.ok && small.error).toContain("Line 1");
    expect(parseModelsText("m | | | | lots").ok).toBe(false);
    expect(parseModelsText("m | | | | 3m").ok).toBe(false);
  });

  test("survives a round trip through the editor", () => {
    const models = [
      { id: "a", historyTokens: 64_000 },
      { id: "b", label: "B", inputPricePerMillion: 1, historyTokens: 200_000 },
      { id: "c" },
    ];
    expect(parseModelsText(formatModelsText(models))).toEqual({
      ok: true,
      models,
    });
  });
});
