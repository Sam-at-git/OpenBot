import { describe, expect, test } from "bun:test";
import { isLocalBaseUrl, type LlmSettings } from "@openbot/shared/llm";
import type { PlanLanguageModel } from "../src/agents/plan-model";
import { createLlmService, endpoint } from "../src/llm";
import { countingUsage, tokenCount, usageCount } from "../src/llm/model";
import {
  parseModels,
  parseProviderInput,
  parseSettings,
} from "../src/llm/routes";
import type {
  LlmProviderSecret,
  LlmStore,
  LlmUsageEntry,
} from "../src/llm/store";

describe("what an admin sends", () => {
  test("a provider is checked and tidied", () => {
    const parsed = parseProviderInput({
      name: " DeepSeek ",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: " sk-test ",
      enabled: true,
      models: [
        {
          id: "deepseek-chat",
          inputPricePerMillion: 2,
          outputPricePerMillion: 8,
        },
        { id: "deepseek-chat" },
        { id: "deepseek-reasoner", label: "R1" },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        enabled: true,
        models: [
          {
            id: "deepseek-chat",
            inputPricePerMillion: 2,
            outputPricePerMillion: 8,
          },
          { id: "deepseek-reasoner", label: "R1" },
        ],
      },
    });
  });

  test("an absent key keeps the stored one, and bad input is refused", () => {
    const kept = parseProviderInput({
      name: "Ollama",
      baseUrl: "http://host.docker.internal:11434/v1",
      enabled: true,
      models: [],
    });
    expect(kept.ok && "apiKey" in kept.value).toBe(false);
    expect(
      parseProviderInput({
        name: "x",
        baseUrl: "ftp://x",
        enabled: true,
        models: [],
      }).ok,
    ).toBe(false);
    expect(parseModels([{ id: "m", inputPricePerMillion: -1 }]).ok).toBe(false);
    expect(parseModels([{ label: "no id" }]).ok).toBe(false);
  });

  test("settings name a provider and a model, or nothing", () => {
    expect(
      parseSettings({
        default: { providerId: "p1", model: "deepseek-chat" },
        auxiliary: null,
        bots: { knowledge: { providerId: "p2", model: "qwen" }, risk: null },
      }),
    ).toEqual({
      ok: true,
      value: {
        default: { providerId: "p1", model: "deepseek-chat" },
        auxiliary: null,
        bots: { knowledge: { providerId: "p2", model: "qwen" } },
      },
    });
    expect(parseSettings({ default: { providerId: "p1" }, bots: {} }).ok).toBe(
      false,
    );
  });
});

describe("local or not", () => {
  test("this machine and the local network are local", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://host.docker.internal:11434/v1",
      "http://10.0.0.36:11434/v1",
      "http://192.168.1.5/v1",
      "http://172.20.0.2/v1",
      "http://studio.local/v1",
      "http://[::1]:8080/v1",
    ])
      expect(isLocalBaseUrl(url)).toBe(true);
    for (const url of [
      "https://api.openai.com/v1",
      "https://api.deepseek.com/v1",
      "http://172.32.0.1/v1",
      "not a url",
    ])
      expect(isLocalBaseUrl(url)).toBe(false);
  });

  test("endpoints join with one slash", () => {
    expect(endpoint("https://api.deepseek.com/v1/", "models")).toBe(
      "https://api.deepseek.com/v1/models",
    );
  });
});

describe("counting tokens", () => {
  test("both usage shapes are read", () => {
    expect(tokenCount(12)).toBe(12);
    expect(tokenCount({ total: 30, noCache: 10 })).toBe(30);
    expect(tokenCount(undefined)).toBe(0);
    expect(
      usageCount({ inputTokens: { total: 5 }, outputTokens: { total: 7 } }),
    ).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  test("a streamed call reports its usage once it finishes, and passes every part through", async () => {
    const parts = [
      { type: "text-delta", id: "1", delta: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: { total: 11 }, outputTokens: { total: 3 } },
      },
    ];
    const inner = {
      specificationVersion: "v3",
      provider: "fake",
      modelId: "m",
      supportedUrls: {},
      doGenerate: async () => ({
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    } as unknown as PlanLanguageModel;
    const seen: unknown[] = [];
    const counted = countingUsage(inner, (usage) => {
      seen.push(usage);
    });
    const { stream } = await counted.doStream({} as never);
    const out: unknown[] = [];
    for await (const part of stream as unknown as AsyncIterable<unknown>)
      out.push(part);
    expect(out).toEqual(parts);
    await counted.doGenerate({} as never);
    expect(seen).toEqual([
      { inputTokens: 11, outputTokens: 3 },
      { inputTokens: 4, outputTokens: 2 },
    ]);
  });

  test("a recorder that throws never fails the call", async () => {
    const inner = {
      specificationVersion: "v3",
      provider: "fake",
      modelId: "m",
      supportedUrls: {},
      doGenerate: async () => ({ usage: {} }),
    } as unknown as PlanLanguageModel;
    const counted = countingUsage(inner, () => {
      throw new Error("database down");
    });
    expect(await counted.doGenerate({} as never)).toEqual({ usage: {} });
  });
});

describe("which model a call uses", () => {
  const providers: LlmProviderSecret[] = [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk",
      models: [{ id: "deepseek-chat" }],
      enabled: true,
    },
    {
      id: "ollama",
      name: "Ollama",
      baseUrl: "http://host.docker.internal:11434/v1",
      apiKey: null,
      models: [{ id: "qwen" }],
      enabled: true,
    },
    {
      id: "off",
      name: "Off",
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      models: [{ id: "x" }],
      enabled: false,
    },
  ];
  const service = (settings: LlmSettings, chatCompatible = true) => {
    const recorded: LlmUsageEntry[] = [];
    const store = {
      readSettings: async () => settings,
      providerSecrets: async () => providers,
      recordUsage: async (entry: LlmUsageEntry) => {
        recorded.push(entry);
      },
    } as unknown as LlmStore;
    return {
      recorded,
      llm: createLlmService({
        store,
        builtIn: {
          provider: "openai",
          model: "qwen3.8:27b-mlx",
          baseUrl: "http://host.docker.internal:11434/v1",
          chatCompatible,
          resolveApiKey: async () => "ollama",
        },
      }),
    };
  };

  test("a Bot's own choice, then the default, then the started-with model", async () => {
    const { llm } = service({
      default: { providerId: "deepseek", model: "deepseek-chat" },
      auxiliary: null,
      bots: { knowledge: { providerId: "ollama", model: "qwen" } },
    });
    expect((await llm.botTarget("knowledge"))?.model).toBe("qwen");
    expect((await llm.botTarget("general"))?.model).toBe("deepseek-chat");
    const { llm: none } = service({ default: null, auxiliary: null, bots: {} });
    expect(await none.botTarget("general")).toMatchObject({
      builtIn: true,
      model: "qwen3.8:27b-mlx",
      apiKey: "ollama",
    });
  });

  test("a Bot in its own container gets its own choice, then the default, and never the started-with model", async () => {
    const { llm } = service({
      default: { providerId: "deepseek", model: "deepseek-chat" },
      auxiliary: null,
      bots: { "risk-analyst": { providerId: "ollama", model: "qwen" } },
    });
    expect(await llm.managedModelFor("risk-analyst")).toEqual({
      baseUrl: "http://host.docker.internal:11434/v1",
      apiKey: null,
      model: "qwen",
    });
    expect(await llm.managedModelFor("contracts")).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk",
      model: "deepseek-chat",
    });
    const { llm: none } = service({ default: null, auxiliary: null, bots: {} });
    expect(await none.managedModelFor("contracts")).toBeUndefined();
  });

  test("a provider that is off is skipped, and a started-with model that is not chat-compatible is left alone", async () => {
    const { llm } = service(
      {
        default: { providerId: "off", model: "x" },
        auxiliary: null,
        bots: {},
      },
      false,
    );
    expect(await llm.botTarget("general")).toBeUndefined();
    expect(await llm.languageModelForActor("u1")("general")).toBeUndefined();
  });

  test("background calls use the auxiliary model, then the default, and record under their purpose", async () => {
    const { llm, recorded } = service({
      default: { providerId: "deepseek", model: "deepseek-chat" },
      auxiliary: { providerId: "ollama", model: "qwen" },
      bots: {},
    });
    const target = await llm.backgroundTarget("routing")();
    expect(target?.model).toBe("qwen");
    target?.onUsage({ inputTokens: 9, outputTokens: 1 });
    await Bun.sleep(0);
    expect(recorded).toEqual([
      {
        providerId: "ollama",
        model: "qwen",
        agentId: null,
        userId: null,
        purpose: "routing",
        inputTokens: 9,
        outputTokens: 1,
      },
    ]);
  });

  test("a Bot's model is counted for that Bot and that person", async () => {
    const { llm } = service({
      default: { providerId: "deepseek", model: "deepseek-chat" },
      auxiliary: null,
      bots: {},
    });
    const model = await llm.languageModelForActor("u1")("general");
    expect(model?.modelId).toBe("deepseek-chat");
    expect(model?.provider).toContain("openbot-deepseek");
  });
});
