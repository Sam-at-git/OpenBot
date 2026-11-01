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
import { LocalAgentRunner } from "../src/local-threads/runner";

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
      local: { dbPath: "/data/threads.sqlite" },
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
