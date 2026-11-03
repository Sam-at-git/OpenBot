import { afterEach, expect, test } from "bun:test";
import {
  MODEL_IDLE_TIMEOUT_MS,
  modelFetch,
  modelFetchWith,
  reasoningEffortFrom,
} from "./model-fetch";

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

test("a thinking level is added to chat calls only, and never over one already set", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (_input: unknown, init?: RequestInit) => {
      bodies.push(init?.body);
      return new Response("ok");
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  const send = modelFetchWith({ reasoningEffort: "low" });
  const post = (body: unknown) =>
    send("http://model.test/v1/chat/completions", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  await post({ model: "qwen", messages: [] });
  await post({ model: "qwen", messages: [], reasoning_effort: "high" });
  await post({ model: "qwen", input: [] });
  await post("not json");
  expect(JSON.parse(bodies[0] as string).reasoning_effort).toBe("low");
  expect(JSON.parse(bodies[1] as string).reasoning_effort).toBe("high");
  expect(JSON.parse(bodies[2] as string).reasoning_effort).toBeUndefined();
  expect(bodies[3]).toBe("not json");
  expect(modelFetchWith({})).toBe(modelFetch);
});

test("thinking levels are read from text", () => {
  expect(reasoningEffortFrom(" Low ")).toBe("low");
  expect(reasoningEffortFrom("none")).toBe("none");
  expect(reasoningEffortFrom("lots")).toBeUndefined();
  expect(reasoningEffortFrom(3)).toBeUndefined();
});
