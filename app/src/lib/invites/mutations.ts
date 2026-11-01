import type { PasswordInvite } from "@openbot/shared/llm";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { refreshCurrentUser } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import { inviteKeys } from "./queries";

const invalidateInvites = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: inviteKeys.all });

export function createInviteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<PasswordInvite> =>
      client("/api/admin/invites", "invite", {
        method: "POST",
        body: {},
        fallback: "Couldn't create an invite. Try again.",
      }),
    onSuccess: () => invalidateInvites(queryClient),
  });
}

export function deleteInviteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (code: string): Promise<void> => {
      await client(`/api/admin/invites/${encodeURIComponent(code)}`, {
        method: "DELETE",
        fallback: "Couldn't delete this invite. Try again.",
      });
    },
    onSuccess: () => invalidateInvites(queryClient),
  });
}

export type PasswordSignUpInput = {
  invite: string;
  name: string;
  email: string;
  password: string;
};

/**
 * Create an account with an invite. The server sets the session cookie, so success refetches the current user and
 * the invite's own check (it is used now).
 */
export function passwordSignUpMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: PasswordSignUpInput): Promise<void> => {
      await client("/api/password/sign-up", {
        method: "POST",
        body: input,
        fallback: "Couldn't create your account. Try again.",
      });
    },
    onSuccess: async () => {
      await refreshCurrentUser(queryClient);
      await invalidateInvites(queryClient);
    },
  });
}
