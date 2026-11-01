import type {
  LlmChoice,
  LlmModelEntry,
  LlmProviderInput,
  LlmSettings,
} from "@openbot/shared/llm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { LlmService } from ".";
import { LlmProviderInUseError } from "./store";

type RouteContext = Context<{ Variables: AppVariables }>;
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_MODELS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function parsePrice(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function parseModels(value: unknown): Parsed<LlmModelEntry[]> {
  if (!Array.isArray(value) || value.length > MAX_MODELS)
    return { ok: false, error: `Models are a list of up to ${MAX_MODELS}.` };
  const models: LlmModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim())
      return { ok: false, error: "Every model needs an ID." };
    const id = item.id.trim();
    if (id.length > 200)
      return { ok: false, error: "A model ID is at most 200 characters." };
    if (seen.has(id)) continue;
    seen.add(id);
    const input = parsePrice(item.inputPricePerMillion);
    const output = parsePrice(item.outputPricePerMillion);
    if (input === null || output === null)
      return { ok: false, error: "A price is a number of zero or more." };
    models.push({
      id,
      ...(typeof item.label === "string" && item.label.trim()
        ? { label: item.label.trim().slice(0, 200) }
        : {}),
      ...(input === undefined ? {} : { inputPricePerMillion: input }),
      ...(output === undefined ? {} : { outputPricePerMillion: output }),
    });
  }
  return { ok: true, value: models };
}

export function parseProviderInput(value: unknown): Parsed<LlmProviderInput> {
  if (!isRecord(value)) return { ok: false, error: "Send the provider." };
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 80
  )
    return { ok: false, error: "Add a name of up to 80 characters." };
  const baseUrl = parseBaseUrl(value.baseUrl);
  if (!baseUrl)
    return {
      ok: false,
      error: "The base URL is an http or https address, such as https://api.deepseek.com/v1.",
    };
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== "string" || value.apiKey.length > 1000)
  )
    return { ok: false, error: "The API key is text." };
  if (typeof value.enabled !== "boolean")
    return { ok: false, error: "Say whether the provider is on." };
  const models = parseModels(value.models);
  if (!models.ok) return models;
  return {
    ok: true,
    value: {
      name: value.name.trim(),
      baseUrl,
      ...(value.apiKey === undefined
        ? {}
        : { apiKey: (value.apiKey as string).trim() }),
      models: models.value,
      enabled: value.enabled,
    },
  };
}

function parseChoice(value: unknown): Parsed<LlmChoice | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    !value.providerId ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.model.length > 200
  )
    return { ok: false, error: "A model choice names a provider and a model." };
  return {
    ok: true,
    value: { providerId: value.providerId, model: value.model.trim() },
  };
}

export function parseSettings(value: unknown): Parsed<LlmSettings> {
  if (!isRecord(value)) return { ok: false, error: "Send the settings." };
  const choice = parseChoice(value.default);
  if (!choice.ok) return choice;
  const auxiliary = parseChoice(value.auxiliary);
  if (!auxiliary.ok) return auxiliary;
  if (!isRecord(value.bots))
    return { ok: false, error: "Bot models are a map of Bot IDs." };
  const bots: Record<string, LlmChoice> = {};
  for (const [agentId, entry] of Object.entries(value.bots)) {
    if (!agentId || agentId.length > 128)
      return { ok: false, error: "A Bot ID is at most 128 characters." };
    const parsed = parseChoice(entry);
    if (!parsed.ok) return parsed;
    if (parsed.value) bots[agentId] = parsed.value;
  }
  return {
    ok: true,
    value: { default: choice.value, auxiliary: auxiliary.value, bots },
  };
}

/** Admin, Models and Admin, Usage. Every route needs an administrator; every write a same-origin JSON request. */
export function createLlmRoutes(input: {
  llm: LlmService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  trustedOrigins: readonly string[];
  audit?: AuditStore;
  labels: () => Promise<{
    bot: (agentId: string) => string;
    person: (userId: string) => string;
  }>;
}) {
  const { llm, audit } = input;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", input.requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.onError((error) => {
    console.error(
      JSON.stringify({ type: "llm-admin-error", errorType: error.name }),
    );
    return Response.json(
      { error: "Couldn't load model settings. Try again." },
      { status: 503 },
    );
  });

  const refuseCrossSite = (context: RouteContext) => {
    const origin = context.req.header("origin");
    const allowed = new Set([
      new URL(context.req.url).origin,
      ...input.trustedOrigins,
    ]);
    const json =
      context.req.header("content-type")?.split(";")[0]?.trim() ===
      "application/json";
    const sameOrigin = origin
      ? allowed.has(origin)
      : context.req.header("sec-fetch-site") !== "cross-site";
    return json && sameOrigin
      ? undefined
      : context.json(
          { error: "Use a same-origin JSON request to change model settings." },
          403,
        );
  };
  const record = async (
    context: RouteContext,
    payload: Record<string, unknown>,
  ) => {
    if (!audit) return;
    await recordAuditEvent(audit, {
      eventType: "configuration.changed",
      targetType: "llm",
      actorUserId: context.var.actor.id,
      payload,
    });
  };
  const body = (context: RouteContext) =>
    context.req.json().catch(() => null) as Promise<Record<
      string,
      unknown
    > | null>;
  const overview = async (context: RouteContext) =>
    context.json({ overview: await llm.overview() });

  routes.get("/", overview);

  routes.post(
    "/providers",
    bodyLimit({ maxSize: 256 * 1024 }),
    async (context) => {
      const refused = refuseCrossSite(context);
      if (refused) return refused;
      const parsed = parseProviderInput((await body(context))?.provider);
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      const id = await llm.store.createProvider(parsed.value);
      llm.invalidate();
      await record(context, {
        change: "provider_added",
        providerId: id,
        host: new URL(parsed.value.baseUrl).host,
      });
      return overview(context);
    },
  );

  routes.put(
    "/providers/:id",
    bodyLimit({ maxSize: 256 * 1024 }),
    async (context) => {
      const refused = refuseCrossSite(context);
      if (refused) return refused;
      const parsed = parseProviderInput((await body(context))?.provider);
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      const id = context.req.param("id");
      if (!(await llm.store.updateProvider(id, parsed.value)))
        return context.json({ error: "No such provider." }, 404);
      llm.invalidate();
      await record(context, {
        change: "provider_changed",
        providerId: id,
        host: new URL(parsed.value.baseUrl).host,
        keyChanged: parsed.value.apiKey !== undefined,
      });
      return overview(context);
    },
  );

  routes.delete("/providers/:id", async (context) => {
    const origin = context.req.header("origin");
    if (
      origin &&
      !new Set([new URL(context.req.url).origin, ...input.trustedOrigins]).has(
        origin,
      )
    )
      return context.json({ error: "Use a same-origin request." }, 403);
    const id = context.req.param("id");
    try {
      if (!(await llm.store.deleteProvider(id)))
        return context.json({ error: "No such provider." }, 404);
    } catch (error) {
      if (error instanceof LlmProviderInUseError)
        return context.json({ error: error.message }, 409);
      throw error;
    }
    llm.invalidate();
    await record(context, { change: "provider_removed", providerId: id });
    return overview(context);
  });

  routes.post("/providers/:id/test", async (context) => {
    const refused = refuseCrossSite(context);
    if (refused) return refused;
    const model = (await body(context))?.model;
    if (typeof model !== "string" || !model.trim())
      return context.json({ error: "Choose a model to test." }, 400);
    return context.json({
      result: await llm.test(context.req.param("id"), model.trim()),
    });
  });

  routes.post("/discover", async (context) => {
    const refused = refuseCrossSite(context);
    if (refused) return refused;
    const request = await body(context);
    const baseUrl = parseBaseUrl(request?.baseUrl);
    if (!baseUrl)
      return context.json({ error: "Enter the base URL first." }, 400);
    try {
      return context.json({
        models: await llm.discover({
          baseUrl,
          ...(typeof request?.apiKey === "string" && request.apiKey
            ? { apiKey: request.apiKey }
            : {}),
          ...(typeof request?.providerId === "string"
            ? { providerId: request.providerId }
            : {}),
        }),
      });
    } catch {
      return context.json(
        {
          error:
            "Couldn't list this provider's models. Check the base URL and the key, or add the models by hand.",
        },
        502,
      );
    }
  });

  routes.put("/settings", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const refused = refuseCrossSite(context);
    if (refused) return refused;
    const parsed = parseSettings((await body(context))?.settings);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const providers = new Set(
      (await llm.store.listProviders()).map((provider) => provider.id),
    );
    const choices = [
      parsed.value.default,
      parsed.value.auxiliary,
      ...Object.values(parsed.value.bots),
    ].filter((choice): choice is LlmChoice => choice !== null);
    if (choices.some((choice) => !providers.has(choice.providerId)))
      return context.json(
        { error: "A model setting names a provider that doesn't exist." },
        400,
      );
    await llm.store.writeSettings(parsed.value);
    llm.invalidate();
    await record(context, {
      change: "models_chosen",
      default: parsed.value.default,
      auxiliary: parsed.value.auxiliary,
      botCount: Object.keys(parsed.value.bots).length,
    });
    return overview(context);
  });

  routes.get("/usage", async (context) => {
    const requested = Number(context.req.query("days") ?? "30");
    const days = [7, 30, 90].includes(requested) ? requested : 30;
    const labels = await input.labels();
    return context.json({
      report: await llm.store.usageReport({
        days,
        labels: { ...labels, builtInProvider: "Built-in" },
      }),
    });
  });

  return routes;
}
