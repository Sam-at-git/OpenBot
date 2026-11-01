/**
 * Computer secrets: environment variables an admin gives the commands Bots run on their computers (Admin, Computers),
 * such as an API key a skill's script needs. The model never sees a value: the gateway adds them to one command after
 * the policy decision and the audit row, and the computer masks them in what the command prints (agent-computer
 * shell.ts `maskSecrets`). A value is never sent back to a browser either; only names and scopes are listed.
 */
import { randomUUID } from "node:crypto";
import type { ComputerSecret } from "@openbot/shared/llm";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { computerSecrets } from "../db/schema";

/** Upper-case, like every environment variable a script expects. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Names the computer sets itself or that change how a shell starts; agent-computer refuses them too. */
const REFUSED_NAMES = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "BASH_ENV",
  "ENV",
  "BASH_XTRACEFD",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PS4",
]);
const MAX_VALUE = 16 * 1024;

export function secretNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || !SECRET_NAME.test(name))
    return "A name is upper-case letters, digits and underscores, such as LLAMA_CLOUD_API_KEY.";
  if (
    REFUSED_NAMES.has(name) ||
    name.startsWith("EGRESS_") ||
    name.endsWith("_PROXY")
  )
    return `${name} is set by the computer itself and can't be a secret.`;
  return undefined;
}

export function createComputerSecretStore(
  database: Database,
  encryptionKey: string,
) {
  return {
    async list(): Promise<ComputerSecret[]> {
      const rows = await database
        .select({
          id: computerSecrets.id,
          name: computerSecrets.name,
          scope: computerSecrets.scope,
          updatedAt: computerSecrets.updatedAt,
        })
        .from(computerSecrets)
        .orderBy(computerSecrets.name, computerSecrets.scope);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        agentId: row.scope === "*" ? null : row.scope,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    /** Add a secret, or replace the value of the one with the same name and scope. */
    async put(input: {
      name: string;
      value: string;
      agentId: string | null;
      by: string;
    }): Promise<void> {
      const scope = input.agentId ?? "*";
      const encryptedValue = await encryptSecret(encryptionKey, input.value);
      await database
        .insert(computerSecrets)
        .values({
          id: randomUUID(),
          name: input.name,
          scope,
          encryptedValue,
          createdBy: input.by,
        })
        .onConflictDoUpdate({
          target: [computerSecrets.name, computerSecrets.scope],
          set: { encryptedValue, updatedAt: new Date() },
        });
    },

    async remove(id: string): Promise<boolean> {
      const deleted = await database
        .delete(computerSecrets)
        .where(eq(computerSecrets.id, id))
        .returning({ id: computerSecrets.id });
      return deleted.length > 0;
    },

    /** The variables one Bot's commands get: every Bot's secrets, with this Bot's own values winning. */
    async secretsFor(botId: string): Promise<Record<string, string>> {
      const rows = await database
        .select()
        .from(computerSecrets)
        .where(inArray(computerSecrets.scope, ["*", botId]));
      const env: Record<string, string> = {};
      for (const row of [...rows].sort((a, b) =>
        a.scope === "*" ? -1 : b.scope === "*" ? 1 : 0,
      ))
        env[row.name] = await decryptSecret(encryptionKey, row.encryptedValue);
      return env;
    },

    async exists(name: string, agentId: string | null): Promise<boolean> {
      const [row] = await database
        .select({ id: computerSecrets.id })
        .from(computerSecrets)
        .where(
          and(
            eq(computerSecrets.name, name),
            eq(computerSecrets.scope, agentId ?? "*"),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
export type ComputerSecretStore = ReturnType<typeof createComputerSecretStore>;

/** Admin, Computers: list, add or replace, and remove computer secrets. */
export function createComputerSecretRoutes(input: {
  store: ComputerSecretStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  trustedOrigins: readonly string[];
  audit?: AuditStore;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", input.requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  const sameOrigin = (context: {
    req: { url: string; header: (name: string) => string | undefined };
  }) => {
    const origin = context.req.header("origin");
    return origin
      ? new Set([new URL(context.req.url).origin, ...input.trustedOrigins]).has(
          origin,
        )
      : context.req.header("sec-fetch-site") !== "cross-site";
  };
  const record = async (actorUserId: string, payload: Record<string, unknown>) => {
    if (!input.audit) return;
    // Names and scopes only: a value is never written to the trail.
    await recordAuditEvent(input.audit, {
      eventType: "configuration.changed",
      targetType: "computer",
      actorUserId,
      payload,
    });
  };

  routes.get("/", async (context) =>
    context.json({ secrets: await input.store.list() }),
  );

  routes.put("/", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    if (!sameOrigin(context))
      return context.json({ error: "Use a same-origin request." }, 403);
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const problem = secretNameProblem(body?.name);
    if (problem) return context.json({ error: problem }, 400);
    if (
      typeof body?.value !== "string" ||
      body.value === "" ||
      body.value.length > MAX_VALUE
    )
      return context.json(
        { error: "Enter the secret's value, up to 16 KB." },
        400,
      );
    const agentId =
      typeof body.agentId === "string" && body.agentId ? body.agentId : null;
    if (agentId && agentId.length > 128)
      return context.json({ error: "That isn't a Bot." }, 400);
    const name = body.name as string;
    const replaced = await input.store.exists(name, agentId);
    await input.store.put({
      name,
      value: body.value,
      agentId,
      by: context.var.actor.id,
    });
    await record(context.var.actor.id, {
      change: replaced ? "computer_secret_replaced" : "computer_secret_added",
      name,
      bot: agentId ?? "every Bot",
    });
    return context.json({ secrets: await input.store.list() });
  });

  routes.delete("/:id", async (context) => {
    if (!sameOrigin(context))
      return context.json({ error: "Use a same-origin request." }, 403);
    const id = context.req.param("id");
    if (!(await input.store.remove(id)))
      return context.json({ error: "No such secret." }, 404);
    await record(context.var.actor.id, { change: "computer_secret_removed", id });
    return context.json({ secrets: await input.store.list() });
  });

  return routes;
}
