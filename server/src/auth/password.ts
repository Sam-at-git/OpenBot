/**
 * Email and password accounts, by invite only (OPENBOT_PASSWORD_SIGN_IN=true).
 *
 * HOW SOMEBODY GETS IN. An admin makes an invite under Admin, People and sends its link. The link opens
 * /sign-up?invite=<code>, which creates the account here and signs it in. Better Auth keeps the password hash and the
 * sessions in the deployment's own database; its own public sign-up endpoint is refused (auth/index.ts), so an invite
 * is the only way an account is made.
 *
 * THE FIRST ACCOUNT. While no password account exists, a bootstrap invite is kept and printed in the server log. The
 * account made with it becomes an administrator. On a deployment that ran in single-user mode until now, that first
 * account takes over the single user (`dev-local-user`), so every conversation, Bot and setting made before keeps its
 * owner. Signing in, signing out and changing a password are Better Auth's own endpoints under /api/auth.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { MIN_PASSWORD_LENGTH, type PasswordInvite } from "@openbot/shared/llm";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  type Context,
  type Hono,
  Hono as HonoApp,
  type MiddlewareHandler,
} from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { accounts, passwordInvites, users } from "../db/schema";
import { DEV_ACTOR } from "./dev-actor";
import { type AppVariables, requireAdmin } from "./guards";
import type { createAuth } from "./index";
import { setRole } from "./roles";

type Auth = ReturnType<typeof createAuth>;
type RouteContext = Context<{ Variables: AppVariables }>;

export type PasswordRouteDeps = {
  auth: Auth;
  database: Database;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteCode(prefix = "inv"): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Whether any password account exists yet. None means the next sign-up is the first, and becomes an administrator. */
async function hasPasswordAccount(database: Database): Promise<boolean> {
  const [row] = await database
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.providerId, "credential"))
    .limit(1);
  return row !== undefined;
}

/**
 * While nobody has a password account, keep one unused invite and say where it is. Called once at boot. Returns the
 * code, or undefined when accounts already exist.
 */
export async function ensureBootstrapInvite(
  database: Database,
): Promise<string | undefined> {
  if (await hasPasswordAccount(database)) return undefined;
  const [open] = await database
    .select({ code: passwordInvites.code })
    .from(passwordInvites)
    .where(isNull(passwordInvites.usedAt))
    .orderBy(passwordInvites.createdAt)
    .limit(1);
  if (open) return open.code;
  const code = inviteCode("boot");
  await database.insert(passwordInvites).values({ code });
  return code;
}

function inviteFrom(row: {
  code: string;
  createdAt: Date;
  usedAt: Date | null;
  usedByEmail: string | null;
}): PasswordInvite {
  return {
    code: row.code,
    createdAt: row.createdAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    usedByEmail: row.usedByEmail,
  };
}

export function mountPasswordRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: PasswordRouteDeps & {
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
    trustedOrigins: readonly string[];
    audit?: AuditStore;
  },
) {
  const { auth, database, audit } = deps;
  const sameOrigin = (context: RouteContext) => {
    const origin = context.req.header("origin");
    const allowed = new Set([
      new URL(context.req.url).origin,
      ...deps.trustedOrigins,
    ]);
    return origin
      ? allowed.has(origin)
      : context.req.header("sec-fetch-site") !== "cross-site";
  };
  const record = async (
    actorUserId: string | null,
    payload: Record<string, unknown>,
  ) => {
    if (!audit) return;
    await recordAuditEvent(audit, {
      eventType: "configuration.changed",
      targetType: "person",
      ...(actorUserId ? { actorUserId } : {}),
      payload,
    });
  };

  // ---------------------------------------------------------------------------------------------
  // Public: checking an invite and using it.

  const open = new HonoApp<{ Variables: AppVariables }>();

  open.get("/invites/:code", async (context) => {
    const [row] = await database
      .select({ usedAt: passwordInvites.usedAt })
      .from(passwordInvites)
      .where(eq(passwordInvites.code, context.req.param("code")))
      .limit(1);
    return context.json({
      valid: row !== undefined && row.usedAt === null,
      bootstrap: !(await hasPasswordAccount(database)),
    });
  });

  open.post("/sign-up", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    if (!sameOrigin(context))
      return context.json({ error: "Open your invite link in OpenBot." }, 403);
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const invite = typeof body?.invite === "string" ? body.invite : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const email =
      typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!invite)
      return context.json({ error: "Open your invite link again." }, 400);
    if (!name || name.length > 80)
      return context.json({ error: "Add your name, up to 80 characters." }, 400);
    if (!EMAIL.test(email) || email.length > 254)
      return context.json({ error: "Enter a valid email address." }, 400);
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 128)
      return context.json(
        {
          error: `Choose a password of ${MIN_PASSWORD_LENGTH} to 128 characters.`,
        },
        400,
      );

    // Taken first, so two people cannot use one invite at once. Given back if the account is not made.
    const [claimed] = await database
      .update(passwordInvites)
      .set({ usedAt: new Date() })
      .where(
        and(eq(passwordInvites.code, invite), isNull(passwordInvites.usedAt)),
      )
      .returning({ code: passwordInvites.code });
    if (!claimed)
      return context.json(
        {
          error:
            "This invite has been used or doesn't exist. Ask an admin for a new one.",
        },
        403,
      );
    const giveBack = () =>
      database
        .update(passwordInvites)
        .set({ usedAt: null, usedBy: null })
        .where(eq(passwordInvites.code, invite));

    try {
      const [existing] = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const first = !(await hasPasswordAccount(database));
      const [single] = first
        ? await database
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, DEV_ACTOR.id))
            .limit(1)
        : [];
      if (existing && existing.id !== single?.id) {
        await giveBack();
        return context.json(
          { error: "An account with this email already exists. Sign in." },
          409,
        );
      }

      let userId: string;
      let response: Response;
      if (single) {
        // The first account takes over the single user, so everything made before keeps its owner.
        const authContext = await auth.$context;
        const hash = await authContext.password.hash(password);
        await database.transaction(async (transaction) => {
          await transaction
            .update(users)
            .set({ email, name, updatedAt: new Date() })
            .where(eq(users.id, single.id));
          await transaction.insert(accounts).values({
            id: randomUUID(),
            accountId: single.id,
            providerId: "credential",
            issuer: "local:credential",
            userId: single.id,
            password: hash,
          });
        });
        userId = single.id;
        response = await auth.api.signInEmail({
          body: { email, password },
          headers: context.req.raw.headers,
          asResponse: true,
        });
      } else {
        response = await auth.api.signUpEmail({
          body: { email, password, name },
          headers: context.req.raw.headers,
          asResponse: true,
        });
        if (!response.ok) {
          await giveBack();
          const detail = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          return context.json(
            { error: detail?.message ?? "Couldn't create the account." },
            response.status === 422 ? 409 : 400,
          );
        }
        const created = (await response
          .clone()
          .json()
          .catch(() => null)) as { user?: { id?: string } } | null;
        if (!created?.user?.id) throw new Error("sign-up returned no user");
        userId = created.user.id;
      }

      if (first) await setRole(database, userId, "admin");
      await database
        .update(passwordInvites)
        .set({ usedBy: userId })
        .where(eq(passwordInvites.code, invite));
      await record(userId, {
        change: "password_account_created",
        firstAccount: first,
        tookOverSingleUser: Boolean(single),
      });

      const answer = context.json({ ok: true });
      for (const cookie of response.headers.getSetCookie())
        answer.headers.append("set-cookie", cookie);
      return answer;
    } catch (error) {
      await giveBack().catch(() => {});
      console.error(
        JSON.stringify({
          type: "password-sign-up-failed",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
      return context.json(
        { error: "Couldn't create the account. Try again." },
        500,
      );
    }
  });

  app.route("/api/password", open);

  // ---------------------------------------------------------------------------------------------
  // Admin: making and withdrawing invites.

  const admin = new HonoApp<{ Variables: AppVariables }>();
  admin.use("*", deps.requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  admin.get("/", async (context) => {
    const rows = await database
      .select({
        code: passwordInvites.code,
        createdAt: passwordInvites.createdAt,
        usedAt: passwordInvites.usedAt,
        usedByEmail: users.email,
      })
      .from(passwordInvites)
      .leftJoin(users, eq(users.id, passwordInvites.usedBy))
      .orderBy(desc(passwordInvites.createdAt))
      .limit(100);
    return context.json({ invites: rows.map(inviteFrom) });
  });

  admin.post("/", async (context) => {
    if (!sameOrigin(context))
      return context.json({ error: "Use a same-origin request." }, 403);
    const code = inviteCode();
    const [row] = await database
      .insert(passwordInvites)
      .values({ code, createdBy: context.var.actor.id })
      .returning();
    await record(context.var.actor.id, {
      change: "invite_created",
    });
    return context.json({
      invite: inviteFrom({
        code,
        createdAt: row?.createdAt ?? new Date(),
        usedAt: null,
        usedByEmail: null,
      }),
    });
  });

  admin.delete("/:code", async (context) => {
    if (!sameOrigin(context))
      return context.json({ error: "Use a same-origin request." }, 403);
    await database
      .delete(passwordInvites)
      .where(
        and(
          eq(passwordInvites.code, context.req.param("code")),
          isNull(passwordInvites.usedAt),
        ),
      );
    await record(context.var.actor.id, {
      change: "invite_withdrawn",
    });
    return context.json({ ok: true });
  });

  app.route("/api/admin/invites", admin);
}
