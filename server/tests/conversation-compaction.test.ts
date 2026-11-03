import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  COMPACT_AT,
  compactedView,
  planCompaction,
  renderTranscript,
  SUMMARY_MESSAGE_ID,
  summaryPrompt,
} from "../src/local-threads/compaction";
import { LocalAgentRunner } from "../src/local-threads/runner";

const SUMMARY = `1. Primary request and intent: compare the roster with the sheet. ${"detail ".repeat(60)}`;

/** A Bot that answers, and remembers what it was sent each time. */
class RecordingAgent extends AbstractAgent {
  sent: Message[][] = [];
  constructor(private readonly reply: string) {
    super({ agentId: "ims" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.sent.push(input.messages);
    const id = `assistant-${crypto.randomUUID()}`;
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: id,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: id,
          delta: this.reply,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: id },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}

function user(content: string, id = `user-${crypto.randomUUID()}`): Message {
  return { id, role: "user", content } as Message;
}

async function turn(
  runner: LocalAgentRunner,
  agent: RecordingAgent,
  messages: Message[],
) {
  agent.threadId = "t1";
  agent.setMessages(messages);
  await new Promise<void>((resolve, reject) =>
    runner
      .run({
        threadId: "t1",
        agent,
        input: {
          threadId: "t1",
          runId: crypto.randomUUID(),
          messages,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
        ownerId: "alice",
      })
      .subscribe({ error: reject, complete: resolve }),
  );
}

/** About `tokens` tokens of plain text. */
const words = (tokens: number) => "word ".repeat(Math.ceil(tokens / 1.5));

describe("deciding when and where to compact", () => {
  const conversation = (sizes: number[]) =>
    sizes.map((size, index) =>
      index % 2 === 0
        ? user(words(size), `u${index}`)
        : ({
            id: `a${index}`,
            role: "assistant",
            content: words(size),
          } as Message),
    );

  test("under 80% of the budget nothing is compacted", () => {
    expect(planCompaction(conversation([1000, 1000]), null, 10_000)).toBeNull();
  });

  test("past it, the earlier part is folded and the cut lands on the person's message", () => {
    const messages = conversation([2000, 2000, 2000, 2000, 1000, 1000]);
    const plan = planCompaction(messages, null, 10_000);
    expect(plan).not.toBeNull();
    expect(plan?.tokens).toBeGreaterThanOrEqual(COMPACT_AT * 10_000);
    expect(messages[plan?.cut ?? 0]?.role).toBe("user");
    expect(plan?.from).toBe(0);
    expect(plan?.cut).toBeGreaterThan(0);
  });

  test("a compacted conversation counts its summary and only what came after it", () => {
    const messages = conversation([4000, 4000, 1000, 1000]);
    const stored = { throughMessageId: "a1", summary: "short summary" };
    expect(planCompaction(messages, stored, 10_000)).toBeNull();
  });

  test("the model is sent the summary and everything after the last message it covers", () => {
    const messages = conversation([10, 10, 10, 10]);
    const view = compactedView(messages, {
      throughMessageId: "a1",
      summary: "the summary",
    });
    expect(view?.map((message) => message.id)).toEqual([
      SUMMARY_MESSAGE_ID,
      "u2",
      "a3",
    ]);
    // A summary of messages that are no longer there does not apply.
    expect(
      compactedView(messages, { throughMessageId: "gone", summary: "x" }),
    ).toBeNull();
  });

  test("the summariser is asked for every section, and sees the person's words", () => {
    const prompt = summaryPrompt(
      "an earlier summary",
      renderTranscript([user("请核对员工花名册", "u0")]),
    );
    for (const section of [
      "Primary request",
      "Errors and fixes",
      "All of the person's messages",
      "Next step",
    ])
      expect(prompt).toContain(section);
    expect(prompt).toContain("请核对员工花名册");
    expect(prompt).toContain("an earlier summary");
  });
});

describe("compacting a conversation in the runner", () => {
  test("the model is sent the summary, and the stored conversation keeps every message", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const prompts: string[] = [];
    runner.useCompaction({
      budgetFor: async () => 10_000,
      defaultBudget: 80_000,
      complete: async (_agentId, prompt) => {
        prompts.push(prompt);
        return SUMMARY;
      },
    });
    const agent = new RecordingAgent(words(1500));

    let messages: Message[] = [];
    for (let index = 0; index < 4; index += 1) {
      messages = [
        ...runner.getThreadMessages("t1", { ownerId: "alice" }),
        user(words(1500), `u${index}`),
      ];
      await turn(runner, agent, messages);
      await runner.compactNow("t1", "ims");
    }

    expect(prompts.length).toBeGreaterThan(0);
    expect(runner.summaryOf("t1")).not.toBeNull();

    // The next call is sent the summary first, and less than the whole conversation.
    const stored = runner.getThreadMessages("t1", { ownerId: "alice" });
    await turn(runner, agent, [...stored, user("Continue.", "u-next")]);
    const lastSent = agent.sent.at(-1) ?? [];
    expect(lastSent[0]?.id).toBe(SUMMARY_MESSAGE_ID);
    expect(lastSent.length).toBeLessThan(stored.length + 1);
    expect(lastSent.at(-1)?.id).toBe("u-next");

    // Every message is kept, in order, and the summary is not one of them.
    const after = runner.getThreadMessages("t1", { ownerId: "alice" });
    expect(after.map((message) => message.id)).toEqual([
      ...stored.map((message) => message.id),
      "u-next",
      expect.any(String),
    ]);
    expect(after.some((message) => message.id === SUMMARY_MESSAGE_ID)).toBe(
      false,
    );
  });

  test("a summary that fails leaves the conversation sent whole", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    runner.useCompaction({
      budgetFor: async () => 4_000,
      defaultBudget: 80_000,
      complete: async () => "",
    });
    const agent = new RecordingAgent(words(1500));
    await turn(runner, agent, [user(words(1500), "u0")]);
    await turn(runner, agent, [
      ...runner.getThreadMessages("t1", { ownerId: "alice" }),
      user(words(1500), "u1"),
    ]);
    await expect(runner.compactNow("t1", "ims")).rejects.toThrow();
    expect(runner.summaryOf("t1")).toBeNull();
  });
});
