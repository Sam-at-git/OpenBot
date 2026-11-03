/**
 * `fetch` for model calls, which may be silent for minutes before the first token.
 *
 * Bun ends a request whose connection sends nothing for five minutes (`BUN_CONFIG_HTTP_IDLE_TIMEOUT`). A local model
 * reading a long conversation from a cold start sends nothing until it has read all of it: qwen3.8 on the Mac Studio
 * took 5 minutes 6 seconds for 63,657 tokens, and the call was cut off at 99.7%. Model calls get a longer idle limit;
 * every other request keeps Bun's default. A person can still stop a run, which aborts the call through its signal.
 */
export const MODEL_IDLE_TIMEOUT_MS = 15 * 60_000;

export const modelFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, {
      ...init,
      timeout: MODEL_IDLE_TIMEOUT_MS,
    } as Parameters<typeof fetch>[1]),
  { preconnect: fetch.preconnect },
);

/**
 * How much a model thinks before it answers, sent as `reasoning_effort` on the OpenAI-compatible chat API.
 *
 * A thinking model writes its reasoning before every step, and on a local model writing is the slow part: qwen3.8 on
 * the Mac Studio writes about 23 tokens a second, so a step that thinks for 1,000 tokens takes 40 seconds. With `low`
 * it wrote about 40% less on the same questions and answered them as well (2026-11-03). `none` turns thinking off.
 * Ollama, DeepSeek and OpenAI all read this field; a provider that does not know a value may refuse the call, which
 * is why it is set per model and never by default.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** A thinking level from text (any case, surrounding spaces ignored), or undefined when it is not one. */
export function reasoningEffortFrom(
  value: unknown,
): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(effort)
    ? (effort as ReasoningEffort)
    : undefined;
}

/**
 * {@link modelFetch} that also sets the thinking level on every chat call. Only a JSON body with `messages` (a chat
 * completion) is changed, and a level the caller already set is kept. Anything else is sent as it is.
 */
export function modelFetchWith(options: {
  reasoningEffort?: ReasoningEffort;
}): typeof fetch {
  const { reasoningEffort } = options;
  if (!reasoningEffort) return modelFetch;
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      modelFetch(input, withReasoningEffort(init, reasoningEffort)),
    { preconnect: fetch.preconnect },
  );
}

function withReasoningEffort(
  init: Parameters<typeof fetch>[1],
  effort: ReasoningEffort,
): Parameters<typeof fetch>[1] {
  if (typeof init?.body !== "string") return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("messages" in body) ||
    "reasoning_effort" in body
  )
    return init;
  return {
    ...init,
    body: JSON.stringify({ ...body, reasoning_effort: effort }),
  };
}
