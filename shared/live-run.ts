/**
 * The marker a conversation's replay carries when it has caught up with a run that is still going.
 *
 * Opening a conversation replays its stored runs and, when one is running on the server, then follows it live, so the
 * connection stays open until that run ends. The browser bounds how long it waits for the replay to finish and ends a
 * connection that outlasts it, which was right for a stuck one and wrong for this: ending it told the screen the Bot
 * was idle while it was still working, and the next message was refused with "Thread already running" (2026-11-14,
 * once a chat's computer ran on the server and a turn kept going while the person was on another page).
 *
 * Only the server knows which of the two an open connection is, so it says so. Sent right after the live run's
 * RUN_STARTED, inside the run, where the event verifier allows a CUSTOM event; between runs it would be refused.
 */
export const FOLLOWING_LIVE_RUN_EVENT = "openbot.following-live-run";
