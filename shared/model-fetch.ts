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
