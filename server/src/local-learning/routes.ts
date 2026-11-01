import {
  isLocalSkillName,
  type LocalLearningSettings,
} from "@openbot/shared/learning";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { LocalLearning } from ".";
import { LocalSkillConflictError } from "./store";

type RouteContext = Context<{ Variables: AppVariables }>;

/** The administrator's settings, checked field by field. */
function parseSettings(
  value: unknown,
): { ok: true; settings: LocalLearningSettings } | { ok: false; error: string } {
  if (!value || typeof value !== "object")
    return { ok: false, error: "Send the Learning settings as an object." };
  const body = value as Record<string, unknown>;
  if (typeof body.enabled !== "boolean")
    return { ok: false, error: "Say whether Learning is on." };
  if (
    typeof body.intervalHours !== "number" ||
    !Number.isInteger(body.intervalHours) ||
    body.intervalHours < 1 ||
    body.intervalHours > 24 * 30
  )
    return {
      ok: false,
      error: "How often is a whole number of hours, from 1 to 720.",
    };
  if (
    !Array.isArray(body.excludedAgents) ||
    body.excludedAgents.some(
      (id) => typeof id !== "string" || !id || id.length > 128,
    )
  )
    return { ok: false, error: "Excluded Bots are a list of Bot IDs." };
  return {
    ok: true,
    settings: {
      enabled: body.enabled,
      intervalHours: body.intervalHours,
      excludedAgents: [...new Set(body.excludedAgents as string[])],
    },
  };
}

function parseSkillEdit(
  value: unknown,
):
  | { ok: true; edit: { name: string; description: string; instructions: string } }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object")
    return { ok: false, error: "Send the Skill as an object." };
  const body = value as Record<string, unknown>;
  if (!isLocalSkillName(body.name))
    return {
      ok: false,
      error:
        "A Skill name is lower-case letters and numbers joined by hyphens, up to 64 characters.",
    };
  if (
    typeof body.description !== "string" ||
    !body.description.trim() ||
    body.description.length > 400
  )
    return {
      ok: false,
      error: "Add a description of up to 400 characters.",
    };
  if (
    typeof body.instructions !== "string" ||
    !body.instructions.trim() ||
    body.instructions.length > 8_000
  )
    return {
      ok: false,
      error: "Add instructions of up to 8,000 characters.",
    };
  return {
    ok: true,
    edit: {
      name: body.name,
      description: body.description.trim(),
      instructions: body.instructions.trim(),
    },
  };
}

/**
 * Admin, Automatic learning, in local mode. Mounted inside `createLearningRoutes`, behind its administrator check, and
 * every write behind its same-origin JSON check.
 */
export function mountLocalLearningRoutes(input: {
  routes: Hono<{ Variables: AppVariables }>;
  local: LocalLearning;
  sameOriginJson: (context: RouteContext) => boolean;
  audit?: AuditStore;
}) {
  const { routes, local, sameOriginJson, audit } = input;
  const refuseCrossSite = (context: RouteContext) =>
    sameOriginJson(context)
      ? undefined
      : context.json(
          { error: "Use a same-origin JSON request to change Learning." },
          403,
        );
  const record = async (
    context: RouteContext,
    payload: Record<string, unknown>,
  ) => {
    if (!audit) return;
    await recordAuditEvent(audit, {
      eventType: "configuration.changed",
      targetType: "learning",
      actorUserId: context.var.actor.id,
      payload: { mode: "local", ...payload },
    });
  };

  routes.get("/local", (context) => context.json({ state: local.state() }));

  routes.put(
    "/local/settings",
    bodyLimit({ maxSize: 32 * 1024 }),
    async (context) => {
      const refused = refuseCrossSite(context);
      if (refused) return refused;
      const parsed = parseSettings(await context.req.json().catch(() => null));
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      local.store.writeSettings(parsed.settings);
      await record(context, {
        enabled: parsed.settings.enabled,
        intervalHours: parsed.settings.intervalHours,
        excludedBotCount: parsed.settings.excludedAgents.length,
      });
      return context.json({ state: local.state() });
    },
  );

  routes.post("/local/run", async (context) => {
    const refused = refuseCrossSite(context);
    if (refused) return refused;
    if (!local.store.settings().enabled)
      return context.json(
        { error: "Turn Learning on before running an analysis." },
        409,
      );
    const { started } = local.runNow();
    if (started) await record(context, { change: "analysis_requested" });
    return context.json({ started, state: local.state() });
  });

  const decision =
    (
      apply: (id: string, by: string) => unknown,
      change: string,
    ) =>
    async (context: RouteContext) => {
      const refused = refuseCrossSite(context);
      if (refused) return refused;
      const id = context.req.param("id") ?? "";
      try {
        const skill = apply(id, context.var.actor.id);
        if (!skill) return context.json({ error: "No such Skill." }, 404);
      } catch (error) {
        if (error instanceof LocalSkillConflictError)
          return context.json({ error: error.message }, 409);
        throw error;
      }
      await record(context, { change, skillId: id });
      return context.json({ state: local.state() });
    };

  routes.post(
    "/local/skills/:id/approve",
    decision((id, by) => local.store.approve(id, by), "skill_approved"),
  );
  routes.post(
    "/local/skills/:id/decline",
    decision(
      (id, by) => local.store.decide(id, "rejected", by),
      "skill_declined",
    ),
  );
  routes.post(
    "/local/skills/:id/retire",
    decision(
      (id, by) => local.store.decide(id, "retired", by),
      "skill_retired",
    ),
  );

  routes.put(
    "/local/skills/:id",
    bodyLimit({ maxSize: 64 * 1024 }),
    async (context) => {
      const refused = refuseCrossSite(context);
      if (refused) return refused;
      const parsed = parseSkillEdit(
        await context.req.json().catch(() => null),
      );
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      const id = context.req.param("id");
      try {
        const skill = local.store.edit(id, parsed.edit);
        if (!skill) return context.json({ error: "No such Skill." }, 404);
      } catch (error) {
        if (error instanceof LocalSkillConflictError)
          return context.json({ error: error.message }, 409);
        throw error;
      }
      await record(context, { change: "skill_edited", skillId: id });
      return context.json({ state: local.state() });
    },
  );
}
