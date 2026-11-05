/**
 * The IMAP mailboxes people give their Bots (`mailboxes`, migration 0072).
 *
 * One per person and Bot. The password is encrypted with the deployment's key on the way in and
 * decrypted only by `credentialsFor`, for the run that fetches mail; nothing here hands it back to
 * a browser (`MailboxView` has no password, only whether one is set).
 */
import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { mailboxes } from "../db/schema";

export type MailboxSecurity = "ssl" | "starttls" | "plain";
export type MailboxStatus = "idle" | "running" | "succeeded" | "error";

type MailboxRow = typeof mailboxes.$inferSelect;

/** A mailbox as its owner sees it: everything but the password. */
export type MailboxView = {
  id: string;
  agentId: string;
  host: string;
  port: number;
  security: MailboxSecurity;
  username: string;
  folder: string;
  enabled: boolean;
  intervalMinutes: number;
  hasPassword: true;
  lastRunAt: string | null;
  lastStatus: MailboxStatus;
  lastError: string | null;
  lastNewCount: number | null;
  nextRunAt: string;
};

/** What a person may set. `password` absent keeps the stored one; a first save needs one. */
export type MailboxInput = {
  host: string;
  port: number;
  security: MailboxSecurity;
  username: string;
  password?: string;
  folder: string;
  enabled: boolean;
  intervalMinutes: number;
};

export class MailboxInputError extends Error {}

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** Checks a body from a browser; throws {@link MailboxInputError} with a sentence a person can act on. */
export function parseMailboxInput(raw: unknown): MailboxInput {
  if (typeof raw !== "object" || raw === null)
    throw new MailboxInputError("Send the mailbox settings as JSON.");
  const body = raw as Record<string, unknown>;
  const text = (key: string) =>
    typeof body[key] === "string" ? (body[key] as string).trim() : "";
  const host = text("host");
  if (!HOST.test(host))
    throw new MailboxInputError(
      "Enter the IMAP server's name, like imap.qq.com.",
    );
  const port = Number(body.port ?? 993);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new MailboxInputError("The port is a number from 1 to 65535.");
  const security = body.security ?? "ssl";
  if (security !== "ssl" && security !== "starttls" && security !== "plain")
    throw new MailboxInputError("Security is SSL, STARTTLS or none.");
  const username = text("username");
  if (!username || username.length > 320)
    throw new MailboxInputError("Enter the mailbox's user name.");
  const password =
    typeof body.password === "string" && body.password !== ""
      ? body.password
      : undefined;
  if (password !== undefined && password.length > 1_024)
    throw new MailboxInputError("That password is too long.");
  const folder = text("folder") || "INBOX";
  if (folder.length > 200 || /[\r\n]/.test(folder))
    throw new MailboxInputError("That folder name can't be used.");
  const intervalMinutes = Number(body.intervalMinutes ?? 15);
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 5 ||
    intervalMinutes > 1_440
  )
    throw new MailboxInputError(
      "Check every 5 minutes at the most, and once a day at the least.",
    );
  return {
    host,
    port,
    security,
    username,
    ...(password !== undefined ? { password } : {}),
    folder,
    enabled: body.enabled !== false,
    intervalMinutes,
  };
}

function view(row: MailboxRow): MailboxView {
  return {
    id: row.id,
    agentId: row.agentId,
    host: row.host,
    port: row.port,
    security: row.security as MailboxSecurity,
    username: row.username,
    folder: row.folder,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    hasPassword: true,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus as MailboxStatus,
    lastError: row.lastError,
    lastNewCount: row.lastNewCount,
    nextRunAt: row.nextRunAt.toISOString(),
  };
}

export type MailboxRun = {
  id: string;
  ownerUserId: string;
  agentId: string;
  host: string;
  port: number;
  security: MailboxSecurity;
  username: string;
  folder: string;
};

function run(row: MailboxRow): MailboxRun {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    host: row.host,
    port: row.port,
    security: row.security as MailboxSecurity,
    username: row.username,
    folder: row.folder,
  };
}

export function createMailboxStore(database: Database, encryptionKey: string) {
  const owned = (owner: string, agentId: string) =>
    and(eq(mailboxes.ownerUserId, owner), eq(mailboxes.agentId, agentId));

  async function row(owner: string, agentId: string) {
    const [found] = await database
      .select()
      .from(mailboxes)
      .where(owned(owner, agentId))
      .limit(1);
    return found ?? null;
  }

  return {
    async get(owner: string, agentId: string): Promise<MailboxView | null> {
      const found = await row(owner, agentId);
      return found ? view(found) : null;
    },

    /** Creates or replaces the person's mailbox for this Bot. The next check is due at once. */
    async put(
      owner: string,
      agentId: string,
      input: MailboxInput,
    ): Promise<MailboxView> {
      const existing = await row(owner, agentId);
      if (!existing && input.password === undefined)
        throw new MailboxInputError("Enter the mailbox's password.");
      const encryptedPassword =
        input.password !== undefined
          ? await encryptSecret(encryptionKey, input.password)
          : (existing?.encryptedPassword ?? "");
      const settings = {
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        encryptedPassword,
        folder: input.folder,
        enabled: input.enabled,
        intervalMinutes: input.intervalMinutes,
        nextRunAt: new Date(),
        updatedAt: new Date(),
      };
      const [saved] = existing
        ? await database
            .update(mailboxes)
            .set({
              ...settings,
              // A changed mailbox starts over: the last result was about the old one.
              ...(existing.host !== input.host ||
              existing.username !== input.username ||
              existing.folder !== input.folder
                ? { lastStatus: "idle", lastError: null, lastNewCount: null }
                : {}),
            })
            .where(eq(mailboxes.id, existing.id))
            .returning()
        : await database
            .insert(mailboxes)
            .values({
              id: randomUUID(),
              ownerUserId: owner,
              agentId,
              ...settings,
            })
            .returning();
      if (!saved) throw new Error("The mailbox could not be saved.");
      return view(saved);
    },

    async remove(owner: string, agentId: string): Promise<boolean> {
      const removed = await database
        .delete(mailboxes)
        .where(owned(owner, agentId))
        .returning({ id: mailboxes.id });
      return removed.length > 0;
    },

    /** The person's own mailbox for this Bot, as a run needs it. */
    async runFor(owner: string, agentId: string): Promise<MailboxRun | null> {
      const found = await row(owner, agentId);
      return found ? run(found) : null;
    },

    /**
     * Take the due mailboxes and move each one's next check forward in the same statement, so two
     * sweeps never take one, and a failing mailbox is still tried only once an interval.
     */
    async claimDue(limit = 5): Promise<MailboxRun[]> {
      const due = await database
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.enabled, true),
            lte(mailboxes.nextRunAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
      const claimed: MailboxRun[] = [];
      for (const { id } of due) {
        const [taken] = await database
          .update(mailboxes)
          .set({
            nextRunAt: sql`now() + make_interval(mins => ${mailboxes.intervalMinutes})`,
            lastStatus: "running",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mailboxes.id, id),
              eq(mailboxes.enabled, true),
              lte(mailboxes.nextRunAt, new Date()),
            ),
          )
          .returning();
        if (taken) claimed.push(run(taken));
      }
      return claimed;
    },

    /** The password, for the one command that fetches this mailbox's mail. */
    async passwordFor(id: string): Promise<string | null> {
      const [found] = await database
        .select({ encryptedPassword: mailboxes.encryptedPassword })
        .from(mailboxes)
        .where(eq(mailboxes.id, id))
        .limit(1);
      return found
        ? decryptSecret(encryptionKey, found.encryptedPassword)
        : null;
    },

    async recordRun(
      id: string,
      result:
        | { status: "succeeded"; newCount: number }
        | { status: "error"; error: string },
    ): Promise<void> {
      await database
        .update(mailboxes)
        .set({
          lastRunAt: new Date(),
          lastStatus: result.status,
          lastError:
            result.status === "error" ? result.error.slice(0, 500) : null,
          lastNewCount: result.status === "succeeded" ? result.newCount : null,
          updatedAt: new Date(),
        })
        .where(eq(mailboxes.id, id));
    },
  };
}

export type MailboxStore = ReturnType<typeof createMailboxStore>;
