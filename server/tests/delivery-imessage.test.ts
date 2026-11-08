import { describe, expect, test } from "bun:test";
import {
  codeDigest,
  createIMessageTransport,
  iMessageHandle,
  iMessageIdentity,
  iMessageText,
  pickIMessageBinding,
} from "../src/delivery/imessage";
import { configuredDeliveryProviders } from "../src/delivery/routes";
import { DeliveryProviderError } from "../src/delivery/types";

const TOKEN = "t".repeat(40);

describe("iMessage handles", () => {
  test("a phone loses its spaces and dashes, an email its case", () => {
    expect(iMessageHandle(" +86 135-1036-3575 ")).toBe("+8613510363575");
    expect(iMessageHandle("Zhou.Office@Gmail.com")).toBe(
      "zhou.office@gmail.com",
    );
    expect(iMessageHandle("13510363575")).toBeNull();
    expect(iMessageHandle("not an address")).toBeNull();
  });

  test("one phone follows each Bot under its own identity", () => {
    expect(iMessageIdentity("+8613510363575", "scout")).toBe(
      "+8613510363575#scout",
    );
  });

  test("the phone sees which Bot wrote", () => {
    expect(iMessageText("Ready?", { agentId: "ceo", name: "CEO" })).toBe(
      "【CEO】Ready?",
    );
    expect(iMessageText("OpenBot code: 1")).toBe("OpenBot code: 1");
  });

  test("a code is kept as a digest tied to its challenge", () => {
    expect(codeDigest("a", "123456")).not.toBe(codeDigest("b", "123456"));
    expect(codeDigest("a", "123456")).not.toContain("123456");
  });
});

describe("which Bot a message from the phone is for", () => {
  const bindings = [
    { id: "b1", agentId: "scout" },
    { id: "b2", agentId: "scout-lead" },
    { id: "b3", agentId: "ceo" },
  ];
  const names: Record<string, string> = {
    scout: "Scout",
    "scout-lead": "Scout Lead",
    ceo: "CEO",
  };
  const nameOf = (id: string) => names[id];

  test("@Name picks that Bot, the longest name first, and drops the mention", () => {
    expect(pickIMessageBinding(bindings, "@ceo GO", nameOf, "b1")).toEqual({
      binding: bindings[2],
      text: "GO",
    });
    expect(
      pickIMessageBinding(bindings, "@Scout Lead，看看这个", nameOf, null),
    ).toEqual({ binding: bindings[1], text: "看看这个" });
  });

  test("a plain reply goes to the Bot that wrote last, else the newest connection", () => {
    expect(pickIMessageBinding(bindings, "收到", nameOf, "b1").binding).toBe(
      bindings[0],
    );
    expect(pickIMessageBinding(bindings, "收到", nameOf, null).binding).toBe(
      bindings[2],
    );
    expect(pickIMessageBinding(bindings, "@nobody hi", nameOf, "b3")).toEqual({
      binding: bindings[2],
      text: "@nobody hi",
    });
    expect(pickIMessageBinding([], "hi", nameOf, null).binding).toBeNull();
  });
});

describe("the iMessage transport", () => {
  test("sends through the bridge with its token and the Bot's name", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = createIMessageTransport(
      { url: "http://bridge:8060/", token: TOKEN },
      async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ id: "m1", status: "sent" });
      },
    );
    const result = await transport.send({
      id: "o1",
      address: "+8613510363575",
      text: "Ready?",
      sender: { agentId: "ceo", name: "CEO" },
    });
    expect(result).toEqual({ id: "m1", status: "sent" });
    expect(calls[0]?.url).toBe("http://bridge:8060/send");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      to: "+8613510363575",
      text: "【CEO】Ready?",
    });
  });

  test("a refusal is a provider error; an unreachable bridge is an uncertain one", async () => {
    const refused = createIMessageTransport(
      { url: "http://bridge", token: TOKEN },
      async () => Response.json({ error: "no" }, { status: 403 }),
    );
    await expect(
      refused.send({ id: "o", address: "+8613510363575", text: "x" }),
    ).rejects.toBeInstanceOf(DeliveryProviderError);
    const down = createIMessageTransport(
      { url: "http://bridge", token: TOKEN },
      async () => {
        throw new Error("ECONNREFUSED");
      },
    );
    const error = await down
      .send({ id: "o", address: "+8613510363575", text: "x" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(DeliveryProviderError);
    expect((error as DeliveryProviderError).uncertain).toBe(true);
  });

  test("only the bridge's token is accepted inbound", () => {
    const transport = createIMessageTransport({
      url: "http://b",
      token: TOKEN,
    });
    expect(transport.verifyInbound(`Bearer ${TOKEN}`)).toBe(true);
    expect(transport.verifyInbound(`Bearer ${"x".repeat(40)}`)).toBe(false);
    expect(transport.verifyInbound(undefined)).toBe(false);
  });

  test("configured only with both settings, and a long enough token", () => {
    expect(configuredDeliveryProviders("http://localhost", {}).imessage).toBe(
      undefined,
    );
    expect(
      configuredDeliveryProviders("http://localhost", {
        IMESSAGE_BRIDGE_URL: "http://host.docker.internal:8060",
        IMESSAGE_BRIDGE_TOKEN: TOKEN,
      }).imessage?.config.url,
    ).toBe("http://host.docker.internal:8060");
    expect(() =>
      configuredDeliveryProviders("http://localhost", {
        IMESSAGE_BRIDGE_URL: "http://host.docker.internal:8060",
      }),
    ).toThrow("IMESSAGE_BRIDGE_TOKEN");
    expect(() =>
      configuredDeliveryProviders("http://localhost", {
        IMESSAGE_BRIDGE_URL: "http://host.docker.internal:8060",
        IMESSAGE_BRIDGE_TOKEN: "short",
      }),
    ).toThrow("at least 32");
  });
});
