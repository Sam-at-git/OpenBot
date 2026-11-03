/**
 * Which model a call uses, and what it used.
 *
 * WHAT AN ADMIN CHOOSES (Admin, Models). Providers are OpenAI-compatible endpoints with a key and a model list. The
 * default model serves every built-in Bot without its own choice; the auxiliary model serves the background calls
 * (routing, tool selection, approval review, titles, Automatic learning) and falls back to the default. With nothing
 * chosen, OpenBot runs on the model it was started with (BOT_MODEL and OPENAI_BASE_URL), as it always has.
 *
 * WHAT IS COUNTED (Admin, Usage). Every built-in Bot call and every background call records its token counts, never
 * its content. The started-with model is counted too when it is an OpenAI-compatible chat endpoint, by running it
 * through the same model object; an Anthropic or Responses-API start keeps the runtime's own path and is not counted.
 * Bots OpenBot runs in its own containers (agent-bot, LangGraph) are handed the chosen model with each run (see
 * `shared/managed-model.ts`) and call it from there, so they are not counted here.
 */

import type {
  LlmChoice,
  LlmOverview,
  LlmPurpose,
  LlmTestResult,
} from "@openbot/shared/llm";
import type { ManagedModel } from "@openbot/shared/managed-model";
import type { ReasoningEffort } from "@openbot/shared/model-fetch";
import type { LanguageModelForBot } from "../copilot";
import {
  chatModelFor,
  countingUsage,
  type LlmTarget,
  type UsageCount,
  usageCount,
} from "./model";
import type { LlmProviderSecret, LlmStore, LlmUsageEntry } from "./store";

/** Settings and providers are read at most this often; a write through this service refreshes at once. */
const CACHE_MS = 3_000;
const TEST_TIMEOUT_MS = 120_000;
const DISCOVER_TIMEOUT_MS = 15_000;

/** The model this OpenBot was started with, from its environment. */
export type BuiltInModel = {
  provider: string;
  model: string;
  baseUrl: string | null;
  /**
   * Whether the started-with model can be reached as an OpenAI-compatible chat endpoint, and so counted. False for
   * Anthropic and for models that take tools only through the Responses API.
   */
  chatCompatible: boolean;
  resolveApiKey: () => Promise<string | null>;
  /** The started-with model's thinking level (`OPENBOT_REASONING_EFFORT`), if one was set. */
  reasoningEffort?: ReasoningEffort;
};

/** `${base}/chat/completions`, accepting a base URL with or without its trailing slash. */
export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

export function createLlmService(options: {
  store: LlmStore;
  builtIn: BuiltInModel;
  now?: () => number;
}) {
  const { store, builtIn } = options;
  const now = options.now ?? Date.now;
  let cached:
    | {
        at: number;
        value: Promise<{
          settings: Awaited<ReturnType<LlmStore["readSettings"]>>;
          providers: Map<string, LlmProviderSecret>;
        }>;
      }
    | undefined;

  const snapshot = () => {
    if (!cached || now() - cached.at > CACHE_MS) {
      const value = Promise.all([
        store.readSettings(),
        store.providerSecrets(),
      ]).then(([settings, providers]) => ({
        settings,
        providers: new Map(
          providers.map((provider) => [provider.id, provider]),
        ),
      }));
      // A failed read is not kept: the next call asks again.
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
      cached = { at: now(), value };
    }
    return cached.value;
  };
  const invalidate = () => {
    cached = undefined;
  };

  const targetFor = (
    choice: LlmChoice | null | undefined,
    providers: Map<string, LlmProviderSecret>,
  ): LlmTarget | undefined => {
    if (!choice?.model) return undefined;
    const provider = providers.get(choice.providerId);
    if (!provider?.enabled) return undefined;
    const reasoningEffort = provider.models.find(
      (model) => model.id === choice.model,
    )?.reasoningEffort;
    return {
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: choice.model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  };

  /** The started-with model as a target, when it is an OpenAI-compatible chat endpoint. */
  const builtInTarget = async (): Promise<
    (LlmTarget & { builtIn: true }) | undefined
  > => {
    if (!builtIn.chatCompatible) return undefined;
    return {
      builtIn: true,
      providerId: "built-in",
      baseUrl: builtIn.baseUrl ?? "https://api.openai.com/v1",
      apiKey: await builtIn.resolveApiKey(),
      model: builtIn.model,
      ...(builtIn.reasoningEffort
        ? { reasoningEffort: builtIn.reasoningEffort }
        : {}),
    };
  };

  const record = (entry: LlmUsageEntry) => {
    store.recordUsage(entry).catch(() => {
      // Never log the entry: it names people and Bots. The failure kind is enough.
      console.error(JSON.stringify({ type: "llm-usage-record-failed" }));
    });
  };

  const recordFor =
    (
      target: LlmTarget & { builtIn?: true },
      context: { purpose: LlmPurpose; agentId?: string; userId?: string },
    ) =>
    (usage: UsageCount) =>
      record({
        providerId: target.builtIn ? null : target.providerId,
        model: target.model,
        agentId: context.agentId ?? null,
        userId: context.userId ?? null,
        purpose: context.purpose,
        ...usage,
      });

  /** The conversation budget an admin gave this model on its provider, if any. */
  async function historyTokensOf(
    target: LlmTarget & { builtIn?: true },
  ): Promise<number | undefined> {
    if (target.builtIn) return undefined;
    const { providers } = await snapshot();
    return providers
      .get(target.providerId)
      ?.models.find((model) => model.id === target.model)?.historyTokens;
  }

  /** Where a Bot's calls go: its own choice, then the default, then the started-with model. */
  async function botTarget(
    agentId: string,
  ): Promise<(LlmTarget & { builtIn?: true }) | undefined> {
    const { settings, providers } = await snapshot();
    return (
      targetFor(settings.bots[agentId], providers) ??
      targetFor(settings.default, providers) ??
      (await builtInTarget())
    );
  }

  /** Where background calls go: the auxiliary choice, then the default, then the started-with model. */
  async function auxiliaryTarget(): Promise<
    (LlmTarget & { builtIn?: true }) | undefined
  > {
    const { settings, providers } = await snapshot();
    return (
      targetFor(settings.auxiliary, providers) ??
      targetFor(settings.default, providers) ??
      (await builtInTarget())
    );
  }

  /**
   * What a Bot that runs in its own container (agent-bot, agent-langgraph) is told to use: its own choice, then the
   * default. Never the started-with model: with nothing chosen, the container keeps the model it was started with.
   */
  async function managedTarget(
    agentId: string,
  ): Promise<LlmTarget | undefined> {
    const { settings, providers } = await snapshot();
    return (
      targetFor(settings.bots[agentId], providers) ??
      targetFor(settings.default, providers)
    );
  }

  return {
    invalidate,
    botTarget,
    auxiliaryTarget,
    managedTarget,

    /** For the agent resolver: the model to hand a Bot OpenBot runs in its own container, if an admin chose one. */
    async managedModelFor(agentId: string): Promise<ManagedModel | undefined> {
      const target = await managedTarget(agentId).catch(() => undefined);
      if (!target) return undefined;
      const historyTokens = await historyTokensOf(target);
      return {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        ...(historyTokens ? { historyTokens } : {}),
        ...(target.reasoningEffort
          ? { reasoningEffort: target.reasoningEffort }
          : {}),
      };
    },

    /**
     * How much conversation a built-in Bot's model is sent: the conversation budget an admin gave that model under
     * Admin, Models. Undefined (the started-with model, or no budget given) uses the deployment's default.
     */
    async historyTokensFor(agentId: string): Promise<number | undefined> {
      const target = await botTarget(agentId).catch(() => undefined);
      return target ? historyTokensOf(target) : undefined;
    },

    /** For the agent resolver: each built-in Bot's model for this person, counting its usage. */
    languageModelForActor(actorId: string): LanguageModelForBot {
      return async (agentId) => {
        const target = await botTarget(agentId).catch(() => undefined);
        if (!target) return undefined;
        return countingUsage(
          chatModelFor(target),
          recordFor(target, { purpose: "chat", agentId, userId: actorId }),
        );
      };
    },

    /**
     * For `createModelCompleter`: where one background call goes, and how its usage is recorded. Undefined leaves the
     * completer on its own environment settings (an Anthropic start, for example).
     */
    backgroundTarget(purpose: LlmPurpose) {
      return async () => {
        const target = await auxiliaryTarget().catch(() => undefined);
        if (!target) return undefined;
        return { ...target, onUsage: recordFor(target, { purpose }) };
      };
    },

    /**
     * For compacting one Bot's long conversation (local-threads/compaction.ts): that Bot's own model, so a summary of
     * the conversation goes nowhere the conversation itself does not. Usage is recorded as `compaction`.
     */
    compactionTarget(agentId: string) {
      return async () => {
        const target = await botTarget(agentId).catch(() => undefined);
        if (!target) return undefined;
        return {
          ...target,
          onUsage: recordFor(target, { purpose: "compaction", agentId }),
        };
      };
    },

    async overview(): Promise<LlmOverview> {
      return {
        providers: await store.listProviders(),
        settings: await store.readSettings(),
        builtIn: {
          provider: builtIn.provider,
          model: builtIn.model,
          baseUrl: builtIn.baseUrl,
        },
      };
    },

    /** One short call, to check the URL, the key and the model together. */
    async test(providerId: string, model: string): Promise<LlmTestResult> {
      const provider = await store.providerSecret(providerId);
      if (!provider) return { ok: false, error: "No such provider." };
      const started = now();
      let response: Response;
      try {
        response = await fetch(endpoint(provider.baseUrl, "chat/completions"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey || "not-needed"}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with the word OK." }],
          }),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
      } catch {
        return {
          ok: false,
          error: `Couldn't reach ${new URL(provider.baseUrl).host}. Check the base URL and that the service is running.`,
        };
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        const reason =
          response.status === 401 || response.status === 403
            ? "The provider refused the API key."
            : response.status === 402
              ? "The provider says the account has no credit."
              : response.status === 404
                ? "The provider doesn't know this model or URL."
                : response.status === 429
                  ? "The provider is rate limiting or out of quota."
                  : `The provider answered ${response.status}.`;
        return { ok: false, error: detail ? `${reason} ${detail}` : reason };
      }
      const body = (await response.json().catch(() => ({}))) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      record({
        providerId,
        model,
        purpose: "test",
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      });
      const reply = body.choices?.[0]?.message?.content;
      return {
        ok: true,
        latencyMs: now() - started,
        reply:
          typeof reply === "string"
            ? reply
                .replace(/<think>[\s\S]*?<\/think>/g, "")
                .trim()
                .slice(0, 200)
            : "",
      };
    },

    /** The model IDs a provider lists at `/models`. */
    async discover(input: {
      baseUrl: string;
      apiKey?: string;
      providerId?: string;
    }): Promise<string[]> {
      const stored = input.providerId
        ? await store.providerSecret(input.providerId)
        : undefined;
      const key = input.apiKey || stored?.apiKey || "not-needed";
      const response = await fetch(endpoint(input.baseUrl, "models"), {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      });
      if (!response.ok)
        throw new Error(`The provider answered ${response.status}.`);
      const body = (await response.json()) as {
        data?: { id?: unknown }[];
        models?: { name?: unknown }[];
      };
      const ids = [
        ...(body.data ?? []).map((entry) => entry.id),
        ...(body.models ?? []).map((entry) => entry.name),
      ].filter((id): id is string => typeof id === "string" && id !== "");
      return [...new Set(ids)].sort();
    },

    store,
  };
}
export type LlmService = ReturnType<typeof createLlmService>;
export { usageCount };
