/**
 * `/api/mailboxes/:agentId`: the IMAP mailbox a person gave one of their Bots.
 *
 * Each person sees and changes only their own mailbox for a Bot, and only for a Bot whose computer
 * they may use (the same check as the Bot's Files page), because the mail lands on that computer.
 * The password goes in and never comes back out.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import { MAIL_FOLDER, type MailboxRunner } from "./runner";
import {
  MailboxInputError,
  type MailboxStore,
  parseMailboxInput,
} from "./store";

export function createMailboxRoutes(input: {
  store: MailboxStore;
  runner: MailboxRunner;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Whether this person may use this Bot's computer. */
  canUseComputer: (actor: AgentActor, agentId: string) => Promise<boolean>;
  trustedOrigins: readonly string[];
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", input.requireUser, bodyLimit({ maxSize: 8_192 }));
  routes.use("/:agentId/*", async (context, next) => {
    if (
      !(await input.canUseComputer(
        context.var.actor,
        context.req.param("agentId"),
      ))
    )
      return context.json({ error: "You can't use this Bot's computer." }, 403);
    await next();
  });
  routes.use("/:agentId", async (context, next) => {
    if (
      !(await input.canUseComputer(
        context.var.actor,
        context.req.param("agentId"),
      ))
    )
      return context.json({ error: "You can't use this Bot's computer." }, 403);
    // A change is only taken from this app's own pages.
    if (
      context.req.method !== "GET" &&
      !sameOrigin(context, input.trustedOrigins)
    )
      return context.json(
        { error: "That request came from another site." },
        403,
      );
    await next();
  });
  routes.onError((error, context) => {
    if (error instanceof MailboxInputError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "mailbox-route-error",
        error: error.name,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Mail settings are unavailable. Try again." },
      503,
    );
  });

  routes.get("/:agentId", async (context) =>
    context.json({
      mailbox: await input.store.get(
        context.var.actor.id,
        context.req.param("agentId"),
      ),
      folder: MAIL_FOLDER,
    }),
  );

  routes.put("/:agentId", async (context) => {
    const body = await context.req.json().catch(() => null);
    const mailbox = await input.store.put(
      context.var.actor.id,
      context.req.param("agentId"),
      parseMailboxInput(body),
    );
    return context.json({ mailbox });
  });

  routes.delete("/:agentId", async (context) => {
    const removed = await input.store.remove(
      context.var.actor.id,
      context.req.param("agentId"),
    );
    return removed
      ? context.body(null, 204)
      : context.json({ error: "There is no mailbox to remove." }, 404);
  });

  /** Check now, and say what came in. Waits for the check: at most about two minutes. */
  routes.post("/:agentId/check", async (context) => {
    if (!sameOrigin(context, input.trustedOrigins))
      return context.json(
        { error: "That request came from another site." },
        403,
      );
    const mailbox = await input.store.runFor(
      context.var.actor.id,
      context.req.param("agentId"),
    );
    if (!mailbox)
      return context.json({ error: "Set up the mailbox first." }, 404);
    const result = await input.runner.check(mailbox);
    return context.json({
      result,
      mailbox: await input.store.get(context.var.actor.id, mailbox.agentId),
    });
  });

  return routes;
}

function sameOrigin(
  context: {
    req: { url: string; header: (name: string) => string | undefined };
  },
  trusted: readonly string[],
): boolean {
  const origin = context.req.header("origin");
  return origin
    ? new Set([new URL(context.req.url).origin, ...trusted]).has(origin)
    : context.req.header("sec-fetch-site") !== "cross-site";
}

/** How long a request to check now is kept open, in seconds (http-server.ts applies it). */
export function mailboxRequestSeconds(pathname: string): number | undefined {
  return /^\/api\/mailboxes\/[^/]+\/check$/.test(pathname) ? 0 : undefined;
}
