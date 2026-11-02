import { afterEach, expect, test } from "bun:test";
import { MODEL_IDLE_TIMEOUT_MS, modelFetch } from "./model-fetch";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a model call waits fifteen minutes for its first byte, and keeps its own options", async () => {
  let seen: RequestInit | undefined;
  globalThis.fetch = Object.assign(
    async (_input: unknown, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  const controller = new AbortController();
  await modelFetch("http://model.test/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
  });
  expect((seen as { timeout?: number }).timeout).toBe(MODEL_IDLE_TIMEOUT_MS);
  expect(seen?.method).toBe("POST");
  expect(seen?.signal).toBe(controller.signal);
});
