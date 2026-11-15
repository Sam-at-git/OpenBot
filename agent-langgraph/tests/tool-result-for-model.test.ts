import { describe, expect, test } from "bun:test";
import {
  TOOL_RESULT_MAX_CHARS,
  toolResultForModel,
} from "../src/tool-result-for-model";

/** What a model reads of a tool result: no image data written as text, and nothing larger than the conversation. */

const png = `iVBORw0KGgo${"A".repeat(120_000)}==`;

describe("a tool result as the model reads it", () => {
  test("a screenshot's image data is replaced with a sentence saying what to use instead", () => {
    const read = toolResultForModel(JSON.stringify({ ok: true, base64: png }));

    expect(read.length).toBeLessThan(400);
    expect(read).toContain('"ok":true');
    expect(read).toContain("image or binary data left out");
    expect(read).toContain("computer_snapshot");
  });

  test("a data URL goes with its prefix", () => {
    const read = toolResultForModel(`data:image/png;base64,${png}`);

    expect(read).not.toContain("data:image/png");
  });

  test("ordinary output is handed over unchanged", () => {
    const output = `exit 0\n${"客户 25 属于分店乙。\n".repeat(400)}`;

    expect(toolResultForModel(output)).toBe(output);
  });

  test("a long result keeps its start and its end, and says what was cut", () => {
    const output = `START ${"x ".repeat(40_000)} END`;
    const read = toolResultForModel(output);

    expect(read.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 200);
    expect(read.startsWith("START")).toBe(true);
    expect(read.endsWith("END")).toBe(true);
    expect(read).toContain("characters cut from the middle");
  });
});
