import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/** A Bot's IMAP mailbox as its owner sees it. The password is never sent back, only that one is set. */
export type Mailbox = {
  id: string;
  agentId: string;
  host: string;
  port: number;
  security: "ssl" | "starttls" | "plain";
  username: string;
  folder: string;
  enabled: boolean;
  intervalMinutes: number;
  hasPassword: true;
  lastRunAt: string | null;
  lastStatus: "idle" | "running" | "succeeded" | "error";
  lastError: string | null;
  lastNewCount: number | null;
  nextRunAt: string;
};

export type MailboxInput = Omit<
  Mailbox,
  | "id"
  | "agentId"
  | "hasPassword"
  | "lastRunAt"
  | "lastStatus"
  | "lastError"
  | "lastNewCount"
  | "nextRunAt"
> & { password?: string };

export type MailCheckResult =
  | {
      ok: true;
      newCount: number;
      remaining: number;
      saved: { uid: number; dir: string; subject: string; from: string }[];
    }
  | { ok: false; error: string };

export const mailboxKeys = {
  of: (agentId: string) => ["mailbox", agentId] as const,
};

const path = (agentId: string) =>
  `/api/mailboxes/${encodeURIComponent(agentId)}`;

/** The person's own mailbox for this Bot, and the folder its mail lands in on the Bot's computer. */
export function mailboxQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: mailboxKeys.of(agentId),
    queryFn: async (): Promise<{ mailbox: Mailbox | null; folder: string }> => {
      const response = await client(path(agentId), {
        fallback: "Couldn't load the mail settings.",
      });
      return response.json();
    },
  });
}

export function saveMailboxMutationOptions(
  queryClient: QueryClient,
  agentId: string,
) {
  return mutationOptions({
    mutationFn: (input: MailboxInput) =>
      client<Mailbox>(path(agentId), "mailbox", {
        method: "PUT",
        body: input,
        fallback: "Couldn't save the mail settings.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: mailboxKeys.of(agentId) }),
  });
}

export function removeMailboxMutationOptions(
  queryClient: QueryClient,
  agentId: string,
) {
  return mutationOptions({
    mutationFn: async () => {
      await client(path(agentId), {
        method: "DELETE",
        fallback: "Couldn't remove the mailbox.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: mailboxKeys.of(agentId) }),
  });
}

/** Check now: waits for the check, which can take a minute or two on a first run. */
export function checkMailboxMutationOptions(
  queryClient: QueryClient,
  agentId: string,
) {
  return mutationOptions({
    mutationFn: () =>
      client<MailCheckResult>(`${path(agentId)}/check`, "result", {
        method: "POST",
        fallback: "Couldn't check the mailbox.",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mailboxKeys.of(agentId) }),
  });
}
