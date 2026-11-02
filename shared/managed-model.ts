/**
 * The model an admin chose under Admin, Models, handed to a Bot that OpenBot runs in its own container (agent-bot,
 * agent-langgraph), so those Bots answer with it instead of the model their container was started with.
 *
 * Sent as request headers, never in the run body: the body's `forwardedProps` are kept with an approval request, and
 * the key must not be stored anywhere. The server sends them only to its own managed endpoint, alongside the managed
 * agent token, and the container reads them only on a request that carried that token.
 *
 * Every provider on Admin, Models speaks the OpenAI-compatible chat API, so this is a base URL, a key and a model.
 */
export type ManagedModel = {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** The conversation budget an admin gave this model (`shared/history-budget.ts`). Absent uses the default. */
  historyTokens?: number;
};

export const MANAGED_MODEL_HEADERS = {
  baseUrl: "x-openbot-model-base-url",
  apiKey: "x-openbot-model-key",
  model: "x-openbot-model",
  historyTokens: "x-openbot-history-tokens",
} as const;

/** Header values are ASCII only, and a model name need not be, so each value is percent-encoded. */
export function managedModelHeaders(
  chosen: ManagedModel,
): Record<string, string> {
  return {
    [MANAGED_MODEL_HEADERS.baseUrl]: encodeURIComponent(chosen.baseUrl),
    [MANAGED_MODEL_HEADERS.model]: encodeURIComponent(chosen.model),
    ...(chosen.apiKey
      ? { [MANAGED_MODEL_HEADERS.apiKey]: encodeURIComponent(chosen.apiKey) }
      : {}),
    ...(chosen.historyTokens
      ? { [MANAGED_MODEL_HEADERS.historyTokens]: String(chosen.historyTokens) }
      : {}),
  };
}

/** The chosen model on a request, or undefined when none was sent or it is malformed. */
export function readManagedModel(headers: Headers): ManagedModel | undefined {
  const read = (name: string) => {
    const raw = headers.get(name);
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const baseUrl = read(MANAGED_MODEL_HEADERS.baseUrl);
  const model = read(MANAGED_MODEL_HEADERS.model);
  if (!baseUrl || !model) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const history = Number(read(MANAGED_MODEL_HEADERS.historyTokens));
  return {
    baseUrl,
    model,
    apiKey: read(MANAGED_MODEL_HEADERS.apiKey) ?? null,
    ...(Number.isInteger(history) && history > 0
      ? { historyTokens: history }
      : {}),
  };
}
