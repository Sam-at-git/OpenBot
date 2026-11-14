import { describe, expect, test } from "bun:test";
import type { ComputerControlState } from "@openbot/shared/computer-control";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { HumanHasControlError } from "../src/computer/client";
import { botSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";

/**
 * A person's chat whose computer runs on the server (OPENBOT_CHAT_COMPUTER_ON_SERVER).
 *
 * Somebody is watching, so asking for help or a secret waits for them the way the browser's own tools wait, and only
 * pauses the turn when nobody answers. A routine still pauses straight away.
 */

const request = (status: "waiting" | "taken" | "completed" | "cancelled") => ({
  id: "help-1",
  reason: "Sign in to IMS",
  source: "model" as const,
  status,
  createdAt: "2026-11-14T08:00:00.000Z",
  updatedAt: "2026-11-14T08:00:00.000Z",
});

const state = (
  extra: Partial<ComputerControlState> = {},
): ComputerControlState => ({
  holder: "bot",
  since: "2026-11-14T08:00:00.000Z",
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
  recoveryRequired: false,
  ...extra,
});

/** A gateway that answers control reads from a script, one answer per read, the last one repeating. */
function gatewayAnswering(answers: ComputerControlState[]) {
  let reads = 0;
  const gateway = {
    requestHelp: async () => state({ request: request("waiting") }),
    requestSecret: async () => state({ secretWanted: "IMS password" }),
    control: async () => answers[Math.min(reads++, answers.length - 1)],
    snapshot: async () => ({ snapshotId: 3, elements: [] }),
    click: async () => {
      throw new HumanHasControlError(
        "A person has control of the browser.",
        "help-1",
      );
    },
  } as unknown as ComputerGateway;
  return { gateway, reads: () => reads };
}

function toolsFor(gateway: ComputerGateway, waitForPerson: boolean) {
  const tools = createHeadlessComputerTools({
    gateway,
    seat: botSeat("bot"),
    actor: {
      id: "owner",
      userId: "owner",
      initiator: { kind: "routine", id: "routine" },
    },
    waitForPerson,
    waitTiming: { pollMs: 1, maxMs: 200 },
  });
  return (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute(args, {
      toolCallId: "call-1",
      signal: new AbortController().signal,
    });
  };
}

describe("a chat's computer on the server", () => {
  test("waits for the person to hand back, and tells the Bot so with the page", async () => {
    const { gateway } = gatewayAnswering([
      state({ request: request("waiting") }),
      state({ holder: "human", request: request("taken") }),
      state({ request: request("completed") }),
    ]);
    const answer = (await toolsFor(gateway, true)("computer_request_help", {
      reason: "Sign in to IMS",
    })) as Record<string, unknown>;
    expect(answer).toMatchObject({
      ok: true,
      handoffStatus: "completed",
      requestId: "help-1",
      snapshotId: 3,
    });
    expect(String(answer.result)).toContain("Sign in to IMS");
  });

  test("says the person did not finish when they cancel", async () => {
    const { gateway } = gatewayAnswering([
      state({ request: request("cancelled") }),
    ]);
    expect(
      await toolsFor(gateway, true)("computer_request_help", {
        reason: "Sign in to IMS",
      }),
    ).toMatchObject({ ok: false, handoffStatus: "cancelled" });
  });

  test("pauses the turn when nobody answers in time", async () => {
    const { gateway } = gatewayAnswering([
      state({ request: request("waiting") }),
    ]);
    await expect(
      toolsFor(gateway, true)("computer_request_help", {
        reason: "Sign in to IMS",
      }),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  });

  test("waits for a secret to be typed, and never hands the Bot its value", async () => {
    const { gateway } = gatewayAnswering([
      state({ secretWanted: "IMS password" }),
      state(),
    ]);
    const answer = (await toolsFor(gateway, true)("computer_request_secret", {
      label: "IMS password",
      ref: "e1",
      snapshotId: 3,
    })) as { ok: boolean; result: string };
    expect(answer.ok).toBe(true);
    expect(answer.result).toContain("has entered IMS password");
  });

  test("answers like the browser when the person is at the wheel", async () => {
    const { gateway } = gatewayAnswering([state()]);
    expect(
      await toolsFor(gateway, true)("computer_click", {
        ref: "e1",
        snapshotId: 3,
      }),
    ).toMatchObject({
      ok: false,
      humanHasControl: true,
      notPerformed: true,
      requestId: "help-1",
    });
  });
});

describe("a routine's computer", () => {
  test("pauses straight away for help, without waiting", async () => {
    const { gateway, reads } = gatewayAnswering([
      state({ request: request("completed") }),
    ]);
    await expect(
      toolsFor(gateway, false)("computer_request_help", {
        reason: "Sign in to IMS",
      }),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(reads()).toBe(0);
  });

  test("pauses when the person is at the wheel", async () => {
    const { gateway } = gatewayAnswering([state()]);
    await expect(
      toolsFor(gateway, false)("computer_click", { ref: "e1", snapshotId: 3 }),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
  });
});
