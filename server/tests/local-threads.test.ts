import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { loadConfig } from "../src/config";
import { createLocalThreadsClient } from "../src/local-threads/client";
import {
  eventsForReplay,
  LocalAgentRunner,
  pageStart,
  withEarlierHistory,
} from "../src/local-threads/runner";

/** A Bot that says one thing, as a real model's stream would: started, a text message, finished. */
class SayingAgent extends AbstractAgent {
  constructor(
    private readonly reply: string,
    private readonly replyId = `assistant-${crypto.randomUUID()}`,
  ) {
    super({ agentId: "general" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.replyId,
        role: "assistant",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: this.replyId,
        delta: this.reply,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.replyId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

function user(content: string, id = `user-${crypto.randomUUID()}`): Message {
  return { id, role: "user", content } as Message;
}

function inputFor(
  threadId: string,
  messages: Message[],
  runId = crypto.randomUUID(),
): RunAgentInput {
  return {
    threadId,
    runId,
    messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

/** Run one turn to completion and return what it streamed. */
async function runTurn(
  runner: LocalAgentRunner,
  options: {
    threadId: string;
    ownerId: string;
    messages: Message[];
    reply: string;
    persistedInputMessages?: Message[];
    runId?: string;
  },
): Promise<BaseEvent[]> {
  const agent = new SayingAgent(options.reply);
  agent.threadId = options.threadId;
  agent.setMessages(options.messages);
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    runner
      .run({
        threadId: options.threadId,
        agent,
        input: inputFor(options.threadId, options.messages, options.runId),
        ownerId: options.ownerId,
        ...(options.persistedInputMessages
          ? { persistedInputMessages: options.persistedInputMessages }
          : {}),
      })
      .subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: resolve,
      });
  });
  return events;
}

function textOf(message: Message | undefined): unknown {
  return message && "content" in message ? message.content : undefined;
}

describe("local conversations: configuration", () => {
  const base = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENBOT_SINGLE_USER: "true",
  };

  test("OPENBOT_THREADS=local starts without any Intelligence setting", () => {
    const config = loadConfig({
      ...base,
      OPENBOT_THREADS: "local",
      OPENBOT_THREADS_DB: "/data/threads.sqlite",
    });
    expect(config.runtime).toEqual({
      mode: "local",
      durableHistory: true,
      local: {
        dbPath: "/data/threads.sqlite",
        learningDbPath: "/data/openbot-learning.sqlite",
      },
    });
  });

  test("local mode ignores Intelligence settings that are still in the environment", () => {
    const config = loadConfig({
      ...base,
      OPENBOT_THREADS: "local",
      INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
      INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
      CPK_INTELLIGENCE_API_KEY: "cpk-should-not-be-used",
    });
    expect(config.runtime.mode).toBe("local");
    expect(config.runtime.intelligence).toBeUndefined();
  });

  test("an unknown OPENBOT_THREADS value stops start-up and names the variable", () => {
    expect(() => loadConfig({ ...base, OPENBOT_THREADS: "cloud" })).toThrow(
      "OPENBOT_THREADS",
    );
  });

  test("without OPENBOT_THREADS, Intelligence is still required", () => {
    expect(() => loadConfig(base)).toThrow(
      "CopilotKit Intelligence is required",
    );
  });
});

describe("local conversations: the runner", () => {
  test("a finished run is kept: its messages and its thread", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const question = user("What is two plus two?");
    await runTurn(runner, {
      threadId: "t1",
      ownerId: "alice",
      messages: [question],
      reply: "Four.",
    });

    const messages = runner.getThreadMessages("t1", { ownerId: "alice" });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(textOf(messages[1])).toBe("Four.");
    expect(runner.listThreads({ ownerId: "alice" }).map((t) => t.id)).toEqual([
      "t1",
    ]);
    expect(await runner.isRunning({ threadId: "t1", ownerId: "alice" })).toBe(
      false,
    );
  });

  test("survives a restart: a second runner on the same file reads the same thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-threads-"));
    const dbPath = join(directory, "nested", "threads.sqlite");
    try {
      const first = new LocalAgentRunner({ dbPath });
      await runTurn(first, {
        threadId: "t1",
        ownerId: "alice",
        messages: [user("Remember the number seven.")],
        reply: "Noted.",
      });
      first.close();

      const second = new LocalAgentRunner({ dbPath });
      const messages = second.getThreadMessages("t1", { ownerId: "alice" });
      expect(textOf(messages.at(-1))).toBe("Noted.");
      // Replayed for a reconnecting browser, too.
      const replayed: BaseEvent[] = [];
      await new Promise<void>((resolve) =>
        second
          .connect({ threadId: "t1", ownerId: "alice" })
          .subscribe({ next: (e) => replayed.push(e), complete: resolve }),
      );
      expect(replayed.some((e) => e.type === EventType.RUN_FINISHED)).toBe(
        true,
      );
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a thread belongs to the person whose run created it", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    await runTurn(runner, {
      threadId: "t1",
      ownerId: "alice",
      messages: [user("Private question")],
      reply: "Private answer.",
    });

    expect(runner.getThreadMessages("t1", { ownerId: "bob" })).toEqual([]);
    expect(runner.listThreads({ ownerId: "bob" })).toEqual([]);
    expect(runner.isThreadAccessible("t1", { ownerId: "bob" })).toBe(false);
    expect(() =>
      runner.run({
        threadId: "t1",
        agent: new SayingAgent("no"),
        input: inputFor("t1", [user("Let me in")]),
        ownerId: "bob",
      }),
    ).toThrow();
  });

  test("keeps only what persistedInputMessages names, never the whole prompt", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const shown = user("Asked by the Research Bot", "shown");
    const prompt = [
      user("A long internal instruction the person must not see", "prompt"),
    ];
    await runTurn(runner, {
      threadId: "t1",
      ownerId: "alice",
      messages: prompt,
      reply: "Here is what I found.",
      persistedInputMessages: [shown],
    });

    const messages = runner.getThreadMessages("t1", { ownerId: "alice" });
    expect(messages.map((message) => message.id)).not.toContain("prompt");
    expect(messages[0]?.id).toBe("shown");
    expect(textOf(messages.at(-1))).toBe("Here is what I found.");

    const started = runner
      .getThreadEvents("t1", { ownerId: "alice" })
      .find((event) => event.type === EventType.RUN_STARTED) as
      | { input?: { messages?: Message[] } }
      | undefined;
    expect(started?.input?.messages?.map((message) => message.id)).toEqual([
      "shown",
    ]);
  });

  test("a held lock refuses another run in the conversation until it is given back", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    runner.acquireLock({ threadId: "t1", runId: "routine", ttlSeconds: 60 });

    expect(() =>
      runner.acquireLock({ threadId: "t1", runId: "other", ttlSeconds: 60 }),
    ).toThrow(expect.objectContaining({ status: 409 }));
    expect(() =>
      runner.run({
        threadId: "t1",
        agent: new SayingAgent("no"),
        input: inputFor("t1", [user("Me first")], "person"),
        ownerId: "alice",
      }),
    ).toThrow();

    // The run that holds the lock may run.
    await runTurn(runner, {
      threadId: "t1",
      ownerId: "alice",
      messages: [user("Nightly summary")],
      reply: "Done.",
      runId: "routine",
    });
    expect(() =>
      runner.renewLock({ threadId: "t1", runId: "other", ttlSeconds: 60 }),
    ).toThrow(expect.objectContaining({ status: 409 }));
    runner.releaseLock({ threadId: "t1", runId: "routine" });
    runner.acquireLock({ threadId: "t1", runId: "other", ttlSeconds: 60 });
  });
});

describe("local conversations: the client headless turns use", () => {
  test("history comes back in the platform's shape, tool calls included", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const client = createLocalThreadsClient(runner);
    const agent = new SayingAgent("Checked.");
    agent.threadId = "t1";
    const withToolCall: Message[] = [
      user("Check the weather", "u1"),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
        ],
      } as Message,
      { id: "t1", role: "tool", toolCallId: "call-1", content: "Sunny" },
    ];
    agent.setMessages(withToolCall);
    await new Promise<void>((resolve, reject) =>
      runner
        .run({
          threadId: "t1",
          agent,
          input: inputFor("t1", withToolCall),
          ownerId: "alice",
        })
        .subscribe({ error: reject, complete: resolve }),
    );

    const { messages } = await client.getThreadMessages({
      threadId: "t1",
      userId: "alice",
    });
    expect(messages[1]?.toolCalls).toEqual([
      { id: "call-1", name: "weather", args: '{"city":"Paris"}' },
    ]);
    expect(messages[2]?.toolCallId).toBe("call-1");
  });

  test("getThread answers 404 for a thread this person does not have", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const client = createLocalThreadsClient(runner);
    await expect(
      client.getThread({ threadId: "nope", userId: "alice" }),
    ).rejects.toMatchObject({ status: 404 });
    await client.getOrCreateThread({
      threadId: "t1",
      userId: "alice",
      agentId: "general",
    });
    await expect(
      client.getThread({ threadId: "t1", userId: "alice" }),
    ).resolves.toBeDefined();
    await expect(
      client.getThread({ threadId: "t1", userId: "bob" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("a lock conflict is a 409, which the thread lock reads as 'not now'", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const client = createLocalThreadsClient(runner);
    const first = {
      threadId: "t1",
      runId: "r1",
      userId: "alice",
      agentId: "general",
    };
    await client.ɵacquireThreadLock(first);
    await expect(
      client.ɵacquireThreadLock({ ...first, runId: "r2" }),
    ).rejects.toMatchObject({ status: 409 });
    await client.ɵcleanupThreadLock({ threadId: "t1", runId: "r1" });
    await expect(
      client.ɵacquireThreadLock({ ...first, runId: "r2" }),
    ).resolves.toMatchObject({ runId: "r2" });
  });
});

/**
 * A Bot that starts a reply and never finishes it, the way a run looks to a process that is about to
 * be restarted: what it had said is the only trace left of it.
 */
class HangingAgent extends AbstractAgent {
  constructor(private readonly said: string) {
    super({ agentId: "general" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "reply-1",
        role: "assistant",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "reply-1",
        delta: this.said,
      } as BaseEvent);
      // Never ends.
    });
  }
}

function startHanging(
  runner: LocalAgentRunner,
  threadId: string,
  messages: Message[],
  said: string,
) {
  const agent = new HangingAgent(said);
  agent.threadId = threadId;
  agent.setMessages(messages);
  runner
    .run({
      threadId,
      agent,
      input: inputFor(threadId, messages),
      ownerId: "alice",
    })
    .subscribe({});
}

describe("local conversations: nothing a person sent is lost", () => {
  test("the message is kept from the moment the run starts", () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    const question = user("Put the manuals into ims-manual.");
    startHanging(runner, "t1", [question], "Working on it");

    const messages = runner.getThreadMessages("t1", { ownerId: "alice" });
    expect(messages.map((message) => message.id)).toContain(question.id);
  });

  test("a restart mid-reply keeps the message and what was said, and closes the run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-threads-"));
    const dbPath = join(directory, "threads.sqlite");
    try {
      const first = new LocalAgentRunner({ dbPath });
      await runTurn(first, {
        threadId: "t1",
        ownerId: "alice",
        messages: [user("Remember the number seven.", "u1")],
        reply: "Noted.",
      });
      const question = user("Now check the roster.", "u2");
      startHanging(
        first,
        "t1",
        [...first.getThreadMessages("t1", { ownerId: "alice" }), question],
        "Opening the roster",
      );
      // Past one checkpoint, then the process is gone without finishing anything.
      await Bun.sleep(1_300);
      first.close();

      const second = new LocalAgentRunner({ dbPath });
      const messages = second.getThreadMessages("t1", { ownerId: "alice" });
      expect(messages.map((message) => message.id)).toEqual([
        "u1",
        expect.any(String),
        "u2",
        "reply-1",
      ]);
      expect(textOf(messages.at(-1))).toBe("Opening the roster");
      expect(await second.isRunning({ threadId: "t1", ownerId: "alice" })).toBe(
        false,
      );

      // A reconnecting browser sees the run end, and why.
      const replayed: BaseEvent[] = [];
      await new Promise<void>((resolve) =>
        second
          .connect({ threadId: "t1", ownerId: "alice" })
          .subscribe({ next: (e) => replayed.push(e), complete: resolve }),
      );
      expect(JSON.stringify(replayed)).toContain("OpenBot restarted");

      // And the conversation carries on.
      await runTurn(second, {
        threadId: "t1",
        ownerId: "alice",
        messages: [...messages, user("Continue.", "u3")],
        reply: "Continuing.",
      });
      expect(
        second
          .getThreadMessages("t1", { ownerId: "alice" })
          .map((message) => message.id)
          .slice(0, 5),
      ).toEqual(["u1", expect.any(String), "u2", "reply-1", "u3"]);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a browser reconnecting mid-run sees each event once", async () => {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    startHanging(runner, "t1", [user("Hello.", "u1")], "Hi");
    await Bun.sleep(1_200);
    const replayed: BaseEvent[] = [];
    const subscription = runner
      .connect({ threadId: "t1", ownerId: "alice" })
      .subscribe({ next: (e) => replayed.push(e) });
    await Bun.sleep(20);
    subscription.unsubscribe();
    expect(
      replayed.filter((e) => e.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    expect(
      replayed.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toHaveLength(1);
  });
});

describe("replaying a conversation's history", () => {
  test("drops each run's tools and forwarded props, and keeps its messages and state", () => {
    const tools = [
      {
        name: "computer_run_command",
        description: "x".repeat(10_000),
        parameters: {},
      },
    ];
    const started = {
      type: EventType.RUN_STARTED,
      threadId: "t1",
      runId: "r1",
      input: {
        threadId: "t1",
        runId: "r1",
        state: { step: 2 },
        messages: [{ id: "m1", role: "user", content: "请分析 2026 目录" }],
        tools,
        context: [{ description: "page", value: "y".repeat(1_000) }],
        forwardedProps: { model: "z".repeat(1_000) },
      },
    };
    const text = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a1",
      delta: "好的",
    };

    const [replayed, untouched] = eventsForReplay([
      started,
      text,
    ] as never) as never as [typeof started, typeof text];

    expect(replayed.input.messages).toEqual(started.input.messages);
    expect(replayed.input.state).toEqual({ step: 2 });
    expect(replayed.input.tools).toEqual([]);
    expect(replayed.input.context).toEqual([]);
    expect(replayed.input.forwardedProps).toEqual({});
    expect(replayed.runId).toBe("r1");
    expect(untouched).toBe(text);
    // What is stored is not changed.
    expect(started.input.tools).toBe(tools);
  });
});

describe("opening a long conversation a page at a time", () => {
  /** A conversation of `turns` turns, each the person's line and the Bot's reply, sent in full. */
  async function conversation(turns: number) {
    const runner = new LocalAgentRunner({ dbPath: ":memory:" });
    for (let index = 0; index < turns; index += 1) {
      const held = runner.getThreadMessages("t1", { ownerId: "alice" });
      await runTurn(runner, {
        threadId: "t1",
        ownerId: "alice",
        messages: [...held, user(`question ${index}`, `u${index}`)],
        reply: `answer ${index}`,
      });
    }
    return runner;
  }

  async function replay(runner: LocalAgentRunner, tail: boolean) {
    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) =>
      runner
        .connect({
          threadId: "t1",
          ownerId: "alice",
          ...(tail ? { headers: { "x-openbot-history": "tail" } } : {}),
        })
        .subscribe({ next: (e) => events.push(e), complete: resolve }),
    );
    return events.filter((e) => e.type === EventType.RUN_STARTED).length;
  }

  test("a page starts at one of the person's messages", () => {
    const messages = [
      user("a"),
      { id: "b", role: "assistant", content: "b" },
      user("c"),
      { id: "d", role: "assistant", content: "d" },
      { id: "e", role: "tool", content: "e", toolCallId: "x" },
    ] as Message[];
    expect(pageStart(messages, 5, 2)).toBe(2);
    expect(pageStart(messages, 5, 3)).toBe(2);
    expect(pageStart(messages, 5, 9)).toBe(0);
  });

  test("pages back through the stored messages, newest first", async () => {
    const runner = await conversation(15);
    const latest = runner.messagesPage(
      "t1",
      { ownerId: "alice" },
      { limit: 20 },
    );
    expect(latest.messages).toHaveLength(20);
    expect(latest.messages[0]?.id).toBe("u5");
    expect(latest.hasMore).toBe(true);

    const older = runner.messagesPage(
      "t1",
      { ownerId: "alice" },
      { before: "u5", limit: 20 },
    );
    expect(older.messages.map((m) => m.id).at(0)).toBe("u0");
    expect(older.messages).toHaveLength(10);
    expect(older.hasMore).toBe(false);

    // Nobody else's, and never a page for an id the thread does not hold.
    expect(
      runner.messagesPage("t1", { ownerId: "bob" }, { limit: 20 }).messages,
    ).toEqual([]);
    expect(
      runner.messagesPage(
        "t1",
        { ownerId: "alice" },
        { before: "nope", limit: 20 },
      ).messages,
    ).toEqual([]);
  });

  test("a conversation page is replayed only its latest runs; anything else, all of them", async () => {
    const runner = await conversation(15);
    expect(await replay(runner, false)).toBe(15);
    const tail = await replay(runner, true);
    expect(tail).toBeGreaterThanOrEqual(10);
    expect(tail).toBeLessThan(15);
  });

  test("a turn sent with only the latest messages keeps the whole conversation", async () => {
    const runner = await conversation(15);
    const held = runner.getThreadMessages("t1", { ownerId: "alice" });
    await runTurn(runner, {
      threadId: "t1",
      ownerId: "alice",
      messages: [...held.slice(-4), user("question 15", "u15")],
      reply: "answer 15",
    });
    const after = runner.getThreadMessages("t1", { ownerId: "alice" });
    expect(after).toHaveLength(32);
    expect(after[0]?.id).toBe("u0");
    expect(after.at(-2)?.id).toBe("u15");
  });

  test("restores only what comes before the first message the browser holds", () => {
    const stored = [user("a", "a"), user("b", "b"), user("c", "c")];
    expect(
      withEarlierHistory(stored, [user("c", "c"), user("d", "d")])?.map(
        (m) => m.id,
      ),
    ).toEqual(["a", "b", "c", "d"]);
    // Holding it all, or holding nothing stored: unchanged.
    expect(withEarlierHistory(stored, stored)).toBeNull();
    expect(withEarlierHistory(stored, [user("x", "x")])).toBeNull();
    // A later message the browser dropped is not put back.
    expect(
      withEarlierHistory(stored, [user("b", "b")])?.map((m) => m.id),
    ).toEqual(["a", "b"]);
  });
});
