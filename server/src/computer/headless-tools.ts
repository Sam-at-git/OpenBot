import {
  type HeadlessTool,
  HeadlessToolSuspension,
} from "@openbot/toolkit/headless-tools";
import { handedBack } from "@openbot/shared/computer-control";
import { z } from "zod";
import { currentApprovalContext } from "../approvals/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { ComputerSeat } from "./computer-key";
import {
  type ActionActor,
  type ComputerGateway,
  ComputerStillStartingError,
  HumanHasControlError,
} from "./gateway";
import type { ControlState } from "./schema";

/** What the headless sign-in tool needs from the passwords module. See passwords/service.ts. */
export type HeadlessSignInRequester = {
  request(input: {
    ownerUserId: string;
    botId: string;
    site: string;
    reason?: string;
    actor: ActionActor;
    threadId?: string;
    toolCallId?: string;
    continuation?: Record<string, unknown>;
    notify?: boolean;
  }): Promise<{ id: string; origin: string }>;
};

/** Shared by the headless tool and the browser's registration, so both promise the same thing. */
export const SIGN_IN_TOOL_DESCRIPTION =
  "Ask the person you work for to sign you in to a website. They get a private sign-in form outside this conversation (or take over the browser), and their login is typed straight into your browser by the computer. You never see the username, password or code, and must never ask for them any other way. Open the site's sign-in page first, then call this with the site's address. This turn pauses until they answer; you are then told only whether it worked.";

/** How long a chat waits for the person to hand the browser back or type a secret, as the browser itself waits. */
const WAIT_FOR_PERSON_MS = 10 * 60_000;
const WAIT_POLL_MS = 1_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Shipped browser/file/command tools, with identity bound before the model supplies arguments. */
export function createHeadlessComputerTools(options: {
  gateway: ComputerGateway;
  /**
   * The Bot's seat for the person this run acts for: `gateway.seatFor(botId, ownerUserId)`.
   *
   * Resolved once per run, so an administrator withdrawing Isolated Bots moves the Bot onto the
   * person's computer from its next run rather than part way through this one.
   */
  seat: ComputerSeat;
  actor: ActionActor;
  auditStore?: AuditStore;
  /** The private sign-in request. Absent leaves the Bot with help and secret requests only. */
  signIn?: HeadlessSignInRequester;
  /**
   * Wait for the person instead of pausing the turn, as a browser chat does.
   *
   * A chat whose computer runs on the server has somebody watching: the help card and the masked secret prompt are on
   * their screen. So asking for help, asking for a secret, and finding the person at the wheel wait here for up to ten
   * minutes and answer the way the browser's own tools answer. Only past that does the turn pause as a routine's does.
   */
  waitForPerson?: boolean;
  /** For tests: how often and how long to wait. */
  waitTiming?: { pollMs: number; maxMs: number };
}): HeadlessTool[] {
  const { gateway, seat, actor, auditStore, signIn, waitForPerson } = options;
  const pollMs = options.waitTiming?.pollMs ?? WAIT_POLL_MS;
  const maxMs = options.waitTiming?.maxMs ?? WAIT_FOR_PERSON_MS;

  /**
   * The person's answer to a handoff, or undefined when they did not answer in time. Shaped like the browser's
   * `awaitHandoff` result, so the Bot reads the same thing whichever side ran the tool.
   */
  async function handedBackOrNot(
    requestId: string,
    signal: AbortSignal,
  ): Promise<unknown | undefined> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (signal.aborted)
        return {
          ok: false,
          stopped: true,
          requestId,
          reason:
            "Stopped waiting. A person who has control keeps it until they hand back.",
        };
      const request = (
        await gateway.control(seat, requestId).catch(() => undefined)
      )?.request;
      if (request?.id === requestId) {
        if (request.status === "completed")
          return {
            result: handedBack(request.reason),
            handoffStatus: "completed",
            ...(await gateway.snapshot(seat)),
            ok: true,
            requestId,
          };
        if (request.status !== "waiting" && request.status !== "taken")
          return {
            ok: false,
            requestId,
            handoffStatus: request.status,
            reason:
              request.interruption ??
              `The handoff was ${request.status}. The person has not completed this request.`,
          };
      }
      await pause(pollMs, signal);
    }
    return undefined;
  }
  const botId = seat.botId;
  const snapshotId = z.number().int().positive();
  const ref = z.string().min(1);
  const text = z.string().min(1);
  const noArgs = z.strictObject({});
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    execute: (
      input: z.output<T>,
      context: { toolCallId: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ): HeadlessTool {
    return {
      definition: { name, description, parameters: z.toJSONSchema(schema) },
      execute: async (args, context) => {
        const input = schema.parse(args);
        if (context.signal.aborted)
          throw new Error("The computer action was stopped.");
        try {
          return await execute(input, context);
        } catch (error) {
          /*
           * A cold start that outlasted the wait is answered, not thrown.
           *
           * Thrown, it reached the model as a bare error string beside every real failure, and a
           * model reading "error" tends to apologise and give up on a computer that was seconds from
           * ready. As a result it says the three things that decide the next step: the computer is
           * starting, this call did nothing, and trying again shortly is the right move.
           */
          if (error instanceof ComputerStillStartingError) {
            return {
              ok: false,
              starting: true,
              notPerformed: true,
              reason: error.message,
            };
          }
          if (error instanceof HumanHasControlError) {
            // What the browser's own call answers on a 409: the person is at the wheel, nothing was done.
            if (waitForPerson)
              return {
                ok: false,
                humanHasControl: true,
                notPerformed: true,
                reason: error.message,
                ...(error.requestId ? { requestId: error.requestId } : {}),
                ...(error.handoff ? { handoff: error.handoff } : {}),
              };
            throw new HeadlessToolSuspension(error.message, {
              kind: "computer_handoff",
              botId,
              ...(error.requestId ? { requestId: error.requestId } : {}),
              ...(error.handoff ? { handoff: error.handoff } : {}),
            });
          }
          throw error;
        }
      },
    };
  }
  function waiting(
    state: ControlState,
    reason: string,
    kind = "computer_handoff",
  ): never {
    throw new HeadlessToolSuspension(reason, {
      kind,
      botId,
      ...(state.request
        ? { requestId: state.request.id, handoff: state.request }
        : {}),
    });
  }
  const tools = [
    tool(
      "computer_navigate",
      "Open a web page and return its title and readable text. Use the returned content to answer.",
      z.strictObject({ url: text }),
      async ({ url }, { toolCallId, signal }) => {
        const result = await gateway.navigate(seat, actor, url, toolCallId);
        if (result.challenge && waitForPerson) {
          const answer = await handedBackOrNot(
            result.challenge.requestId,
            signal,
          );
          if (answer) return { ...(answer as object), challenge: result.challenge };
        }
        if (result.challenge)
          throw new HeadlessToolSuspension(result.challenge.reason, {
            kind: "computer_handoff",
            botId,
            requestId: result.challenge.requestId,
            source: result.challenge.kind,
          });
        return { ok: true, ...result };
      },
    ),
    tool(
      "computer_read",
      "Read the currently open browser page without navigating.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.read(seat)) }),
    ),
    tool(
      "computer_snapshot",
      "List fields, buttons and links with refs. Call before clicking or typing and pass the returned snapshotId with every ref. If refs are stale take a fresh snapshot.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.snapshot(seat)) }),
    ),
    tool(
      "computer_screenshot",
      "Return an image of the browser currently open on your computer.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.screenshot(seat)) }),
    ),
    tool(
      "computer_click",
      "Click an element using its ref and snapshotId from the latest snapshot.",
      z.strictObject({ ref, snapshotId }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.click(seat, actor, input, signal)),
      }),
    ),
    tool(
      "computer_type",
      "Replace a field's contents using its ref and snapshotId. Set submit to press Enter afterwards.",
      z.strictObject({
        ref,
        snapshotId,
        text: z.string(),
        submit: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.type(seat, actor, input, signal)),
      }),
    ),
    tool(
      "computer_key",
      "Press Enter, Tab, Escape or another key on the page. When a ref is given pass its snapshotId.",
      z
        .strictObject({
          key: text,
          ref: ref.optional(),
          snapshotId: snapshotId.optional(),
        })
        .refine((input) => !input.ref || input.snapshotId !== undefined, {
          message: "A snapshotId is required when a ref is given.",
        }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.key(seat, actor, input, signal)),
      }),
    ),
    tool(
      "computer_scroll",
      "Scroll down by pixels, or up with a negative deltaY. Defaults to 600.",
      z.strictObject({ deltaY: z.number().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.scroll(seat, actor, input)),
      }),
    ),
    tool(
      "computer_list_files",
      "List files and folders in your workspace. Call first before reading an uncertain filename.",
      z.strictObject({ path: z.string().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.listFiles(seat, actor, input)),
      }),
    ),
    tool(
      "computer_read_file",
      "Read a saved file relative to your persistent workspace, such as notes.md.",
      z.strictObject({ path: text }),
      async (input) => ({
        ok: true,
        ...(await gateway.readFile(seat, actor, input)),
      }),
    ),
    tool(
      "computer_write_file",
      "Save text in your workspace. Set append to add to the end of an existing file.",
      z.strictObject({
        path: text,
        contents: z.string(),
        append: z.boolean().optional(),
      }),
      async (input) => ({
        ok: true,
        ...(await gateway.writeFile(seat, actor, input)),
      }),
    ),
    tool(
      "computer_run_command",
      "Run a bash shell command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. For package installation use sudo apt-get; if refused say so rather than retrying.",
      z.strictObject({ command: text }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.runCommand(seat, actor, input, signal)),
      }),
    ),
    tool(
      "computer_request_help",
      "Create a durable request for the person to take the browser and sign in or clear a challenge. This unattended turn pauses until a person helps; never ask them to send you a password.",
      z.strictObject({ reason: text }),
      async ({ reason }, { toolCallId, signal }) => {
        const state = await gateway.requestHelp(
          seat,
          actor,
          reason,
          toolCallId,
        );
        if (waitForPerson && state.request) {
          const answer = await handedBackOrNot(state.request.id, signal);
          if (answer) return answer;
        }
        return waiting(state, reason);
      },
    ),
    tool(
      "computer_request_secret",
      "Ask the person to enter one secret directly into the focused field. Click the field first. You must never receive the secret; this unattended turn pauses for the person.",
      z.strictObject({ label: text, ref, snapshotId }),
      async (input, { signal }) => {
        const state = await gateway.requestSecret(seat, actor, input);
        if (waitForPerson) {
          // Answered when `secretWanted` clears; the value never comes back here.
          const deadline = Date.now() + maxMs;
          while (Date.now() < deadline && !signal.aborted) {
            const now = await gateway.control(seat).catch(() => undefined);
            if (now && now.secretWanted === undefined)
              return {
                ok: true,
                result: `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`,
              };
            await pause(pollMs, signal);
          }
          if (signal.aborted)
            return { ok: true, result: "The request was cancelled." };
        }
        return waiting(
          state,
          `The person must enter ${input.label} directly into the page.`,
          "computer_secret",
        );
      },
    ),
  ];
  if (signIn)
    tools.push(
      tool(
        "computer_request_sign_in",
        SIGN_IN_TOOL_DESCRIPTION,
        z.strictObject({ site: text, reason: z.string().optional() }),
        async ({ site, reason }, { toolCallId }) => {
          const continuation = currentApprovalContext();
          const request = await signIn.request({
            ownerUserId: actor.userId ?? actor.id,
            botId,
            site,
            ...(reason ? { reason } : {}),
            actor,
            ...(continuation?.threadId
              ? { threadId: continuation.threadId }
              : {}),
            toolCallId,
            ...(continuation
              ? {
                  continuation: continuation as unknown as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
            notify: true,
          });
          throw new HeadlessToolSuspension(
            `Waiting for the person to sign in to ${request.origin} in a private form.`,
            {
              kind: "computer_sign_in",
              botId,
              requestId: request.id,
              signInRequestId: request.id,
              site: request.origin,
            },
          );
        },
      ),
    );
  if (auditStore)
    tools.push(
      tool(
        "report_refusal",
        "Record a request you chose to decline, and why. This records evidence and does not enforce a policy.",
        z.strictObject({ reason: text, request: z.string().optional() }),
        async ({ reason, request }) => {
          await recordAuditEvent(auditStore, {
            eventType: "bot.declined",
            targetType: "agent",
            targetId: botId,
            ...(actor.userId ? { actorUserId: actor.userId } : {}),
            initiator: actor.initiator,
            payload: {
              bot: botId,
              actor: actor.id,
              reason: reason.slice(0, 500),
              ...(request ? { request: request.slice(0, 500) } : {}),
              reportedBy: "the Bot itself",
            },
          });
          return { ok: true, recorded: true };
        },
      ),
    );
  return tools;
}
