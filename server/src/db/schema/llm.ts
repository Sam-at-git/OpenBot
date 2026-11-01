import type { LlmModelEntry, LlmSettings } from "@openbot/shared/llm";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

/**
 * A model provider an admin added under Admin, Models: one OpenAI-compatible endpoint, its key and the models it
 * offers. The key is encrypted with KEY_ENCRYPTION_KEY, the same way `credentials` keeps one.
 */
export const llmProviders = pgTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  /** `encryptSecret` output, or null for a provider that needs no key (a local Ollama). */
  encryptedKey: text("encrypted_key"),
  models: jsonb("models")
    .$type<LlmModelEntry[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Which model the Bots and the background calls use. One row, id `default`. */
export const llmSettings = pgTable("llm_settings", {
  id: text("id").primaryKey(),
  settings: jsonb("settings").$type<LlmSettings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One model call and the tokens it used, for Admin, Usage. Written after the call, so a row never holds a prompt or
 * an answer: only who, which model, what for, and how much.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: text("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null for the model this OpenBot was started with. */
    providerId: text("provider_id"),
    model: text("model").notNull(),
    agentId: text("agent_id"),
    userId: text("user_id"),
    purpose: text("purpose").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
  },
  (table) => [index("llm_usage_occurred_idx").on(table.occurredAt)],
);

/** An invite to create a password account (OPENBOT_PASSWORD_SIGN_IN=true). Single use. */
export const passwordInvites = pgTable("password_invites", {
  code: text("code").primaryKey(),
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/**
 * A secret an admin gives the Bots' computers as an environment variable (Admin, Computers), such as an API key a
 * skill's script reads. Encrypted with KEY_ENCRYPTION_KEY. `scope` is `*` for every Bot or one Bot's ID; a Bot's own
 * value wins over the one for every Bot. A command gets the values only when it runs (computer/gateway.ts), and the
 * computer masks them in what the command prints.
 */
export const computerSecrets = pgTable(
  "computer_secrets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    scope: text("scope").notNull().default("*"),
    encryptedValue: text("encrypted_value").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("computer_secrets_name_scope_key").on(table.name, table.scope),
  ],
);
