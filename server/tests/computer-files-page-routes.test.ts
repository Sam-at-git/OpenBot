import { describe, expect, test } from "bun:test";
import { MAX_COMPUTER_FILE_BYTES } from "@openbot/shared/attachments";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { personSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import { ActionRefusedError } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The Files page's routes: listing one folder, uploading, deleting and making a folder. Each one is a
 * gateway call, so the policy and the audit row decide it; these tests pin that the route reaches the
 * gateway with what the person sent, and refuses what is malformed before it gets there.
 */

const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

function asActor(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", member);
    await next();
  };
}

type Call = { method: string; botId: string; actorId: string; input: unknown };

function recordingGateway(refuse = false) {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (
      seat: { botId: string },
      actor: { id: string },
      input: Record<string, unknown>,
    ) => {
      calls.push({ method, botId: seat.botId, actorId: actor.id, input });
      if (refuse) throw new ActionRefusedError("No file writes.", "rule-1");
      return { path: input.path, entries: [], truncated: false };
    };
  const gateway = {
    seatFor: async (botId: string, personId: string) =>
      personSeat(personId, botId),
    listFiles: record("listFiles"),
    uploadFile: record("uploadFile"),
    deleteFile: record("deleteFile"),
    makeFolder: record("makeFolder"),
  } as unknown as ComputerGateway;
  return { gateway, calls };
}

function appFor(gateway: ComputerGateway, canUseBot = async () => true) {
  return createComputerRoutes(gateway, {} as PolicyStore, asActor(), canUseBot);
}

function post(path: string, body: unknown) {
  return new Request(`http://openbot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the Files page routes", () => {
  test("a person's listing asks for one folder", async () => {
    const { gateway, calls } = recordingGateway();
    const response = await appFor(gateway).request(
      post("/bot-1/files/list", { path: " reports ", recursive: false }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        method: "listFiles",
        botId: "bot-1",
        actorId: "user-1",
        input: { path: "reports", recursive: false },
      },
    ]);
  });

  test("an upload reaches the gateway as the bytes that were sent", async () => {
    const { gateway, calls } = recordingGateway();
    const bytes = Uint8Array.from([0, 1, 2, 250]);
    const response = await appFor(gateway).request(
      post("/bot-1/files/upload", {
        path: "ims-manual/04.md",
        base64: Buffer.from(bytes).toString("base64"),
      }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("uploadFile");
    const input = calls[0]?.input as { path: string; bytes: Uint8Array };
    expect(input.path).toBe("ims-manual/04.md");
    expect([...input.bytes]).toEqual([...bytes]);
  });

  test("an upload over the limit is refused before the gateway", async () => {
    const { gateway, calls } = recordingGateway();
    const response = await appFor(gateway).request(
      post("/bot-1/files/upload", {
        path: "big.bin",
        base64: Buffer.alloc(MAX_COMPUTER_FILE_BYTES + 1).toString("base64"),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("A file can be at most 25 MB.");
    expect(calls).toEqual([]);
  });

  test("delete and new folder pass the path through", async () => {
    const { gateway, calls } = recordingGateway();
    const app = appFor(gateway);
    expect(
      (await app.request(post("/bot-1/files/delete", { path: "old.txt" })))
        .status,
    ).toBe(200);
    expect(
      (await app.request(post("/bot-1/files/folder", { path: " ims-manual " })))
        .status,
    ).toBe(200);
    expect(calls.map((call) => [call.method, call.input])).toEqual([
      ["deleteFile", { path: "old.txt" }],
      ["makeFolder", { path: "ims-manual" }],
    ]);
  });

  test("a request with no path is refused before the gateway", async () => {
    const { gateway, calls } = recordingGateway();
    const app = appFor(gateway);
    for (const route of ["upload", "delete", "folder"]) {
      const response = await app.request(
        post(`/bot-1/files/${route}`, { path: "  ", base64: "" }),
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("a policy refusal comes back as 403 with the rule", async () => {
    const { gateway } = recordingGateway(true);
    const response = await appFor(gateway).request(
      post("/bot-1/files/delete", { path: "notes.txt" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ rule: "rule-1" });
  });

  test("somebody who may not use the Bot reaches nothing", async () => {
    const { gateway, calls } = recordingGateway();
    const response = await appFor(gateway, async () => false).request(
      post("/bot-1/files/delete", { path: "notes.txt" }),
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
