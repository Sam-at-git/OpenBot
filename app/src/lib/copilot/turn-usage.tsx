import type { ReactFrontendTool } from "@copilotkit/react-core/v2";
import { createContext, useContext, useEffect, useState } from "react";

type HandlerContext = Parameters<NonNullable<ReactFrontendTool["handler"]>>[1];
type Agent = NonNullable<HandlerContext["agent"]>;

/**
 * The model and tokens each turn used, shown under the Bot's reply.
 *
 * The server (built-in Bots, `server/src/llm/run-usage.ts`) and agent-langgraph send an `openbot.usage` AG-UI CUSTOM
 * event just before a run finishes. The thread store keeps every event of a run, so the same events come back when a
 * conversation is opened again and the line survives a reload.
 */
export const USAGE_EVENT = "openbot.usage";

export type TurnUsage = {
  runId: string | null;
  messageId: string | null;
  model: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

function readUsage(value: unknown): TurnUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const count = (raw: unknown) =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (typeof record.model !== "string" || !record.model) return null;
  return {
    runId: typeof record.runId === "string" ? record.runId : null,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    model: record.model,
    calls: count(record.calls) ?? 1,
    inputTokens: count(record.inputTokens),
    outputTokens: count(record.outputTokens),
  };
}

const number = new Intl.NumberFormat();

/** "deepseek-chat · 12,345 tokens in · 678 out", summed over every report for one reply. */
export function usageLabel(reports: readonly TurnUsage[]): string | undefined {
  if (reports.length === 0) return undefined;
  const models = [...new Set(reports.map((report) => report.model))].join(", ");
  const counted = reports.filter(
    (report) => report.inputTokens !== null || report.outputTokens !== null,
  );
  const calls = reports.reduce((sum, report) => sum + report.calls, 0);
  const steps = calls > 1 ? ` · ${number.format(calls)} model calls` : "";
  if (counted.length === 0) return `${models} · tokens not reported${steps}`;
  const input = counted.reduce(
    (sum, report) => sum + (report.inputTokens ?? 0),
    0,
  );
  const output = counted.reduce(
    (sum, report) => sum + (report.outputTokens ?? 0),
    0,
  );
  return `${models} · ${number.format(input)} tokens in · ${number.format(output)} out${steps}`;
}

/**
 * Listens for usage events on a conversation's agent and returns a label per assistant message id.
 *
 * Call it before the effect that connects the agent, so the events replayed for an opened conversation are heard.
 * A report is kept once however many times it is replayed: a reconnect sends the same events again.
 */
export function useTurnUsage(agent: Agent): ReadonlyMap<string, string> {
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  useEffect(() => {
    const seen = new Set<string>();
    const byMessage = new Map<string, TurnUsage[]>();
    setLabels(new Map());
    const subscription = agent.subscribe?.({
      onCustomEvent: ({ event }) => {
        if (event.name !== USAGE_EVENT) return;
        const usage = readUsage(event.value);
        if (!usage?.messageId) return;
        const key = JSON.stringify(usage);
        if (seen.has(key)) return;
        seen.add(key);
        byMessage.set(usage.messageId, [
          ...(byMessage.get(usage.messageId) ?? []),
          usage,
        ]);
        setLabels(
          new Map(
            [...byMessage].flatMap(([id, reports]) => {
              const label = usageLabel(reports);
              return label ? [[id, label] as const] : [];
            }),
          ),
        );
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent]);
  return labels;
}

const TurnUsageContext = createContext<ReadonlyMap<string, string>>(new Map());

export const TurnUsageProvider = TurnUsageContext.Provider;

/** The usage line for each assistant message id in the conversation on screen, if any. */
export function useTurnUsageLabels(): ReadonlyMap<string, string> {
  return useContext(TurnUsageContext);
}
