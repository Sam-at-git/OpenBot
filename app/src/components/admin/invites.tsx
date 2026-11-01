import type { PasswordInvite } from "@openbot/shared/llm";
import {
  IconCopy,
  IconLink,
  IconMail,
  IconPlus,
  IconUserCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { authProvidersQueryOptions } from "@/lib/auth/queries";
import {
  createInviteMutationOptions,
  deleteInviteMutationOptions,
} from "@/lib/invites/mutations";
import { inviteLink, inviteListQueryOptions } from "@/lib/invites/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/** How many used invites stay listed. Older ones only matter to the audit log. */
const RECENTLY_USED = 10;

const shortCode = (code: string) =>
  code.length > 10 ? `${code.slice(0, 8)}…` : code;

/**
 * Admin, People, Invites: the links people create an account with when OpenBot uses password sign-in. Each link
 * creates one account. Shown only when password sign-in is on.
 */
export function InvitesSection() {
  const { data: options } = useQuery(authProvidersQueryOptions());
  if (!options?.passwordSignIn) return null;
  return <Invites />;
}

function Invites() {
  const invites = useQuery(inviteListQueryOptions());
  const create = useMutation(createInviteMutationOptions(queryClient));
  const remove = useMutation(deleteInviteMutationOptions(queryClient));
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(code: string) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(
        inviteLink(code, window.location.origin),
      );
      setCopied(code);
    } catch {
      setCopied(null);
      setCopyFailed(true);
    }
  }

  const unused = (invites.data ?? []).filter((invite) => !invite.usedAt);
  const used = (invites.data ?? [])
    .filter((invite) => invite.usedAt)
    .sort((a, b) => (b.usedAt ?? "").localeCompare(a.usedAt ?? ""))
    .slice(0, RECENTLY_USED);
  const fresh = create.data;
  const failure = create.error ?? remove.error;

  const newInvite = (
    <Button
      disabled={create.isPending}
      onClick={() => {
        setCopied(null);
        create.mutate();
      }}
      size="sm"
      variant="ghost"
    >
      <IconPlus />
      {create.isPending ? "Creating…" : "New invite"}
    </Button>
  );

  return (
    <PageSection
      action={newInvite}
      description="People create an account with an invite link. Each link works once."
      title="Invites"
    >
      {fresh && !fresh.usedAt ? (
        <div className="mt-4 flex items-center gap-2">
          <Input
            aria-label="Invite link"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            value={inviteLink(fresh.code, window.location.origin)}
          />
          <Button
            onClick={() => void copy(fresh.code)}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconCopy />
            {copied === fresh.code ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
      {failure ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {copyFailed ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          Couldn't copy the link. Select it and copy it yourself.
        </p>
      ) : null}

      {invites.isPending ? null : invites.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {invites.error.message}
        </p>
      ) : unused.length === 0 && used.length === 0 ? (
        <PageEmpty action={newInvite} icon={IconMail} title="No invites yet">
          Each invite link lets one person create an account.
        </PageEmpty>
      ) : (
        <>
          {unused.length > 0 ? (
            <PageRows>
              {unused.map((invite, index) => (
                <div key={invite.code}>
                  {index > 0 && <Separator />}
                  <UnusedInviteRow
                    copied={copied === invite.code}
                    deleting={remove.isPending}
                    invite={invite}
                    onCopy={() => void copy(invite.code)}
                    onDelete={() => remove.mutate(invite.code)}
                  />
                </div>
              ))}
            </PageRows>
          ) : null}
          {used.length > 0 ? (
            <PageRows>
              {used.map((invite, index) => (
                <div key={invite.code}>
                  {index > 0 && <Separator />}
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconUserCheck />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        Used by {invite.usedByEmail ?? "someone"}
                      </ItemTitle>
                      <ItemDescription>
                        {shortCode(invite.code)} · used{" "}
                        {relativeTime(invite.usedAt ?? invite.createdAt)}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                </div>
              ))}
            </PageRows>
          ) : null}
        </>
      )}
    </PageSection>
  );
}

function UnusedInviteRow({
  invite,
  copied,
  deleting,
  onCopy,
  onDelete,
}: {
  invite: PasswordInvite;
  copied: boolean;
  deleting: boolean;
  onCopy: () => void;
  onDelete: () => void;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconLink />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{shortCode(invite.code)}</ItemTitle>
        <ItemDescription>
          Not used yet · created {relativeTime(invite.createdAt)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button onClick={onCopy} size="sm" type="button" variant="outline">
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button
          disabled={deleting}
          onClick={onDelete}
          size="sm"
          type="button"
          variant="destructive"
        >
          Delete
        </Button>
      </ItemActions>
    </Item>
  );
}
