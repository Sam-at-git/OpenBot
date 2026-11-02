import { describe, expect, test } from "bun:test";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import {
  managedModelHeaders,
  readManagedModel,
} from "@openbot/shared/managed-model";
import { lastValueFrom, toArray } from "rxjs";
import { isManagedEndpoint } from "../src/copilot";

describe("the model handed to a Bot in its own container", () => {
  test("survives the trip through request headers", () => {
    const chosen = {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
    };
    expect(readManagedModel(new Headers(managedModelHeaders(chosen)))).toEqual(
      chosen,
    );
    const keyless = { ...chosen, apiKey: null, model: "qwen3:模型" };
    expect(readManagedModel(new Headers(managedModelHeaders(keyless)))).toEqual(
      keyless,
    );
  });

  test("is ignored when missing or malformed", () => {
    expect(readManagedModel(new Headers())).toBeUndefined();
    expect(
      readManagedModel(
        new Headers(
          managedModelHeaders({
            baseUrl: "file:///etc",
            apiKey: null,
            model: "m",
          }),
        ),
      ),
    ).toBeUndefined();
  });

  test("is sent only to OpenBot's own endpoint, holding its token", () => {
    const environment = {
      MANAGED_AGENT_TOKEN: "managed",
      MANAGED_AGENT_AG_UI_URL: "http://agent-langgraph:4201/ag-ui",
    };
    const ours = {
      endpoint: "http://agent-langgraph:4201/ag-ui/",
      headers: { "x-openbot-agent-token": "managed" },
    };
    expect(isManagedEndpoint(ours, environment)).toBe(true);
    expect(
      isManagedEndpoint(
        { ...ours, endpoint: "https://agent.example.com/ag-ui" },
        environment,
      ),
    ).toBe(false);
    expect(isManagedEndpoint({ ...ours, headers: {} }, environment)).toBe(
      false,
    );
    expect(
      isManagedEndpoint(ours, { ...environment, MANAGED_AGENT_TOKEN: "" }),
    ).toBe(false);
  });
});

/** An OpenAI-compatible endpoint that answers every call with one word and remembers what it was asked. */
function provider(word: string) {
  const seen: { model: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      seen.push({
        model: body.model,
        authorization: request.headers.get("authorization"),
      });
      const base = {
        id: "chat",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
      };
      const chunks = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: word },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, seen, url: `${server.url}v1` };
}

for (const framework of ["langgraph", "bot"]) {
  test(`${framework}: answers with the chosen model when OpenBot sends one, and its own otherwise`, async () => {
    const started = provider("started");
    const chosen = provider("chosen");
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const child = Bun.spawn(
      [Bun.argv[0], "--no-env-file", `agent-${framework}/src/index.ts`],
      {
        cwd: `${import.meta.dir}/../..`,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PORT: String(port),
          MANAGED_AGENT_TOKEN: "synthetic-managed-token",
          BOT_PROVIDER: "openai",
          BOT_MODEL: "gpt-4.1-mini",
          OPENAI_API_KEY: "started-key",
          OPENAI_BASE_URL: started.url,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const endpoint = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (Date.now() < deadline) {
        ready = await fetch(`${endpoint}/health`).then(
          (response) => response.ok,
          () => false,
        );
        if (ready) break;
        await Bun.sleep(50);
      }
      expect(ready).toBe(true);

      const answer = async (headers: Record<string, string>) => {
        const remote = new HttpAgent({
          url: `${endpoint}/ag-ui`,
          headers: {
            "x-openbot-agent-token": "synthetic-managed-token",
            ...headers,
          },
        });
        const input: RunAgentInput = {
          threadId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          messages: [{ id: "user", role: "user", content: "Hello" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        };
        const events = await lastValueFrom(remote.run(input).pipe(toArray()));
        return events
          .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
          .map((event) => (event as { delta: string }).delta)
          .join("");
      };

      expect(
        await answer(
          managedModelHeaders({
            baseUrl: chosen.url,
            apiKey: "chosen-key",
            model: "deepseek-chat",
          }),
        ),
      ).toBe("chosen");
      expect(chosen.seen).toEqual([
        { model: "deepseek-chat", authorization: "Bearer chosen-key" },
      ]);
      expect(started.seen).toEqual([]);

      expect(await answer({})).toBe("started");
      expect(started.seen).toEqual([
        { model: "gpt-4.1-mini", authorization: "Bearer started-key" },
      ]);
    } finally {
      child.kill();
      await child.exited;
      await started.server.stop(true);
      await chosen.server.stop(true);
    }
  }, 30_000);
}
