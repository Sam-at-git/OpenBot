import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { lastValueFrom, Observable, toArray } from "rxjs";
import type { PlanLanguageModel } from "../src/agents/plan-model";
import { runUsage, USAGE_EVENT } from "../src/llm/run-usage";

const fakeModel = (
  usages: Array<{ inputTokens: number; outputTokens: number }>,
) =>
  ({
    specificationVersion: "v2",
    provider: "test",
    modelId: "deepseek-chat",
    supportedUrls: {},
    async doGenerate() {
      const usage = usages.shift() ?? { inputTokens: 0, outputTokens: 0 };
      return { usage } as never;
    },
    async doStream() {
      throw new Error("not used");
    },
  }) as unknown as PlanLanguageModel;

describe("runUsage", () => {
  test("adds one usage event, summed over the run's model calls, right before RUN_FINISHED", async () => {
    const usage = runUsage(
      fakeModel([
        { inputTokens: 1000, outputTokens: 20 },
        { inputTokens: 1500, outputTokens: 30 },
      ]),
    );
    const run = new Observable<BaseEvent>((subscriber) => {
      void (async () => {
        await usage.model.doGenerate({} as never);
        subscriber.next({
          type: "TEXT_MESSAGE_START",
          messageId: "m1",
        } as BaseEvent);
        await usage.model.doGenerate({} as never);
        subscriber.next({ type: "RUN_FINISHED", runId: "r1" } as BaseEvent);
        subscriber.complete();
      })();
    });
    const events = await lastValueFrom(usage.observe(run).pipe(toArray()));
    expect(events.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
    expect(events[1]).toMatchObject({
      name: USAGE_EVENT,
      value: {
        runId: "r1",
        messageId: "m1",
        model: "deepseek-chat",
        calls: 2,
        inputTokens: 2500,
        outputTokens: 50,
      },
    });
  });

  test("a run with no model call adds nothing", async () => {
    const usage = runUsage(fakeModel([]));
    const run = new Observable<BaseEvent>((subscriber) => {
      subscriber.next({ type: "RUN_FINISHED", runId: "r2" } as BaseEvent);
      subscriber.complete();
    });
    const events = await lastValueFrom(usage.observe(run).pipe(toArray()));
    expect(events.map((event) => event.type)).toEqual(["RUN_FINISHED"]);
  });
});
