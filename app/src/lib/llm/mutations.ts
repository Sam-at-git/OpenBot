import type {
  LlmOverview,
  LlmProviderInput,
  LlmSettings,
} from "@openbot/shared/llm";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { llmKeys } from "./queries";

const FALLBACK = "Couldn't save the model settings. Try again.";

const invalidateLlm = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: llmKeys.all });

const providerPath = (id: string) =>
  `/api/admin/llm/providers/${encodeURIComponent(id)}`;

export function createLlmProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (provider: LlmProviderInput): Promise<LlmOverview> =>
      client("/api/admin/llm/providers", "overview", {
        method: "POST",
        body: { provider },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateLlm(queryClient),
  });
}

/** `provider.apiKey` absent keeps the stored key; an empty string removes it. */
export function updateLlmProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      provider: LlmProviderInput;
    }): Promise<LlmOverview> =>
      client(providerPath(variables.id), "overview", {
        method: "PUT",
        body: { provider: variables.provider },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateLlm(queryClient),
  });
}

/** Refused with the server's sentence while a setting still uses the provider. */
export function deleteLlmProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string): Promise<LlmOverview> =>
      client(providerPath(id), "overview", {
        method: "DELETE",
        fallback: "Couldn't delete this provider. Try again.",
      }),
    onSuccess: () => invalidateLlm(queryClient),
  });
}

/** The default model, the auxiliary model, and each Bot's own model. */
export function saveLlmSettingsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (settings: LlmSettings): Promise<LlmOverview> =>
      client("/api/admin/llm/settings", "overview", {
        method: "PUT",
        body: { settings },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateLlm(queryClient),
  });
}
