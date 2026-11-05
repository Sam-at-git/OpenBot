/**
 * Fetching a mailbox's new mail: `mail-fetch` run on its owner's computer, in the Bot's folder.
 *
 * Run as the person who set the mailbox up, the way every background job here acts as its owner,
 * on the seat their own requests use, so the mail lands in the folder they see on the Bot's Files
 * page (`mail/<folder>/`). The command goes through the gateway like any other: the policy decides
 * it and the audit trail records it, with the password only in the command's environment.
 */
import { DEPLOYMENT_INITIATOR } from "../audit";
import type { ComputerGateway } from "../computer/gateway";
import type { MailboxRun, MailboxStore } from "./store";

/** Where mail lands, inside the Bot's folder. */
export const MAIL_FOLDER = "mail";
/** Long enough for a first run of 50 messages; `mail-fetch` stops itself at 90 s. */
const FETCH_TIMEOUT_MS = 150_000;

/** One argument, quoted for the computer's shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function mailFetchCommand(mailbox: MailboxRun): string {
  return [
    "mail-fetch",
    "--host",
    shellQuote(mailbox.host),
    "--port",
    String(mailbox.port),
    "--security",
    mailbox.security,
    "--user",
    shellQuote(mailbox.username),
    "--folder",
    shellQuote(mailbox.folder),
    "--dest",
    MAIL_FOLDER,
  ].join(" ");
}

export type MailFetchSaved = {
  uid: number;
  dir: string;
  subject: string;
  from: string;
  date: string;
  attachments: number;
};

export type MailFetchResult =
  | { ok: true; newCount: number; remaining: number; saved: MailFetchSaved[] }
  | { ok: false; error: string };

/** What `mail-fetch` printed, read from its last JSON line. */
export function parseMailFetchOutput(output: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}): MailFetchResult {
  if (output.timedOut)
    return { ok: false, error: "Checking the mailbox took too long." };
  const line = output.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  try {
    const parsed = JSON.parse(line ?? "") as Record<string, unknown>;
    if (parsed.ok === true)
      return {
        ok: true,
        newCount: Number(parsed.new ?? 0),
        remaining: Number(parsed.remaining ?? 0),
        saved: Array.isArray(parsed.saved) ? (parsed.saved as MailFetchSaved[]) : [],
      };
    if (typeof parsed.error === "string") return { ok: false, error: parsed.error };
  } catch {
    // Not mail-fetch's answer: say what the computer did say.
  }
  const said = (output.stderr || output.stdout).trim().split("\n").at(-1) ?? "";
  if (/mail-fetch: (command )?not found/.test(said))
    return {
      ok: false,
      error: "This Bot's computer is too old to check mail. Restart it to update it.",
    };
  return {
    ok: false,
    error: said || `The mail check ended with code ${output.exitCode}.`,
  };
}

export type MailboxRunnerDeps = {
  store: MailboxStore;
  gateway: Pick<ComputerGateway, "seatFor" | "runCommand">;
  /** Whether the owner may still use this Bot's computer; false stops the check. */
  mayUseComputer: (ownerUserId: string, agentId: string) => Promise<boolean>;
};

export function createMailboxRunner(deps: MailboxRunnerDeps) {
  async function check(mailbox: MailboxRun): Promise<MailFetchResult> {
    let result: MailFetchResult;
    try {
      if (!(await deps.mayUseComputer(mailbox.ownerUserId, mailbox.agentId))) {
        result = {
          ok: false,
          error: "You can no longer use this Bot's computer, so its mail isn't checked.",
        };
      } else {
        const password = await deps.store.passwordFor(mailbox.id);
        if (!password) return { ok: false, error: "This mailbox was removed." };
        const seat = await deps.gateway.seatFor(mailbox.agentId, mailbox.ownerUserId);
        const output = await deps.gateway.runCommand(
          seat,
          {
            id: mailbox.ownerUserId,
            userId: mailbox.ownerUserId,
            initiator: DEPLOYMENT_INITIATOR,
          },
          {
            command: mailFetchCommand(mailbox),
            timeoutMs: FETCH_TIMEOUT_MS,
            env: { MAIL_PASSWORD: password },
          },
        );
        result = parseMailFetchOutput(output);
      }
    } catch (error) {
      result = {
        ok: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : "The Bot's computer could not be reached.",
      };
    }
    await deps.store.recordRun(
      mailbox.id,
      result.ok
        ? { status: "succeeded", newCount: result.newCount }
        : { status: "error", error: result.error },
    );
    return result;
  }

  return {
    check,
    /** The due mailboxes, one after another, so one person's slow server holds up nobody's computer. */
    async sweep(): Promise<void> {
      for (const mailbox of await deps.store.claimDue()) await check(mailbox);
    },
  };
}

export type MailboxRunner = ReturnType<typeof createMailboxRunner>;
