import type { LlmModelEntry } from "@openbot/shared/llm";
import {
  REASONING_EFFORTS,
  reasoningEffortFrom,
} from "@openbot/shared/model-fetch";

/**
 * The models editor on Admin, Models: one model per line, `id | label | input price | output price | conversation
 * budget | thinking`, where only the ID is required. Prices are per million tokens; the budget is in tokens, and `64k`
 * or `1m` may be written for it. Thinking is a level such as `low` or `none`.
 */

/** One line per model. Trailing empty fields are left off, so a bare ID stays a bare ID. */
export function formatModelsText(models: readonly LlmModelEntry[]): string {
  return models
    .map((model) => {
      const fields = [
        model.id,
        model.label ?? "",
        model.inputPricePerMillion === undefined
          ? ""
          : String(model.inputPricePerMillion),
        model.outputPricePerMillion === undefined
          ? ""
          : String(model.outputPricePerMillion),
        model.historyTokens === undefined ? "" : String(model.historyTokens),
        model.reasoningEffort ?? "",
      ];
      while (fields.length > 1 && fields[fields.length - 1] === "") {
        fields.pop();
      }
      return fields.join(" | ");
    })
    .join("\n");
}

/** A budget such as `60000`, `64k` or `1m`, as a whole number of tokens. */
function budget(
  text: string | undefined,
  line: number,
): number | undefined | string {
  const trimmed = (text ?? "").trim().toLowerCase();
  if (trimmed === "") return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(trimmed);
  const value = match
    ? Math.round(
        Number(match[1]) *
          (match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1),
      )
    : Number.NaN;
  if (!Number.isFinite(value) || value < 4_000 || value > 2_000_000) {
    return `Line ${line}: "${trimmed}" isn't a conversation budget. Use a number of tokens from 4000 to 2000000, such as 64k.`;
  }
  return value;
}

export type ParsedModels =
  | { ok: true; models: LlmModelEntry[] }
  | { ok: false; error: string };

function price(
  text: string | undefined,
  line: number,
): number | undefined | string {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return `Line ${line}: "${trimmed}" isn't a price. Use a number such as 0.5.`;
  }
  return value;
}

/**
 * Read the editor back. Blank lines are skipped and a repeated ID keeps its first line. A price that isn't a
 * non-negative number is an error naming its line.
 */
export function parseModelsText(text: string): ParsedModels {
  const models: LlmModelEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.trim() === "") continue;
    const [id = "", label = "", input, output, history, thinking, ...rest] = raw
      .split("|")
      .map((field) => field.trim());
    if (id === "") {
      return { ok: false, error: `Line ${line} has no model ID.` };
    }
    if (rest.length > 0) {
      return { ok: false, error: `Line ${line} has more than six fields.` };
    }
    const inputPrice = price(input, line);
    if (typeof inputPrice === "string") {
      return { ok: false, error: inputPrice };
    }
    const outputPrice = price(output, line);
    if (typeof outputPrice === "string") {
      return { ok: false, error: outputPrice };
    }
    const historyTokens = budget(history, line);
    if (typeof historyTokens === "string") {
      return { ok: false, error: historyTokens };
    }
    const reasoningEffort =
      (thinking ?? "") === "" ? undefined : reasoningEffortFrom(thinking);
    if (thinking && !reasoningEffort) {
      return {
        ok: false,
        error: `Line ${line}: "${thinking}" isn't a thinking level. Use one of ${REASONING_EFFORTS.join(", ")}.`,
      };
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const model: LlmModelEntry = { id };
    if (label !== "") model.label = label;
    if (inputPrice !== undefined) model.inputPricePerMillion = inputPrice;
    if (outputPrice !== undefined) model.outputPricePerMillion = outputPrice;
    if (historyTokens !== undefined) model.historyTokens = historyTokens;
    if (reasoningEffort !== undefined) model.reasoningEffort = reasoningEffort;
    models.push(model);
  }

  return { ok: true, models };
}

/** Add discovered IDs that the editor doesn't list yet, keeping every line already there. */
export function mergeModelIds(text: string, ids: readonly string[]): string {
  const parsed = parseModelsText(text);
  const known = new Set(
    parsed.ok
      ? parsed.models.map((model) => model.id)
      : text.split(/\r?\n/).map((line) => (line.split("|")[0] ?? "").trim()),
  );
  const added = ids.filter((id) => id.trim() !== "" && !known.has(id));
  if (added.length === 0) return text;
  const base = text.replace(/\s+$/, "");
  return base === "" ? added.join("\n") : `${base}\n${added.join("\n")}`;
}
