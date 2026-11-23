import { describe, expect, test } from "bun:test";
import { clearComputerWaits } from "../src/lib/copilot/computer-waits";

const wait = (id: string, kind: string, requestId?: string) => ({
  id,
  metadata: { openbotWaiting: { kind, ...(requestId ? { requestId } : {}) } },
});

describe("a new message in a turn paused on the computer", () => {
  test("withdraws the open sign-in and clears the pause", async () => {
    const agent = {
      pendingInterrupts: [wait("call-1", "computer_sign_in", "request-1")],
    };
    const withdrawn: string[] = [];
    await clearComputerWaits(agent, async (id) => void withdrawn.push(id));
    expect(withdrawn).toEqual(["request-1"]);
    expect(agent.pendingInterrupts).toEqual([]);
  });

  test("clears a browser handoff without withdrawing anything", async () => {
    const agent = {
      pendingInterrupts: [wait("call-1", "computer_handoff", "control-1")],
    };
    const withdrawn: string[] = [];
    await clearComputerWaits(agent, async (id) => void withdrawn.push(id));
    expect(withdrawn).toEqual([]);
    expect(agent.pendingInterrupts).toEqual([]);
  });

  test("leaves an approval in place", async () => {
    const approval = wait("call-2", "approval", "approval-1");
    const agent = {
      pendingInterrupts: [wait("call-1", "computer_handoff"), approval],
    };
    await clearComputerWaits(agent, async () => undefined);
    expect(agent.pendingInterrupts).toEqual([approval]);
  });

  test("keeps the pause when the sign-in could not be withdrawn", async () => {
    const pause = wait("call-1", "computer_sign_in", "request-1");
    const agent = { pendingInterrupts: [pause] };
    await expect(
      clearComputerWaits(agent, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(agent.pendingInterrupts).toEqual([pause]);
  });
});
