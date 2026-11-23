/** Where a paused turn says what it is waiting for (`OPENBOT_WAITING_METADATA` in the toolkit). */
const WAITING_METADATA = "openbotWaiting";

/** A turn paused on the Bot's computer. An approval is not here: a new message must not step around one. */
const COMPUTER_WAITS = new Set([
  "computer_sign_in",
  "computer_handoff",
  "computer_secret",
]);

function waitingOn(interrupt: { metadata?: unknown }) {
  const metadata = interrupt.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const waiting = (metadata as Record<string, unknown>)[WAITING_METADATA];
  if (!waiting || typeof waiting !== "object") return null;
  const { kind, requestId } = waiting as Record<string, unknown>;
  if (typeof kind !== "string" || !COMPUTER_WAITS.has(kind)) return null;
  return {
    kind,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
}

/**
 * Lets a person's new message through a turn that was paused on the Bot's computer.
 *
 * AG-UI refuses every run on a thread with an open interrupt, in the browser, before anything is sent. A chat has no
 * way to answer one of these, so the conversation stayed shut. An open sign-in is withdrawn first, so it cannot later
 * continue the old turn alongside the new one; if that fails this throws, and the composer puts the words back.
 */
export async function clearComputerWaits<T extends { metadata?: unknown }>(
  agent: { pendingInterrupts: T[] },
  withdrawSignIn: (requestId: string) => Promise<unknown>,
): Promise<void> {
  const waits = agent.pendingInterrupts.filter(waitingOn);
  if (waits.length === 0) return;
  for (const interrupt of waits) {
    const waiting = waitingOn(interrupt);
    if (waiting?.kind === "computer_sign_in" && waiting.requestId)
      await withdrawSignIn(waiting.requestId);
  }
  agent.pendingInterrupts = agent.pendingInterrupts.filter(
    (interrupt) => !waitingOn(interrupt),
  );
}
