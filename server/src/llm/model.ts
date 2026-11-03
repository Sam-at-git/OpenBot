/**
 * A model an admin chose, as the language model a built-in Bot runs on, counting the tokens of every call.
 *
 * Every provider is reached through the OpenAI-compatible chat API (`@ai-sdk/openai`'s chat model, the one the
 * runtime itself uses for `openai/...` with COPILOTKIT_OPENAI_API=chat), so OpenAI, DeepSeek, Qwen, Kimi and a local
 * Ollama all work the same way.
 */
import { createOpenAI } from "@ai-sdk/openai";
import {
  modelFetchWith,
  type ReasoningEffort,
} from "@openbot/shared/model-fetch";
import type { PlanLanguageModel } from "../agents/plan-model";

type StreamResult = Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

/** Where a call goes and with what key. */
export type LlmTarget = {
  providerId: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** The thinking level an admin set for this model, sent as `reasoning_effort` on every call. */
  reasoningEffort?: ReasoningEffort;
};

export type UsageCount = { inputTokens: number; outputTokens: number };

/**
 * A token count as the provider SDK reports it: a plain number in the v2 contract, `{ total }` in v3. Missing reads
 * as zero, since a provider that does not report usage still made the call.
 */
export function tokenCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "total" in value &&
    typeof (value as { total: unknown }).total === "number"
  )
    return (value as { total: number }).total;
  return 0;
}

export function usageCount(usage: unknown): UsageCount {
  const record = (usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: tokenCount(record.inputTokens),
    outputTokens: tokenCount(record.outputTokens),
  };
}

/**
 * Wrap a language model so every finished call reports its usage. A failure to record never fails the call: usage
 * is bookkeeping, and the answer is what the person is waiting for.
 */
export function countingUsage(
  inner: PlanLanguageModel,
  record: (usage: UsageCount) => void | Promise<void>,
): PlanLanguageModel {
  const report = (usage: unknown) => {
    try {
      void Promise.resolve(record(usageCount(usage))).catch(() => {});
    } catch {
      // Bookkeeping only.
    }
  };
  return {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options) {
      const result = await inner.doGenerate(options);
      report(result.usage);
      return result;
    },
    async doStream(options) {
      const result = await inner.doStream(options);
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<Part, Part>({
            transform(part, controller) {
              if (part.type === "finish") report(part.usage);
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  } as PlanLanguageModel;
}

/** The chat model for a target. A provider that needs no key (a local Ollama) is sent a placeholder. */
export function chatModelFor(target: LlmTarget): PlanLanguageModel {
  const provider = createOpenAI({
    baseURL: target.baseUrl,
    apiKey: target.apiKey || "not-needed",
    name: `openbot-${target.providerId}`,
    // A local model can be silent for minutes before its first token, and the thinking level goes on every call; see
    // `shared/model-fetch.ts`.
    fetch: modelFetchWith({ reasoningEffort: target.reasoningEffort }),
  });
  return provider.chat(target.model) as unknown as PlanLanguageModel;
}
