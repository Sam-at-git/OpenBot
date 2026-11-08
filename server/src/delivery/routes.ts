import { randomInt, randomUUID } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import {
  codeDigest,
  createIMessageTransport,
  IMESSAGE_REALM,
  type IMessageTransport,
  iMessageHandle,
  iMessageIdentity,
  pickIMessageBinding,
} from "./imessage";
import { createOpenTagTransport, type OpenTagTransport } from "./opentag";
import {
  handleOpenTagRun,
  type OpenTagAgentDeps,
  type PairedApprovals,
} from "./opentag-agent";
import { createExpoPushTransport } from "./push";
import type { DeliveryRouter } from "./router";
import type { DeliveryStore } from "./store";
import {
  createTwilioTransport,
  smsOptKeyword,
  type TwilioTransport,
  verifyTwilioRequest,
} from "./twilio";
import {
  DeliveryNotFoundError,
  DeliveryRefusedError,
  type DeliveryScope,
} from "./types";
export type DeliveryScopeResolver = (
  owner: string,
  channelId: string,
  agentId: string,
) => Promise<DeliveryScope | null>;
const targetSchema = z.strictObject({
  channelId: z.string().min(1),
  agentId: z.string().min(1),
});
async function ownedScope(
  resolve: DeliveryScopeResolver,
  owner: string,
  target: { channelId: string; agentId: string },
) {
  const scope = await resolve(owner, target.channelId, target.agentId);
  if (
    !scope ||
    scope.ownerUserId !== owner ||
    scope.channelId !== target.channelId ||
    scope.agentId !== target.agentId
  )
    throw new DeliveryRefusedError(
      "Choose an accessible Bot in your conversation.",
    );
  return scope;
}
function errorRoutes<E extends { Variables: AppVariables }>(routes: Hono<E>) {
  routes.onError((error, context) => {
    if (error instanceof DeliveryNotFoundError)
      return context.json({ error: error.message }, 404);
    if (
      error instanceof DeliveryRefusedError ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    )
      return context.json(
        {
          error:
            error instanceof DeliveryRefusedError
              ? error.message
              : "Supply a valid request.",
        },
        400,
      );
    console.error(
      JSON.stringify({ type: "delivery-route-error", errorType: error.name }),
    );
    return context.json({ error: "Delivery is unavailable. Try again." }, 503);
  });
}
export function createDeliveryRoutes(deps: {
  store: DeliveryStore;
  router: Pick<DeliveryRouter, "receiveNative">;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  scopeFor: DeliveryScopeResolver;
  listConversations(
    owner: string,
    cursor?: string,
  ): Promise<{ channels: unknown[]; nextCursor: string | null }>;
  history(scope: DeliveryScope): Promise<unknown>;
  /** The OpenTag pairing. Named `slack` for the existing assembly; it serves Slack and Teams. */
  slack?: OpenTagTransport;
  twilio?: TwilioTransport;
  /** iMessage through the bridge on a Mac (imessage-bridge/). */
  imessage?: IMessageTransport;
  pushProjectId?: string;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser, bodyLimit({ maxSize: 64 * 1024 }));
  errorRoutes(routes);
  routes.get("/", async (c) =>
    c.json({
      bindings: await deps.store.listBindings(c.var.actor.id),
      devices: (await deps.store.devices(c.var.actor.id)).map(
        ({ token: _token, ...device }) => device,
      ),
      deliveries: await deps.store.history(c.var.actor.id),
      available: {
        slack: Boolean(deps.slack),
        teams: Boolean(deps.slack),
        sms: Boolean(deps.twilio),
        imessage: Boolean(deps.imessage),
        push: Boolean(deps.pushProjectId),
      },
    }),
  );
  routes.delete("/bindings/:id", async (c) => {
    await deps.store.removeBinding(c.var.actor.id, c.req.param("id"));
    return c.body(null, 204);
  });
  /**
   * Link a Slack or Teams identity through OpenTag. The one-time code is the challenge id; the person
   * sends `link <code>` to the OpenTag app, and OpenTag's authenticated sender becomes the binding.
   * `/slack/start` is kept as the Slack spelling of the same call.
   */
  const startChatLink = async (
    c: Context<{ Variables: AppVariables }>,
    fixed?: "slack" | "teams",
  ) => {
    if (!deps.slack)
      throw new DeliveryRefusedError(
        "Slack and Teams are not paired with OpenTag on this deployment.",
      );
    const input = targetSchema
      .extend({ platform: z.enum(["slack", "teams"]).optional() })
      .parse(await c.req.json());
    const platform = fixed ?? input.platform ?? "slack";
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, input);
    const code = await deps.store.challenge(scope, platform, null);
    return c.json({
      platform,
      code,
      command: `link ${code}`,
      expiresInMinutes: 10,
    });
  };
  routes.post("/opentag/start", (c) => startChatLink(c));
  routes.post("/slack/start", (c) => startChatLink(c, "slack"));
  routes.post("/teams/start", (c) => startChatLink(c, "teams"));
  routes.post("/sms/start", async (c) => {
    if (!deps.twilio)
      throw new DeliveryRefusedError(
        "SMS is not configured on this deployment.",
      );
    const target = targetSchema
      .extend({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/) })
      .parse(await c.req.json());
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, target);
    await deps.twilio.startVerification(target.phone);
    return c.json({
      challengeId: await deps.store.challenge(scope, "sms", target.phone),
    });
  });
  routes.post("/sms/confirm", async (c) => {
    if (!deps.twilio)
      throw new DeliveryRefusedError(
        "SMS is not configured on this deployment.",
      );
    const input = z
      .strictObject({
        challengeId: z.string().uuid(),
        code: z.string().regex(/^\d{4,10}$/),
      })
      .parse(await c.req.json());
    const challenge = await deps.store.readChallenge(
      input.challengeId,
      c.var.actor.id,
    );
    if (challenge?.transport !== "sms" || !challenge.address)
      throw new DeliveryRefusedError(
        "This phone verification expired or was already used.",
      );
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, challenge);
    if (scope.threadId !== challenge.threadId)
      throw new DeliveryRefusedError(
        "The conversation changed. Start verification again.",
      );
    if (!(await deps.twilio.checkVerification(challenge.address, input.code)))
      throw new DeliveryRefusedError("The verification code was not approved.");
    if (!(await deps.store.consumeChallenge(challenge.id, c.var.actor.id)))
      throw new DeliveryRefusedError(
        "This phone verification was already used.",
      );
    return c.json(
      {
        binding: await deps.store.bind({
          ...scope,
          transport: "sms",
          identity: challenge.address,
          realm: deps.twilio.config.accountSid,
          address: challenge.address,
        }),
      },
      201,
    );
  });
  /*
   * iMessage: OpenBot sends a code to the phone through the bridge, and the person types it back
   * here. The code is kept only as a digest, in this process, for ten minutes and five tries: a
   * restart asks for a new code, which costs one more message.
   */
  const iMessageCodes = new Map<
    string,
    { digest: string; expires: number; tries: number }
  >();
  routes.post("/imessage/start", async (c) => {
    if (!deps.imessage)
      throw new DeliveryRefusedError(
        "iMessage is not configured on this deployment.",
      );
    const target = targetSchema
      .extend({ phone: z.string().min(3).max(320) })
      .parse(await c.req.json());
    const handle = iMessageHandle(target.phone);
    if (!handle)
      throw new DeliveryRefusedError(
        "Enter a phone number with its country code, like +8613500000000, or an email address.",
      );
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, target);
    const challengeId = await deps.store.challenge(scope, "imessage", handle);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    for (const [id, held] of iMessageCodes)
      if (held.expires < Date.now()) iMessageCodes.delete(id);
    iMessageCodes.set(challengeId, {
      digest: codeDigest(challengeId, code),
      expires: Date.now() + 10 * 60_000,
      tries: 0,
    });
    try {
      await deps.imessage.send({
        id: challengeId,
        address: handle,
        text: `OpenBot code: ${code}. It expires in 10 minutes.`,
      });
    } catch {
      iMessageCodes.delete(challengeId);
      throw new DeliveryRefusedError(
        "The code could not be sent by iMessage. Check the number, and that it is on the bridge's allowed list.",
      );
    }
    return c.json({ challengeId });
  });
  routes.post("/imessage/confirm", async (c) => {
    if (!deps.imessage)
      throw new DeliveryRefusedError(
        "iMessage is not configured on this deployment.",
      );
    const input = z
      .strictObject({
        challengeId: z.string().uuid(),
        code: z.string().regex(/^\d{4,10}$/),
      })
      .parse(await c.req.json());
    const challenge = await deps.store.readChallenge(
      input.challengeId,
      c.var.actor.id,
    );
    const held = iMessageCodes.get(input.challengeId);
    if (
      challenge?.transport !== "imessage" ||
      !challenge.address ||
      !held ||
      held.expires < Date.now()
    )
      throw new DeliveryRefusedError(
        "This code expired or was already used. Send a new one.",
      );
    held.tries += 1;
    if (held.tries > 5) {
      iMessageCodes.delete(input.challengeId);
      throw new DeliveryRefusedError("Too many tries. Send a new code.");
    }
    if (held.digest !== codeDigest(input.challengeId, input.code))
      throw new DeliveryRefusedError("That code is not right.");
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, challenge);
    if (scope.threadId !== challenge.threadId)
      throw new DeliveryRefusedError(
        "The conversation changed. Send a new code.",
      );
    if (!(await deps.store.consumeChallenge(challenge.id, c.var.actor.id)))
      throw new DeliveryRefusedError("This code was already used.");
    iMessageCodes.delete(input.challengeId);
    return c.json(
      {
        binding: await deps.store.bind({
          ...scope,
          transport: "imessage",
          identity: iMessageIdentity(challenge.address, scope.agentId),
          realm: IMESSAGE_REALM,
          address: challenge.address,
        }),
      },
      201,
    );
  });
  routes.post("/devices", async (c) => {
    if (!deps.pushProjectId)
      throw new DeliveryRefusedError(
        "Native push is not configured on this deployment.",
      );
    const input = z
      .strictObject({
        id: z.string().uuid(),
        token: z.string().regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/),
        projectId: z.string().uuid(),
        platform: z.enum(["ios", "android"]),
      })
      .parse(await c.req.json());
    if (input.projectId !== deps.pushProjectId)
      throw new DeliveryRefusedError(
        "This device belongs to another push project.",
      );
    const device = await deps.store.registerDevice({
      ...input,
      ownerUserId: c.var.actor.id,
    });
    return c.json(
      { device: { id: device?.id, enabled: device?.enabled } },
      201,
    );
  });
  routes.delete("/devices/:id", async (c) => {
    await deps.store.removeDevice(c.var.actor.id, c.req.param("id"));
    return c.body(null, 204);
  });
  routes.get("/conversations", async (c) => {
    const page = await deps.listConversations(
      c.var.actor.id,
      c.req.query("cursor"),
    );
    return c.json({
      conversations: page.channels,
      nextCursor: page.nextCursor,
    });
  });
  routes.get("/conversations/:id/history", async (c) => {
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, {
      channelId: c.req.param("id"),
      agentId: z.string().min(1).parse(c.req.query("agentId")),
    });
    return c.json({ history: await deps.history(scope) });
  });
  routes.post("/conversations/:id/messages", async (c) => {
    const input = z
      .strictObject({
        agentId: z.string().min(1),
        text: z.string().trim().min(1).max(16_000),
        externalId: z.string().uuid().default(randomUUID),
      })
      .parse(await c.req.json());
    const scope = await ownedScope(deps.scopeFor, c.var.actor.id, {
      channelId: c.req.param("id"),
      agentId: input.agentId,
    });
    return c.json(
      await deps.router.receiveNative(scope, input.text, input.externalId),
      202,
    );
  });
  return routes;
}
export function createDeliveryWebhookRoutes(deps: {
  router: Pick<DeliveryRouter, "receive" | "converse" | "notify" | "smsOptOut">;
  store: Pick<
    DeliveryStore,
    | "readChallenge"
    | "consumeChallenge"
    | "bind"
    | "updateSmsStatus"
    | "findBinding"
    | "botIdentity"
    | "bindingsAt"
    | "lastWrittenBinding"
  >;
  scopeFor: DeliveryScopeResolver;
  /** The OpenTag pairing. Named `slack` for the existing assembly; it serves Slack and Teams. */
  slack?: OpenTagTransport;
  twilio?: TwilioTransport;
  /** iMessage through the bridge on a Mac (imessage-bridge/). */
  imessage?: IMessageTransport;
  /** Lets a Slack/Teams card decide an approval and a chat reply answer a Bot's question. */
  approvals?: PairedApprovals;
  /** Test seam; production uses the responsibilities lane's `ingestSlackEvent`. */
  ingestSlack?: OpenTagAgentDeps["ingestSlack"];
  /** Redeems OpenBot linked-account codes sent to the Slack app in a DM; cancels one posted in a channel. */
  identity?: OpenTagAgentDeps["identity"];
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  // A paired chat run carries its conversation's history, so it gets a larger envelope.
  const provider = bodyLimit({ maxSize: 256 * 1024 });
  const agentRun = bodyLimit({ maxSize: 4 * 1024 * 1024 });
  routes.use("*", (c, next) =>
    c.req.path.endsWith("/opentag/agent")
      ? agentRun(c, next)
      : provider(c, next),
  );
  errorRoutes(routes);
  if (deps.slack) {
    const opentag = deps.slack;
    routes.post("/opentag/agent", (c) =>
      handleOpenTagRun(
        {
          opentag,
          router: deps.router,
          store: deps.store,
          scopeFor: deps.scopeFor,
          ...(deps.approvals ? { approvals: deps.approvals } : {}),
          ...(deps.ingestSlack ? { ingestSlack: deps.ingestSlack } : {}),
          ...(deps.identity ? { identity: deps.identity } : {}),
        },
        c.req.raw,
      ),
    );
  }
  if (deps.imessage) {
    const imessage = deps.imessage;
    /*
     * A message from the phone, posted by the bridge. The bridge only forwards the handles it allows,
     * and this only takes it with the bridge's token. It goes to the Bot it names, or to the one
     * that wrote last (`pickIMessageBinding`).
     */
    routes.post("/imessage", async (c) => {
      if (!imessage.verifyInbound(c.req.header("authorization")))
        return c.json({ error: "Invalid bridge token." }, 401);
      const input = z
        .object({
          id: z.string().min(1).max(200),
          handle: z.string().min(3).max(320),
          text: z.string().min(1).max(8_000),
        })
        .parse(await c.req.json());
      const handle = iMessageHandle(input.handle);
      if (!handle) return c.json({ queued: false, reason: "unknown" });
      const bindings = await deps.store.bindingsAt(
        "imessage",
        IMESSAGE_REALM,
        handle,
      );
      if (bindings.length === 0)
        return c.json({ queued: false, reason: "unbound" });
      const names = new Map<string, string>();
      for (const binding of bindings) {
        const bot = await deps.store.botIdentity(binding.agentId);
        if (bot?.name) names.set(binding.agentId, bot.name);
      }
      const picked = pickIMessageBinding(
        bindings,
        input.text,
        (agentId) => names.get(agentId),
        await deps.store.lastWrittenBinding(bindings.map((b) => b.id)),
      );
      if (!picked.binding) return c.json({ queued: false, reason: "unbound" });
      return c.json(
        await deps.router.receive({
          source: "imessage",
          realm: IMESSAGE_REALM,
          identity: picked.binding.identity,
          address: handle,
          externalId: input.id,
          text: picked.text,
          bindingId: picked.binding.id,
        }),
      );
    });
  }
  if (deps.twilio) {
    const twilio = deps.twilio;
    async function signed(request: Request, url: string) {
      if (
        !request.headers
          .get("content-type")
          ?.startsWith("application/x-www-form-urlencoded")
      )
        throw new DeliveryRefusedError("Twilio must send form data.");
      const params = new URLSearchParams(await request.text());
      return verifyTwilioRequest({
        url,
        params,
        token: twilio.config.authToken,
        signature: request.headers.get("x-twilio-signature"),
      })
        ? params
        : null;
    }
    routes.post("/sms", async (c) => {
      const params = await signed(c.req.raw, twilio.config.webhookUrl);
      if (!params) return c.json({ error: "Invalid Twilio signature." }, 401);
      if (
        params.get("AccountSid") !== twilio.config.accountSid ||
        params.get("To") !== twilio.config.from
      )
        return c.json({ error: "Unrecognised Twilio destination." }, 403);
      const from = params.get("From"),
        id = params.get("MessageSid"),
        text = params.get("Body");
      // Twilio answers these keywords itself and blocks sends after STOP, so OpenBot records the
      // state, runs no turn and sends no second reply (Advanced Opt-Out guidance).
      const keyword = smsOptKeyword(params.get("OptOutType"), text);
      if (from && keyword) {
        if (keyword !== "HELP")
          await deps.router.smsOptOut(
            twilio.config.accountSid,
            from,
            keyword === "STOP",
          );
        return c.body("<Response/>", 200, { "content-type": "text/xml" });
      }
      if (from && id && text)
        await deps.router.receive({
          source: "sms",
          realm: twilio.config.accountSid,
          identity: from,
          externalId: id,
          text,
        });
      return c.body("<Response/>", 200, { "content-type": "text/xml" });
    });
    if (twilio.config.statusUrl)
      routes.post("/sms/status", async (c) => {
        const params = await signed(c.req.raw, twilio.config.statusUrl ?? "");
        if (!params) return c.json({ error: "Invalid Twilio signature." }, 401);
        if (params.get("AccountSid") !== twilio.config.accountSid)
          return c.json({ error: "Unrecognised account." }, 403);
        const id = params.get("MessageSid"),
          status = params.get("MessageStatus");
        if (
          id &&
          (status === "delivered" ||
            status === "sent" ||
            status === "failed" ||
            status === "undelivered")
        )
          await deps.store.updateSmsStatus(
            id,
            status === "undelivered" ? "failed" : status,
            params.get("ErrorCode"),
          );
        return c.body(null, 204);
      });
  }
  return routes;
}

/** Deployment secrets come from its environment/vault injection; never return this object to UI. */
export function configuredDeliveryProviders(
  publicBaseUrl: string,
  env: Record<string, string | undefined> = process.env,
) {
  // Provider signatures (Twilio) are computed over the URL the provider was given, which is the
  // public webhook base (a tunnel or ingress), not necessarily the sign-in origin.
  const webhookBase = env.DELIVERY_PUBLIC_URL?.trim() || publicBaseUrl;
  if (!/^https?:\/\//.test(webhookBase))
    throw new Error("DELIVERY_PUBLIC_URL must be an http(s) URL.");
  const base = new URL(webhookBase).origin;
  function configured(names: string[]) {
    if (!names.some((name) => env[name]?.trim())) return null;
    const missing = names.filter((name) => !env[name]?.trim());
    if (missing.length)
      throw new Error(
        `Delivery configuration is incomplete: ${missing.join(", ")}.`,
      );
    return names.map((name) => env[name]?.trim() ?? "");
  }
  const legacySlack = [
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_BOT_TOKEN",
    "SLACK_TEAM_ID",
    "SLACK_SIGNING_SECRET",
  ].filter((name) => env[name]?.trim());
  if (legacySlack.length)
    throw new Error(
      `Direct Slack delivery was replaced by the OpenTag pairing. Unset ${legacySlack.join(", ")} and set OPENTAG_SHARED_SECRET (and OPENTAG_URL for proactive messages).`,
    );
  const opentagSecret = env.OPENTAG_SHARED_SECRET?.trim();
  const opentagUrl = env.OPENTAG_URL?.trim();
  const opentagIcon = env.OPENTAG_BOT_ICON_URL_TEMPLATE?.trim();
  if ((opentagUrl || opentagIcon) && !opentagSecret)
    throw new Error(
      "Delivery configuration is incomplete: OPENTAG_SHARED_SECRET.",
    );
  if (opentagSecret && opentagSecret.length < 32)
    throw new Error("OPENTAG_SHARED_SECRET must be at least 32 characters.");
  if (opentagUrl && !/^https?:\/\//.test(opentagUrl))
    throw new Error("OPENTAG_URL must be an http(s) URL.");
  if (opentagIcon && !opentagIcon.startsWith("https://"))
    throw new Error("OPENTAG_BOT_ICON_URL_TEMPLATE must be an https URL.");
  const opentag = opentagSecret
    ? createOpenTagTransport({
        secret: opentagSecret,
        ...(opentagUrl ? { url: opentagUrl } : {}),
        ...(opentagIcon ? { iconUrlTemplate: opentagIcon } : {}),
      })
    : undefined;
  const smsValues = configured([
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_VERIFY_SERVICE_SID",
    "TWILIO_FROM_NUMBER",
  ]);
  const imessageValues = configured([
    "IMESSAGE_BRIDGE_URL",
    "IMESSAGE_BRIDGE_TOKEN",
  ]);
  if (imessageValues && !/^https?:\/\//.test(imessageValues[0] ?? ""))
    throw new Error("IMESSAGE_BRIDGE_URL must be an http(s) URL.");
  if (imessageValues && (imessageValues[1] ?? "").length < 32)
    throw new Error("IMESSAGE_BRIDGE_TOKEN must be at least 32 characters.");
  const pushProjectId = env.EXPO_PROJECT_ID?.trim();
  if (pushProjectId && !z.uuid().safeParse(pushProjectId).success)
    throw new Error(
      "EXPO_PROJECT_ID must be the native app's EAS project UUID.",
    );
  return {
    // Slack and Teams share the OpenTag pairing: inbound turns, cards and proactive delivery.
    slack: opentag,
    teams: opentag,
    sms: smsValues
      ? createTwilioTransport({
          accountSid: smsValues[0] ?? "",
          authToken: smsValues[1] ?? "",
          verifyServiceSid: smsValues[2] ?? "",
          from: smsValues[3] ?? "",
          webhookUrl: `${base}/api/delivery/webhooks/sms`,
          statusUrl: `${base}/api/delivery/webhooks/sms/status`,
        })
      : undefined,
    imessage: imessageValues
      ? createIMessageTransport({
          url: imessageValues[0] ?? "",
          token: imessageValues[1] ?? "",
        })
      : undefined,
    push: pushProjectId
      ? createExpoPushTransport({
          projectId: pushProjectId,
          accessToken: env.EXPO_ACCESS_TOKEN,
        })
      : undefined,
    pushProjectId,
  };
}
