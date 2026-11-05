import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createMailboxRoutes } from "../src/mailboxes/routes";
import {
  createMailboxRunner,
  type MailboxRunner,
  mailFetchCommand,
  parseMailFetchOutput,
  shellQuote,
} from "../src/mailboxes/runner";
import {
  MailboxInputError,
  type MailboxRun,
  type MailboxStore,
  parseMailboxInput,
} from "../src/mailboxes/store";

const box: MailboxRun = {
  id: "m1",
  ownerUserId: "alice",
  agentId: "bot-1",
  host: "imap.qq.com",
  port: 993,
  security: "ssl",
  username: "o'neil@qq.com",
  folder: "已发送 $(rm -rf ~)",
};

describe("mailbox settings", () => {
  test("a complete body is accepted, with defaults", () => {
    expect(
      parseMailboxInput({
        host: " imap.163.com ",
        username: "me@163.com",
        password: "code",
      }),
    ).toEqual({
      host: "imap.163.com",
      port: 993,
      security: "ssl",
      username: "me@163.com",
      password: "code",
      folder: "INBOX",
      enabled: true,
      intervalMinutes: 15,
    });
  });

  test("an empty password means keep the saved one", () => {
    expect(
      parseMailboxInput({ host: "imap.qq.com", username: "a", password: "" })
        .password,
    ).toBeUndefined();
  });

  test("bad values are refused with a sentence", () => {
    for (const body of [
      null,
      { host: "imap.qq.com; rm", username: "a" },
      { host: "imap.qq.com", username: "" },
      { host: "imap.qq.com", username: "a", port: 0 },
      { host: "imap.qq.com", username: "a", security: "tls" },
      { host: "imap.qq.com", username: "a", intervalMinutes: 1 },
      { host: "imap.qq.com", username: "a", folder: "a\nb" },
    ])
      expect(() => parseMailboxInput(body)).toThrow(MailboxInputError);
  });
});

describe("the mail-fetch command", () => {
  test("every value a person typed is one quoted argument", () => {
    expect(shellQuote("o'neil")).toBe(`'o'"'"'neil'`);
    const command = mailFetchCommand(box);
    expect(command).toBe(
      `mail-fetch --host 'imap.qq.com' --port 993 --security ssl --user 'o'"'"'neil@qq.com' --folder '已发送 $(rm -rf ~)' --dest mail`,
    );
    // The password is never on the command line.
    expect(command).not.toContain("MAIL_PASSWORD");
  });

  test("its answer is read from the last JSON line", () => {
    expect(
      parseMailFetchOutput({
        stdout: 'noise\n{"ok": true, "new": 2, "remaining": 1, "saved": []}\n',
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    ).toEqual({ ok: true, newCount: 2, remaining: 1, saved: [] });
    expect(
      parseMailFetchOutput({
        stdout: '{"ok": false, "error": "The server refused: login failed"}',
        stderr: "",
        exitCode: 1,
        timedOut: false,
      }),
    ).toEqual({ ok: false, error: "The server refused: login failed" });
  });

  test("an old computer without mail-fetch, and a timeout, say so", () => {
    const missing = parseMailFetchOutput({
      stdout: "",
      stderr: "bash: line 1: mail-fetch: command not found",
      exitCode: 127,
      timedOut: false,
    });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toContain("too old");
    expect(
      parseMailFetchOutput({
        stdout: "",
        stderr: "",
        exitCode: -1,
        timedOut: true,
      }).ok,
    ).toBe(false);
  });
});

describe("running a check", () => {
  function store(recorded: unknown[]): MailboxStore {
    return {
      passwordFor: async () => "secret-code",
      recordRun: async (_id: string, result: unknown) => {
        recorded.push(result);
      },
      claimDue: async () => [box],
    } as unknown as MailboxStore;
  }

  test("runs as the owner on their own seat, with the password only in the environment", async () => {
    const recorded: unknown[] = [];
    const calls: { seat: unknown; actor: unknown; input: unknown }[] = [];
    const runner = createMailboxRunner({
      store: store(recorded),
      mayUseComputer: async () => true,
      gateway: {
        seatFor: async (botId: string, personId: string) =>
          ({ botId, key: { kind: "person", personId } }) as never,
        runCommand: async (seat, actor, input) => {
          calls.push({ seat, actor, input });
          return {
            command: input.command,
            exitCode: 0,
            stdout: '{"ok": true, "new": 3, "remaining": 0, "saved": []}',
            stderr: "",
            truncated: false,
            timedOut: false,
            elapsedMs: 10,
          };
        },
      },
    });
    await runner.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.seat).toEqual({
      botId: "bot-1",
      key: { kind: "person", personId: "alice" },
    });
    expect(calls[0]?.actor).toMatchObject({ id: "alice", userId: "alice" });
    expect(calls[0]?.input).toMatchObject({
      env: { MAIL_PASSWORD: "secret-code" },
    });
    const sent = calls[0]?.input as { command: string } | undefined;
    expect(sent?.command ?? "").not.toContain("secret-code");
    expect(recorded).toEqual([{ status: "succeeded", newCount: 3 }]);
  });

  test("an owner who lost the Bot's computer is not checked, and is told why", async () => {
    const recorded: unknown[] = [];
    let ran = false;
    const runner = createMailboxRunner({
      store: store(recorded),
      mayUseComputer: async () => false,
      gateway: {
        seatFor: async () => ({}) as never,
        runCommand: async () => {
          ran = true;
          throw new Error("not reached");
        },
      },
    });
    const result = await runner.check(box);
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(recorded).toEqual([
      { status: "error", error: expect.stringContaining("no longer") },
    ]);
  });
});

describe("the mailbox routes", () => {
  const alice: AgentActor = { id: "alice", role: "user" } as AgentActor;
  const asAlice: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", alice as never);
    await next();
  };

  function app(canUse: boolean) {
    const saved: unknown[] = [];
    const routes = createMailboxRoutes({
      store: {
        get: async () => null,
        put: async (_owner: string, _agent: string, input: unknown) => {
          saved.push(input);
          return { id: "m1" };
        },
        remove: async () => false,
        runFor: async () => null,
      } as unknown as MailboxStore,
      runner: {} as MailboxRunner,
      requireUser: asAlice,
      canUseComputer: async () => canUse,
      trustedOrigins: [],
    });
    return { routes: new Hono().route("/api/mailboxes", routes), saved };
  }

  test("someone who can't use the Bot's computer can't see or set its mailbox", async () => {
    const { routes, saved } = app(false);
    expect((await routes.request("http://x/api/mailboxes/bot-1")).status).toBe(
      403,
    );
    const put = await routes.request("http://x/api/mailboxes/bot-1", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://x" },
      body: JSON.stringify({
        host: "imap.qq.com",
        username: "a",
        password: "p",
      }),
    });
    expect(put.status).toBe(403);
    expect(saved).toEqual([]);
  });

  test("a change from another site is refused", async () => {
    const { routes, saved } = app(true);
    const put = await routes.request("http://x/api/mailboxes/bot-1", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://evil" },
      body: JSON.stringify({
        host: "imap.qq.com",
        username: "a",
        password: "p",
      }),
    });
    expect(put.status).toBe(403);
    expect(saved).toEqual([]);
  });

  test("a valid change is saved, and a bad one is a 400 with the reason", async () => {
    const { routes, saved } = app(true);
    const ok = await routes.request("http://x/api/mailboxes/bot-1", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://x" },
      body: JSON.stringify({
        host: "imap.qq.com",
        username: "a",
        password: "p",
      }),
    });
    expect(ok.status).toBe(200);
    expect(saved).toHaveLength(1);
    const bad = await routes.request("http://x/api/mailboxes/bot-1", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://x" },
      body: JSON.stringify({ host: "", username: "a" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain(
      "IMAP server",
    );
  });
});
