import type {
  LlmOverview,
  LlmTestResult,
  LlmUsageReport,
} from "@openbot/shared/llm";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** The ranges Admin, Usage offers. */
export const LLM_USAGE_DAYS = [7, 30, 90] as const;
export type LlmUsageDays = (typeof LLM_USAGE_DAYS)[number];

export const llmKeys = {
  all: ["llm"] as const,
  overview: () => ["llm", "overview"] as const,
  usage: (days: LlmUsageDays) => ["llm", "usage", { days }] as const,
};

/** Admin, Models: every provider, which model each Bot uses, and the model OpenBot was started with. */
export function llmOverviewQueryOptions() {
  return queryOptions({
    queryKey: llmKeys.overview(),
    queryFn: (): Promise<LlmOverview> =>
      client("/api/admin/llm", "overview", {
        fallback: "Couldn't load the model settings. Reload the page.",
      }),
  });
}

/** Admin, Usage: what model calls used over the last `days` days. */
export function llmUsageQueryOptions(days: LlmUsageDays) {
  return queryOptions({
    queryKey: llmKeys.usage(days),
    queryFn: (): Promise<LlmUsageReport> =>
      client(`/api/admin/llm/usage?days=${days}`, "report", {
        fallback: "Couldn't load model usage. Reload the page.",
      }),
  });
}

/**
 * Send one short message to a provider and report what came back.
 *
 * A verdict about this moment, so a plain function: nothing caches it and nothing invalidates it. A provider that
 * refuses is an answer, so a failed request comes back as `{ ok: false }` instead of throwing.
 */
export async function testLlmProvider(
  providerId: string,
  model: string,
): Promise<LlmTestResult> {
  try {
    return await client<LlmTestResult>(
      `/api/admin/llm/providers/${encodeURIComponent(providerId)}/test`,
      "result",
      {
        method: "POST",
        body: { model },
        fallback: "Couldn't test this provider. Try again.",
      },
    );
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Couldn't test this provider. Try again.",
    };
  }
}

export type LlmDiscoverInput = {
  baseUrl: string;
  /** A key the admin just typed. Absent with `providerId` uses the stored key. */
  apiKey?: string;
  providerId?: string;
};

/** Ask a provider which models it offers. Throws with the server's message when it can't say. */
export function discoverLlmModels(input: LlmDiscoverInput): Promise<string[]> {
  return client("/api/admin/llm/discover", "models", {
    method: "POST",
    body: input,
    fallback:
      "Couldn't fetch the provider's models. Check the base URL and API key.",
  });
}
