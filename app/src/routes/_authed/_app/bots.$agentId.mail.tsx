import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  checkMailboxMutationOptions,
  type Mailbox,
  type MailboxInput,
  mailboxQueryOptions,
  removeMailboxMutationOptions,
  saveMailboxMutationOptions,
} from "@/lib/mailboxes";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/mail")({
  component: MailPage,
});

function MailPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Give this Bot an IMAP mailbox. New mail is copied into its folder on its computer, where it can read it. The mailbox itself is only read: nothing is marked, moved or deleted."
      title="Mail"
    >
      {(agent) => <MailSettings botId={agent.id} />}
    </BotSubpage>
  );
}

const SECURITY: Record<MailboxInput["security"], string> = {
  ssl: "SSL/TLS",
  starttls: "STARTTLS",
  plain: "None",
};

const DEFAULT_PORT: Record<MailboxInput["security"], number> = {
  ssl: 993,
  starttls: 143,
  plain: 143,
};

const INTERVALS = [5, 15, 30, 60, 240, 1440];

function intervalLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes === 60) return "Every hour";
  if (minutes < 1440) return `Every ${minutes / 60} hours`;
  return "Once a day";
}

function blank(): MailboxInput {
  return {
    host: "",
    port: 993,
    security: "ssl",
    username: "",
    folder: "INBOX",
    enabled: true,
    intervalMinutes: 15,
  };
}

function fromMailbox(mailbox: Mailbox): MailboxInput {
  return {
    host: mailbox.host,
    port: mailbox.port,
    security: mailbox.security,
    username: mailbox.username,
    folder: mailbox.folder,
    enabled: mailbox.enabled,
    intervalMinutes: mailbox.intervalMinutes,
  };
}

function MailSettings({ botId }: { botId: string }) {
  const query = useQuery(mailboxQueryOptions(botId));
  const save = useMutation(saveMailboxMutationOptions(queryClient, botId));
  const remove = useMutation(removeMailboxMutationOptions(queryClient, botId));
  const check = useMutation(checkMailboxMutationOptions(queryClient, botId));
  const mailbox = query.data?.mailbox ?? null;
  const folder = query.data?.folder ?? "mail";

  const [draft, setDraft] = useState<MailboxInput>(blank);
  const [password, setPassword] = useState("");
  // The form follows the stored mailbox whenever it loads or changes.
  useEffect(() => {
    setDraft(mailbox ? fromMailbox(mailbox) : blank());
    setPassword("");
  }, [mailbox]);

  const set = <K extends keyof MailboxInput>(key: K, value: MailboxInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const busy = save.isPending || remove.isPending || check.isPending;

  if (query.isPending)
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (query.isError)
    return (
      <p className="text-destructive text-sm" role="alert">
        {query.error.message}
      </p>
    );

  return (
    <div className="grid gap-8">
      <PageSection title="Mailbox">
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              { ...draft, ...(password ? { password } : {}) },
              { onSuccess: () => setPassword("") },
            );
          }}
        >
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field>
              <FieldLabel htmlFor="mail-host">IMAP server</FieldLabel>
              <Input
                autoComplete="off"
                disabled={busy}
                id="mail-host"
                onChange={(event) => set("host", event.target.value)}
                placeholder="imap.qq.com"
                value={draft.host}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mail-port">Port</FieldLabel>
              <Input
                disabled={busy}
                id="mail-port"
                inputMode="numeric"
                onChange={(event) =>
                  set("port", Number(event.target.value.replace(/\D/g, "")) || 0)
                }
                value={String(draft.port)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="mail-security">Security</FieldLabel>
            <Select
              disabled={busy}
              onValueChange={(next) => {
                const security = next as MailboxInput["security"];
                setDraft((current) => ({
                  ...current,
                  security,
                  // Move the port along with it while it is still a standard one.
                  port: Object.values(DEFAULT_PORT).includes(current.port)
                    ? DEFAULT_PORT[security]
                    : current.port,
                }));
              }}
              value={draft.security}
            >
              <SelectTrigger id="mail-security">
                <SelectValue>{SECURITY[draft.security]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(Object.keys(SECURITY) as MailboxInput["security"][]).map(
                    (key) => (
                      <SelectItem key={key} value={key}>
                        {SECURITY[key]}
                      </SelectItem>
                    ),
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="mail-user">User name</FieldLabel>
            <Input
              autoComplete="off"
              disabled={busy}
              id="mail-user"
              onChange={(event) => set("username", event.target.value)}
              placeholder="name@example.com"
              value={draft.username}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mail-password">
              {mailbox ? "New password" : "Password"}
            </FieldLabel>
            <Input
              autoComplete="new-password"
              disabled={busy}
              id="mail-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mailbox ? "Leave empty to keep the saved one" : ""}
              type="password"
              value={password}
            />
            <FieldDescription>
              Many providers want an app password or authorization code here
              rather than your sign-in password (QQ, 163 and Gmail do). It is
              stored encrypted and can't be read back.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="mail-folder">Folder</FieldLabel>
            <Input
              autoComplete="off"
              disabled={busy}
              id="mail-folder"
              onChange={(event) => set("folder", event.target.value)}
              value={draft.folder}
            />
            <FieldDescription>
              The mailbox folder to watch. INBOX is the inbox everywhere.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="mail-interval">Check</FieldLabel>
            <Select
              disabled={busy}
              onValueChange={(next) => set("intervalMinutes", Number(next))}
              value={String(draft.intervalMinutes)}
            >
              <SelectTrigger id="mail-interval">
                <SelectValue>{intervalLabel(draft.intervalMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {INTERVALS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {intervalLabel(minutes)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <label className="flex items-center gap-3 text-sm" htmlFor="mail-on">
            <Switch
              checked={draft.enabled}
              disabled={busy}
              id="mail-on"
              onCheckedChange={(checked) => set("enabled", checked)}
            />
            Check this mailbox on its own
          </label>
          {save.error && (
            <p className="text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} size="sm" type="submit">
              {save.isPending ? "Saving…" : mailbox ? "Save" : "Add mailbox"}
            </Button>
            {mailbox && (
              <Button
                disabled={busy}
                onClick={() => remove.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                Remove mailbox
              </Button>
            )}
          </div>
        </form>
      </PageSection>

      {mailbox && (
        <PageSection
          action={
            <Button
              disabled={busy}
              onClick={() => check.mutate()}
              size="sm"
              variant="outline"
            >
              {check.isPending ? "Checking…" : "Check now"}
            </Button>
          }
          title="Status"
        >
          <div className="grid gap-2 text-sm">
            <p>{statusLine(mailbox)}</p>
            {mailbox.lastStatus === "error" && mailbox.lastError && (
              <p className="text-destructive" role="alert">
                {mailbox.lastError}
              </p>
            )}
            {check.data?.ok && check.data.saved.length > 0 && (
              <ul className="list-disc pl-5 text-muted-foreground">
                {check.data.saved.slice(0, 10).map((item) => (
                  <li key={item.uid}>
                    {item.subject || "(no subject)"} — {item.from}
                  </li>
                ))}
              </ul>
            )}
            {check.error && (
              <p className="text-destructive" role="alert">
                {check.error.message}
              </p>
            )}
            <p className="text-muted-foreground">
              Mail is kept in{" "}
              <Link
                className="underline"
                params={{ agentId: botId }}
                search={{ folder }}
                to="/bots/$agentId/files"
              >
                {folder}/
              </Link>{" "}
              on this Bot's computer: one folder per message, with its text,
              attachments and an index.jsonl of what came in. Ask the Bot to
              read or work through it.
            </p>
          </div>
        </PageSection>
      )}
    </div>
  );
}

function statusLine(mailbox: Mailbox): string {
  if (mailbox.lastStatus === "running") return "Checking now…";
  if (!mailbox.lastRunAt) return "Not checked yet. The first check copies the last 7 days of mail.";
  const when = relativeTime(mailbox.lastRunAt);
  if (mailbox.lastStatus === "error") return `The last check, ${when}, failed:`;
  const count = mailbox.lastNewCount ?? 0;
  const next = mailbox.enabled ? ` Next check ${relativeTime(mailbox.nextRunAt)}.` : "";
  return `Last checked ${when}: ${count === 0 ? "nothing new" : count === 1 ? "1 new message" : `${count} new messages`}.${next}`;
}
