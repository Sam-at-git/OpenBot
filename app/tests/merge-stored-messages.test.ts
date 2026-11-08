import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { mergeStoredMessages } from "../src/components/channels/channel-chat";

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: {
    name: "mcp__composio-airtable__AIRTABLE_LIST_BASES",
    arguments: "{}",
  },
});

const question: Message = {
  id: "user-1",
  role: "user",
  content: "What bases do I have?",
};
const result: Message = {
  id: "result-1",
  role: "tool",
  toolCallId: "call_1",
  content: "Refused. Connect Airtable.",
};
const answer: Message = {
  id: "answer-1",
  role: "assistant",
  content: "Airtable is not connected.",
};

describe("mergeStoredMessages", () => {
  test("a stored tool call the live turn already holds under another id is not added again", () => {
    const local: Message[] = [
      question,
      { id: "call_1", role: "assistant", toolCalls: [call("call_1")] },
      result,
      answer,
    ];
    const stored: Message[] = [
      question,
      {
        id: "assistant-call_1",
        role: "assistant",
        toolCalls: [call("call_1")],
      },
      result,
      answer,
    ];
    expect(mergeStoredMessages(local, stored)).toBe(local);
  });

  test("a missing stored message still lands before the live message holding the same call", () => {
    const local: Message[] = [
      { id: "call_1", role: "assistant", toolCalls: [call("call_1")] },
      result,
    ];
    const stored: Message[] = [
      question,
      {
        id: "assistant-call_1",
        role: "assistant",
        toolCalls: [call("call_1")],
      },
      result,
    ];
    expect(mergeStoredMessages(local, stored).map((m) => m.id)).toEqual([
      "user-1",
      "call_1",
      "result-1",
    ]);
  });

  test("a stored tool call the live turn does not hold is still added", () => {
    const local: Message[] = [question];
    const stored: Message[] = [
      question,
      {
        id: "assistant-call_2",
        role: "assistant",
        toolCalls: [call("call_2")],
      },
    ];
    expect(mergeStoredMessages(local, stored).map((m) => m.id)).toEqual([
      "user-1",
      "assistant-call_2",
    ]);
  });
});

describe("a turn this page did not start", () => {
  const asked: Message = { id: "u-1", role: "user", content: "介绍一下你自己" };
  const partial: Message = { id: "a-1", role: "assistant", content: "我是" };
  const longer: Message = {
    id: "a-1",
    role: "assistant",
    content: "我是 ims助手。",
  };

  test("takes the answer's newer text from the store", () => {
    expect(
      mergeStoredMessages([asked, partial], [asked, longer], true),
    ).toEqual([asked, longer]);
  });

  test("without it, a message already shown keeps its text", () => {
    const local = [asked, partial];
    expect(mergeStoredMessages(local, [asked, longer])).toBe(local);
  });

  test("still adds what is missing, and is unchanged when nothing differs", () => {
    expect(mergeStoredMessages([asked], [asked, partial], true)).toEqual([
      asked,
      partial,
    ]);
    const local = [asked, longer];
    expect(mergeStoredMessages(local, [asked, longer], true)).toBe(local);
  });

  test("never rewrites the person's own line", () => {
    const edited: Message = { ...asked, content: "changed" };
    const local = [asked];
    expect(mergeStoredMessages(local, [edited], true)).toBe(local);
  });
});
