import type { PasswordInvite } from "@openbot/shared/llm";
import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

export const inviteKeys = {
  all: ["invites"] as const,
  list: () => ["invites", "list"] as const,
  check: (code: string) => ["invites", "check", code] as const,
};

/** Admin, People: every invite, used or not. */
export function inviteListQueryOptions() {
  return queryOptions({
    queryKey: inviteKeys.list(),
    queryFn: (): Promise<PasswordInvite[]> =>
      client("/api/admin/invites", "invites", {
        fallback: "Couldn't load invites. Reload the page.",
      }),
  });
}

/**
 * Whether an invite can still create an account, asked before the sign-up form is shown. Needs no session.
 *
 * `bootstrap` means this is the first account: it becomes the admin and keeps what is already in OpenBot. An
 * unknown or used code is an answer (`valid: false`), not a failure.
 */
export type InviteCheck = { valid: boolean; bootstrap: boolean };

export function inviteCheckQueryOptions(code: string) {
  return queryOptions({
    queryKey: inviteKeys.check(code),
    retry: false,
    queryFn: async (): Promise<InviteCheck> => {
      if (code.trim() === "") return { valid: false, bootstrap: false };
      const response = await tryClient(
        `/api/password/invites/${encodeURIComponent(code)}`,
      );
      if (response.status === 404) return { valid: false, bootstrap: false };
      if (!response.ok) {
        throw new Error("Couldn't check this invite. Reload the page.");
      }
      const body = (await response.json()) as Partial<InviteCheck>;
      return {
        valid: body.valid === true,
        bootstrap: body.bootstrap === true,
      };
    },
  });
}

/** The link an admin shares. Built in the browser so it names the address people actually reach OpenBot at. */
export function inviteLink(code: string, origin: string): string {
  return `${origin}/sign-up?invite=${encodeURIComponent(code)}`;
}
