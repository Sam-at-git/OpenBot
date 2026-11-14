import { useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";

/**
 * Why the last turn ended without an answer, for a surface that has to say so itself.
 *
 * A run can end three ways. It finishes, which needs no explanation. It fails in the browser, which
 * arrives as an error. Or the Bot's own stream stops producing anything and this deployment ends the
 * turn for it, which arrives as a RUN_ERROR carrying the sentence the server wrote (see
 * server/src/channels/stall-guard.ts). The last two both leave the same hole on screen: the composer
 * unlocks, the spinner disappears, and nothing says what happened.
 *
 * The reason is kept as a sentence rather than a flag because the reasons are not interchangeable. A
 * Bot that refused, a Bot whose endpoint is down and a Bot that simply stopped talking are three
 * different things to be told, and only the thing that ended the turn knows which one it was.
 */

/**
 * The sentence to show, in the words of whatever ended the turn.
 *
 * Falls back only when there is genuinely nothing to pass on. Saying "the Bot stopped without saying
 * why" is honest about that; inventing a cause would not be, and this is the one moment a person has
 * no other way to find out what went wrong.
 */
export function stoppedReason(reported: unknown): string {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  if (refusedAsBusy(said)) return STILL_WORKING;
  return said.trim() || "The Bot stopped without saying why.";
}

/**
 * The runtime's own words when it refuses a run because the conversation already has one going.
 *
 * `ThreadAlreadyRunningError` reaches the browser as a RUN_ERROR with exactly this message (the runtime's
 * `sse-response`, and `local-threads/runner.ts` throws it). It is the one refusal that is not the Bot's fault and has
 * an obvious next step, and in the runtime's words it read as an internal failure. It became common once a chat's
 * computer ran on the server: a turn keeps going while the person is on another page, and coming back to the
 * conversation does not tell this screen the turn is still running, so the next message is sent into it (2026-11-14).
 */
const THREAD_ALREADY_RUNNING = "Thread already running";

export const STILL_WORKING =
  "This Bot is still working on an earlier request, so your message wasn't sent. Send it again when it's done.";

/** Whether this turn was refused because the conversation was busy, so nothing reached the Bot at all. */
export function refusedAsBusy(reported: unknown): boolean {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  return said.trim() === THREAD_ALREADY_RUNNING || said === STILL_WORKING;
}

/**
 * Watch one Bot's runs and hold on to the reason the last one ended, if it ended badly.
 *
 * Bound by agent id rather than handed an agent, so a caller that only renders the packaged chat
 * does not have to reach for one: `useAgent` returns the same shared instance the chat itself binds
 * to, so this watches exactly the runs that chat starts.
 *
 * Cleared when the next run begins rather than on a timer. A sentence about a turn that is over
 * should stay until there is something newer to look at, and the person deciding when that is is the
 * one who sends the next message.
 */
export function useStoppedTurn(agentId: string): string | null {
  const { agent } = useAgent({ agentId });
  const [stopped, setStopped] = useState<string | null>(null);

  useEffect(() => {
    const subscription = agent.subscribe?.({
      onRunInitialized: () => setStopped(null),
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => setStopped(stoppedReason(error)),
    });
    return () => subscription?.unsubscribe();
  }, [agent]);

  return stopped;
}
