/**
 * Admin, Models and Admin, Usage: the providers an admin added, which model each Bot uses, and one row per model call.
 */
import { randomUUID } from "node:crypto";
import {
  isLocalBaseUrl,
  type LlmChoice,
  type LlmModelEntry,
  type LlmProvider,
  type LlmProviderInput,
  type LlmPurpose,
  type LlmSettings,
  type LlmUsageReport,
  type LlmUsageRow,
} from "@openbot/shared/llm";
import { eq, gte, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { llmProviders, llmSettings, llmUsage } from "../db/schema";

export const EMPTY_LLM_SETTINGS: LlmSettings = {
  default: null,
  auxiliary: null,
  bots: {},
};

/** A provider as the server uses it: with its key, decrypted. Never sent to a browser. */
export type LlmProviderSecret = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  models: LlmModelEntry[];
  enabled: boolean;
};

export type LlmUsageEntry = {
  providerId: string | null;
  model: string;
  agentId?: string | null;
  userId?: string | null;
  purpose: LlmPurpose;
  inputTokens: number;
  outputTokens: number;
};

export class LlmProviderInUseError extends Error {
  readonly status = 409;
}

type ProviderRow = typeof llmProviders.$inferSelect;

function publicProvider(row: ProviderRow): LlmProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    hasKey: row.encryptedKey !== null,
    models: row.models,
    enabled: row.enabled,
    local: isLocalBaseUrl(row.baseUrl),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every place a provider is chosen, so one in use cannot be deleted from under a Bot. */
function choicesIn(settings: LlmSettings): LlmChoice[] {
  return [
    ...(settings.default ? [settings.default] : []),
    ...(settings.auxiliary ? [settings.auxiliary] : []),
    ...Object.values(settings.bots),
  ];
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

export function createLlmStore(database: Database, encryptionKey: string) {
  async function readSettings(): Promise<LlmSettings> {
    const [row] = await database
      .select({ settings: llmSettings.settings })
      .from(llmSettings)
      .where(eq(llmSettings.id, "default"))
      .limit(1);
    return row
      ? { ...EMPTY_LLM_SETTINGS, ...row.settings }
      : { ...EMPTY_LLM_SETTINGS };
  }

  return {
    readSettings,

    async writeSettings(settings: LlmSettings): Promise<LlmSettings> {
      await database
        .insert(llmSettings)
        .values({ id: "default", settings })
        .onConflictDoUpdate({
          target: llmSettings.id,
          set: { settings, updatedAt: new Date() },
        });
      return readSettings();
    },

    async listProviders(): Promise<LlmProvider[]> {
      const rows = await database
        .select()
        .from(llmProviders)
        .orderBy(llmProviders.createdAt);
      return rows.map(publicProvider);
    },

    /** Every provider with its key decrypted, for building model calls. */
    async providerSecrets(): Promise<LlmProviderSecret[]> {
      const rows = await database.select().from(llmProviders);
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          baseUrl: row.baseUrl,
          apiKey: row.encryptedKey
            ? await decryptSecret(encryptionKey, row.encryptedKey)
            : null,
          models: row.models,
          enabled: row.enabled,
        })),
      );
    },

    async providerSecret(id: string): Promise<LlmProviderSecret | undefined> {
      const [row] = await database
        .select()
        .from(llmProviders)
        .where(eq(llmProviders.id, id))
        .limit(1);
      if (!row) return undefined;
      return {
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKey: row.encryptedKey
          ? await decryptSecret(encryptionKey, row.encryptedKey)
          : null,
        models: row.models,
        enabled: row.enabled,
      };
    },

    async createProvider(input: LlmProviderInput): Promise<string> {
      const id = randomUUID();
      await database.insert(llmProviders).values({
        id,
        name: input.name,
        baseUrl: input.baseUrl,
        encryptedKey: input.apiKey
          ? await encryptSecret(encryptionKey, input.apiKey)
          : null,
        models: input.models,
        enabled: input.enabled,
      });
      return id;
    },

    /** False when there is no such provider. */
    async updateProvider(
      id: string,
      input: LlmProviderInput,
    ): Promise<boolean> {
      const key =
        input.apiKey === undefined
          ? {}
          : {
              encryptedKey: input.apiKey
                ? await encryptSecret(encryptionKey, input.apiKey)
                : null,
            };
      const updated = await database
        .update(llmProviders)
        .set({
          name: input.name,
          baseUrl: input.baseUrl,
          models: input.models,
          enabled: input.enabled,
          ...key,
          updatedAt: new Date(),
        })
        .where(eq(llmProviders.id, id))
        .returning({ id: llmProviders.id });
      return updated.length > 0;
    },

    async deleteProvider(id: string): Promise<boolean> {
      const settings = await readSettings();
      if (choicesIn(settings).some((choice) => choice.providerId === id))
        throw new LlmProviderInUseError(
          "A model setting uses this provider. Choose another model there first.",
        );
      const deleted = await database
        .delete(llmProviders)
        .where(eq(llmProviders.id, id))
        .returning({ id: llmProviders.id });
      return deleted.length > 0;
    },

    async recordUsage(entry: LlmUsageEntry): Promise<void> {
      await database.insert(llmUsage).values({
        id: randomUUID(),
        providerId: entry.providerId,
        model: entry.model,
        agentId: entry.agentId ?? null,
        userId: entry.userId ?? null,
        purpose: entry.purpose,
        inputTokens: Math.max(0, Math.round(entry.inputTokens)),
        outputTokens: Math.max(0, Math.round(entry.outputTokens)),
      });
    },

    /**
     * Totals for the last `days` days (today included), broken down by day, model, Bot, person and purpose. Costs
     * use the prices on the provider's model entries; a model without both prices makes the cost unknown.
     */
    async usageReport(input: {
      days: number;
      now?: Date;
      labels: {
        bot: (agentId: string) => string;
        person: (userId: string) => string;
        builtInProvider: string;
      };
    }): Promise<LlmUsageReport> {
      const now = input.now ?? new Date();
      const start = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - (input.days - 1),
        ),
      );
      const rows = await database
        .select({
          day: sql<string>`to_char(${llmUsage.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`,
          providerId: llmUsage.providerId,
          model: llmUsage.model,
          agentId: llmUsage.agentId,
          userId: llmUsage.userId,
          purpose: llmUsage.purpose,
          requests: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::int`,
        })
        .from(llmUsage)
        .where(gte(llmUsage.occurredAt, start))
        .groupBy(
          sql`1`,
          llmUsage.providerId,
          llmUsage.model,
          llmUsage.agentId,
          llmUsage.userId,
          llmUsage.purpose,
        );

      const providers = await database.select().from(llmProviders);
      const providerName = new Map(providers.map((row) => [row.id, row.name]));
      const price = new Map<string, LlmModelEntry>();
      for (const provider of providers)
        for (const model of provider.models)
          price.set(`${provider.id}/${model.id}`, model);

      const costOf = (row: (typeof rows)[number]): number | null => {
        const entry = row.providerId
          ? price.get(`${row.providerId}/${row.model}`)
          : undefined;
        if (
          entry?.inputPricePerMillion === undefined ||
          entry.outputPricePerMillion === undefined
        )
          return null;
        return (
          (row.inputTokens * entry.inputPricePerMillion +
            row.outputTokens * entry.outputPricePerMillion) /
          1_000_000
        );
      };

      const empty = (key: string, label: string): LlmUsageRow => ({
        key,
        label,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      });
      const add = (target: LlmUsageRow, row: (typeof rows)[number]) => {
        target.requests += row.requests;
        target.inputTokens += row.inputTokens;
        target.outputTokens += row.outputTokens;
        const cost = costOf(row);
        target.cost =
          target.cost === null || cost === null ? null : target.cost + cost;
      };
      const group = (
        keyOf: (row: (typeof rows)[number]) => string,
        labelOf: (key: string, row: (typeof rows)[number]) => string,
      ) => {
        const groups = new Map<string, LlmUsageRow>();
        for (const row of rows) {
          const key = keyOf(row);
          let target = groups.get(key);
          if (!target) {
            target = empty(key, labelOf(key, row));
            groups.set(key, target);
          }
          add(target, row);
        }
        return [...groups.values()].sort(
          (a, b) =>
            b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
        );
      };

      const totals = empty("total", "Total");
      for (const row of rows) add(totals, row);
      const byDayMap = new Map<string, LlmUsageRow>();
      for (let index = 0; index < input.days; index++) {
        const key = dayKey(
          new Date(start.getTime() + index * 24 * 60 * 60 * 1000),
        );
        byDayMap.set(key, empty(key, key));
      }
      for (const row of rows) {
        const target = byDayMap.get(row.day);
        if (target) add(target, row);
      }

      const { requests, inputTokens, outputTokens, cost } = totals;
      return {
        from: start.toISOString(),
        to: now.toISOString(),
        totals: { requests, inputTokens, outputTokens, cost },
        byDay: [...byDayMap.values()],
        byModel: group(
          (row) => `${row.providerId ?? "built-in"}/${row.model}`,
          (_key, row) =>
            `${row.providerId ? (providerName.get(row.providerId) ?? "Removed provider") : input.labels.builtInProvider} · ${row.model}`,
        ),
        byBot: group(
          (row) => row.agentId ?? "",
          (key) => (key ? input.labels.bot(key) : "No Bot (background)"),
        ),
        byPerson: group(
          (row) => row.userId ?? "",
          (key) => (key ? input.labels.person(key) : "Nobody (background)"),
        ),
        byPurpose: group(
          (row) => row.purpose,
          (key) => key,
        ),
      };
    },
  };
}
export type LlmStore = ReturnType<typeof createLlmStore>;
