import { describe, expect, test } from "bun:test";
import {
  refusedAsBusy,
  STILL_WORKING,
  stoppedReason,
} from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

describe("the reason a turn ended", () => {
  test("passes on what ended the turn, in its own words", () => {
    expect(
      stoppedReason(
        "Risk Analyst stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toContain("Risk Analyst stopped responding");
  });

  test("reads an Error the same way, because a failed run carries one", () => {
    expect(
      stoppedReason(new Error("The endpoint refused the connection")),
    ).toBe("The endpoint refused the connection");
  });

  test("says so plainly when nothing was reported, rather than inventing a cause", () => {
    // This is the one moment a person has no other way to find out what went wrong, so a guess here
    // would be worse than an admission.
    expect(stoppedReason(undefined)).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason("")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason("   ")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason(new Error(""))).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason({ message: "not a string or an Error" })).toBe(
      "The Bot stopped without saying why.",
    );
  });
});

/**
 * A message sent while the conversation already has a turn running is refused by the runtime with
 * "Thread already running", and nothing reaches the Bot. On 2026-11-14 two messages to IMS Tester were
 * lost that way with only those words on screen.
 */
describe("a message refused because the Bot is busy", () => {
  test("says the message wasn't sent and what to do", () => {
    const said = stoppedReason("Thread already running");
    expect(said).toBe(STILL_WORKING);
    expect(said).toContain("wasn't sent");
    expect(said).toContain("Send it again");
  });

  test("reads the same from an Error", () => {
    expect(stoppedReason(new Error("Thread already running"))).toBe(
      STILL_WORKING,
    );
  });

  test("is told apart from every other way a turn ends", () => {
    expect(refusedAsBusy("Thread already running")).toBe(true);
    expect(refusedAsBusy(STILL_WORKING)).toBe(true);
    expect(refusedAsBusy("Thread access denied")).toBe(false);
    expect(refusedAsBusy("Agent run failed")).toBe(false);
    expect(refusedAsBusy(undefined)).toBe(false);
  });
});
