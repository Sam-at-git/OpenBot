/**
 * iMessage, through a bridge on a Mac signed in to Messages (imessage-bridge/bridge.py).
 *
 * OpenBot cannot reach Messages from a container, so the bridge sends for it (`POST /send`) and posts
 * each reply from the phone back to `/api/delivery/webhooks/imessage`. Both directions carry one
 * shared token. The bridge itself only talks to the handles it was told to allow.
 *
 * One phone can follow several Bots. Every message from the Mac comes from the same Apple ID, so
 * each one starts with the Bot's name, and a binding is kept per Bot: its identity is the handle
 * and the Bot (`handle#agentId`), its address the handle alone. A reply goes to the Bot it names
 * (`@Scout …`), or else to the Bot that wrote to the phone last.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  DeliveryProviderError,
  type DeliverySender,
  type ProviderFetch,
  type TextTransport,
} from "./types";

/** The realm of every iMessage binding: one bridge per deployment. */
export const IMESSAGE_REALM = "imessage";

export type IMessageConfig = { url: string; token: string };

export type IMessageTransport = TextTransport & {
  config: IMessageConfig;
  /** Whether an inbound request carries the bridge's token. */
  verifyInbound(authorization: string | undefined | null): boolean;
};

const PHONE = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A phone number in E.164 without spaces or dashes, or an email address in lower case. */
export function iMessageHandle(raw: string): string | null {
  const value = raw.trim();
  if (value.includes("@")) {
    const email = value.toLowerCase();
    return EMAIL.test(email) ? email : null;
  }
  const phone = value.replace(/[\s\-().]/g, "");
  return PHONE.test(phone) ? phone : null;
}

/** The binding identity for one phone following one Bot. */
export function iMessageIdentity(handle: string, agentId: string): string {
  return `${handle}#${agentId}`;
}

/** What the phone shows: the Bot's name first, since every message comes from one Apple ID. */
export function iMessageText(text: string, sender?: DeliverySender): string {
  return sender?.name ? `【${sender.name}】${text}` : text;
}

/**
 * Which Bot a message from the phone is for.
 *
 * `@Name …` picks the Bot of that name, and the rest is the message. Otherwise the Bot that wrote to
 * the phone last, so a plain answer goes to whoever asked; otherwise the newest connection.
 */
export function pickIMessageBinding<B extends { id: string; agentId: string }>(
  bindings: readonly B[],
  text: string,
  nameOf: (agentId: string) => string | undefined,
  lastWrote: string | null,
): { binding: B | null; text: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("@")) {
    const named = bindings
      .map((binding) => ({ binding, name: nameOf(binding.agentId) ?? "" }))
      .filter(({ name }) => name !== "")
      // The longest name first, so `@Scout Lead` is not taken for `@Scout`.
      .sort((a, b) => b.name.length - a.name.length)
      .find(({ name }) =>
        trimmed.slice(1).toLowerCase().startsWith(name.toLowerCase()),
      );
    if (named)
      return {
        binding: named.binding,
        text:
          trimmed
            .slice(1 + named.name.length)
            .replace(/^[\s,:：，]+/, "")
            .trim() || trimmed,
      };
  }
  const last = lastWrote
    ? bindings.find((binding) => binding.id === lastWrote)
    : undefined;
  return { binding: last ?? bindings.at(-1) ?? null, text: trimmed };
}

/** A verification code's stored form: never the code itself. */
export function codeDigest(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

export function createIMessageTransport(
  config: IMessageConfig,
  fetchImpl: ProviderFetch = fetch,
): IMessageTransport {
  const base = config.url.replace(/\/$/, "");
  const expected = Buffer.from(`Bearer ${config.token}`);
  return {
    config,
    async send({ id, address, text, sender }) {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({
            to: address,
            text: iMessageText(text, sender),
          }),
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        // The bridge may have sent it before the connection dropped.
        throw new DeliveryProviderError("iMessage", "unreachable", true);
      }
      if (!response.ok)
        throw new DeliveryProviderError("iMessage", String(response.status));
      const body = (await response.json().catch(() => ({}))) as {
        id?: unknown;
      };
      return {
        id: typeof body.id === "string" ? body.id : id,
        status: "sent",
      };
    },
    verifyInbound(authorization) {
      const given = Buffer.from(authorization ?? "");
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    },
  };
}
