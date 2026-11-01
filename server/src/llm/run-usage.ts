/**
 * The model and tokens one turn of a built-in Bot used, sent to the browser as an `openbot.usage` AG-UI event just
 * before the run finishes, so the conversation can show it under the reply. A Bot that agent-langgraph runs sends
 * the same event itself.
 *
 * The counts come from a second {@link countingUsage} wrapped around the admin's chosen model. The Bot object is
 * built for one request, and the totals are reset when a run starts, so they belong to that run.
 */
import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { PlanLanguageModel } from "../agents/plan-model";
import { countingUsage } from "./model";

export const USAGE_EVENT = "openbot.usage";

export type RunUsageValue = {
  runId: string | null;
  /** The last assistant message that carried text, where the browser shows the line. */
  messageId: string | null;
  model: string;
  /** Model calls in the run: a tool loop calls the model once per step. */
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

export function runUsage(model: PlanLanguageModel) {
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const counted = countingUsage(model, (usage) => {
    totals.calls += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
  });

  /** Passes the run's events through, adding the usage event right before RUN_FINISHED. */
  const observe = (stream: Observable<BaseEvent>): Observable<BaseEvent> =>
    new Observable<BaseEvent>((subscriber) => {
      totals.calls = 0;
      totals.inputTokens = 0;
      totals.outputTokens = 0;
      let lastTextMessageId: string | null = null;
      const subscription = stream.subscribe({
        next(event) {
          const record = event as BaseEvent & {
            messageId?: string;
            runId?: string;
          };
          if (
            (record.type === "TEXT_MESSAGE_START" ||
              record.type === "TEXT_MESSAGE_CONTENT" ||
              record.type === "TEXT_MESSAGE_CHUNK") &&
            typeof record.messageId === "string"
          )
            lastTextMessageId = record.messageId;
          if (record.type === "RUN_FINISHED" && totals.calls > 0) {
            const value: RunUsageValue = {
              runId: record.runId ?? null,
              messageId: lastTextMessageId,
              model: model.modelId,
              calls: totals.calls,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
            };
            subscriber.next({
              type: "CUSTOM",
              name: USAGE_EVENT,
              value,
            } as BaseEvent);
          }
          subscriber.next(event);
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => subscription.unsubscribe();
    });

  return { model: counted, observe };
}
