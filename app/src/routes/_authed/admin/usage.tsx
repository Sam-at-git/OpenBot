import type { LlmUsageReport, LlmUsageRow } from "@openbot/shared/llm";
import { IconChartBar } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LLM_USAGE_DAYS,
  type LlmUsageDays,
  llmUsageQueryOptions,
} from "@/lib/llm/queries";

export const Route = createFileRoute("/_authed/admin/usage")({
  component: UsagePage,
});

const RANGE_LABELS: Record<string, string> = Object.fromEntries(
  LLM_USAGE_DAYS.map((days) => [String(days), `Last ${days} days`]),
);

const count = (value: number) => value.toLocaleString();
const money = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** `YYYY-MM-DD` as a short local date, read as that calendar day wherever the browser is. */
function dayLabel(key: string): string {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function isUsageDays(value: number): value is LlmUsageDays {
  return (LLM_USAGE_DAYS as readonly number[]).includes(value);
}

/**
 * Admin, Usage: what model calls used, by day, model, Bot, person and purpose. Cost is an estimate from the prices
 * an admin entered on Admin, Models.
 */
function UsagePage() {
  const [days, setDays] = useState<LlmUsageDays>(30);
  const report = useQuery(llmUsageQueryOptions(days));

  return (
    <PageShell
      action={
        <Select
          items={RANGE_LABELS}
          onValueChange={(value) => {
            const next = Number(value);
            if (isUsageDays(next)) setDays(next);
          }}
          value={String(days)}
        >
          <SelectTrigger aria-label="Range" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {LLM_USAGE_DAYS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {RANGE_LABELS[String(option)]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      }
      description="See how many model calls OpenBot made and how many tokens they used. Costs are estimated from the prices set on Models."
      title="Usage"
    >
      {report.isPending ? null : report.error ? (
        <p className="text-destructive text-sm" role="alert">
          {report.error.message}
        </p>
      ) : report.data.totals.requests === 0 ? (
        <PageEmpty icon={IconChartBar} title="No model calls yet">
          Calls appear here once a Bot answers or OpenBot uses a model in the
          background.
        </PageEmpty>
      ) : (
        <UsageReport report={report.data} />
      )}
    </PageShell>
  );
}

function UsageReport({ report }: { report: LlmUsageReport }) {
  const { totals } = report;
  return (
    <>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Requests" value={count(totals.requests)} />
        <Stat label="Input tokens" value={count(totals.inputTokens)} />
        <Stat label="Output tokens" value={count(totals.outputTokens)} />
        <Stat
          label="Estimated cost"
          value={totals.cost === null ? "No prices set" : money(totals.cost)}
        />
      </dl>
      <PageSection title="Tokens per day">
        <DayChart rows={report.byDay} />
      </PageSection>
      <UsageTable rows={report.byModel} title="By model" />
      <UsageTable rows={report.byBot} title="By Bot" />
      <UsageTable rows={report.byPerson} title="By person" />
      <UsageTable rows={report.byPurpose} title="By purpose" />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="mt-1 font-semibold text-lg tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Input and output tokens per day, stacked. Plain SVG: one column per day, scaled to the busiest day. Each column
 * carries its numbers as a tooltip, and the chart as a whole has a text summary for screen readers.
 */
function DayChart({ rows }: { rows: LlmUsageRow[] }) {
  const peak = Math.max(
    1,
    ...rows.map((row) => row.inputTokens + row.outputTokens),
  );
  const slot = 10;
  const bar = 7;
  const height = 100;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const summary =
    first && last
      ? `Tokens per day from ${dayLabel(first.key)} to ${dayLabel(last.key)}. The busiest day used ${count(peak)} tokens.`
      : "Tokens per day.";

  return (
    <figure className="mt-4">
      <div className="flex items-baseline justify-between text-muted-foreground text-xs">
        <span>{count(peak)} tokens</span>
      </div>
      <svg
        aria-label={summary}
        className="mt-1 h-40 w-full"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${Math.max(rows.length, 1) * slot} ${height}`}
      >
        <title>{summary}</title>
        {rows.map((row, index) => {
          const x = index * slot + (slot - bar) / 2;
          const inputHeight = (row.inputTokens / peak) * height;
          const outputHeight = (row.outputTokens / peak) * height;
          return (
            <g key={row.key}>
              <title>
                {`${dayLabel(row.key)}: ${count(row.inputTokens)} input and ${count(row.outputTokens)} output tokens`}
              </title>
              <rect
                className="fill-primary"
                height={inputHeight}
                width={bar}
                x={x}
                y={height - inputHeight}
              />
              <rect
                className="fill-primary/40"
                height={outputHeight}
                width={bar}
                x={x}
                y={height - inputHeight - outputHeight}
              />
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-xs">
        <span>{first ? dayLabel(first.key) : null}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-primary" />
            Input
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-primary/40" />
            Output
          </span>
        </span>
        <span>{last ? dayLabel(last.key) : null}</span>
      </figcaption>
    </figure>
  );
}

/**
 * One breakdown as a table. A report is read across in columns, so this is a table and not rows of Items, the same
 * exception the audit log makes.
 */
function UsageTable({ title, rows }: { title: string; rows: LlmUsageRow[] }) {
  if (rows.length === 0) return null;
  return (
    <PageSection title={title}>
      <Table containerClassName="mt-4">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Input tokens</TableHead>
            <TableHead className="text-right">Output tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key || row.label}>
              <TableCell className="max-w-56 truncate">{row.label}</TableCell>
              <TableCell className="text-right tabular-nums">
                {count(row.requests)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(row.inputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(row.outputTokens)}
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">
                {row.cost === null ? "No price" : money(row.cost)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </PageSection>
  );
}
