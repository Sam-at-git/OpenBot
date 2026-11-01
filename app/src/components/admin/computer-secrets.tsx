import type { ComputerSecret } from "@openbot/shared/llm";
import { IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  deleteComputerSecretMutationOptions,
  putComputerSecretMutationOptions,
} from "@/lib/computers/mutations";
import { computerSecretsQueryOptions } from "@/lib/computers/queries";
import { queryClient } from "@/query-client";

const EVERY_BOT = "*";
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * Admin, Computers: secrets the commands Bots run get as environment variables, such as an API key a skill's script
 * reads. Values are write-only: this screen lists names and which Bot each is for, and a value can only be replaced.
 */
export function ComputerSecretsSection() {
  const secrets = useQuery(computerSecretsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const roster = [...(agents.data ?? []), ...(hidden.data ?? [])];
  const botName = (id: string | null) =>
    id === null
      ? "Every Bot"
      : (roster.find((agent) => agent.id === id)?.name ?? id);
  const [editing, setEditing] = useState<ComputerSecret | "new" | null>(null);

  return (
    <PageSection
      action={
        <Button
          onClick={() => setEditing("new")}
          size="sm"
          type="button"
          variant="outline"
        >
          <IconPlus />
          Add secret
        </Button>
      }
      description="Commands a Bot runs on its computer get these as environment variables. The Bot never sees a value, and a value printed by a command is hidden."
      title="Secrets"
    >
      {secrets.isPending ? null : secrets.error ? (
        <p className="text-destructive text-sm" role="alert">
          {secrets.error.message}
        </p>
      ) : secrets.data.length === 0 ? (
        <PageEmpty icon={IconKey} title="No secrets yet">
          Add an API key a skill needs, such as LLAMA_CLOUD_API_KEY.
        </PageEmpty>
      ) : (
        <PageRows>
          {secrets.data.map((secret, index) => (
            <div key={secret.id}>
              {index > 0 && <Separator />}
              <Item
                render={
                  <button onClick={() => setEditing(secret)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconKey />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="font-mono">{secret.name}</ItemTitle>
                  <ItemDescription>
                    {botName(secret.agentId)} · changed{" "}
                    {new Date(secret.updatedAt).toLocaleDateString()}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">Replace</span>
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
      )}
      {editing && (
        <SecretDialog
          onClose={() => setEditing(null)}
          roster={roster.map((agent) => ({ id: agent.id, name: agent.name }))}
          secret={editing === "new" ? undefined : editing}
        />
      )}
    </PageSection>
  );
}

function SecretDialog({
  secret,
  roster,
  onClose,
}: {
  secret?: ComputerSecret;
  roster: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [name, setName] = useState(secret?.name ?? "");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState(secret?.agentId ?? EVERY_BOT);
  const put = useMutation(putComputerSecretMutationOptions(queryClient));
  const remove = useMutation(deleteComputerSecretMutationOptions(queryClient));
  const nameOk = NAME.test(name);
  const busy = put.isPending || remove.isPending;
  const error = put.error ?? remove.error;

  const save = () =>
    put.mutate(
      { name, value, agentId: scope === EVERY_BOT ? null : scope },
      { onSuccess: onClose },
    );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? secret.name : "Add secret"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="secret-name">Name</FieldLabel>
            <Input
              autoComplete="off"
              className="font-mono"
              disabled={busy || secret !== undefined}
              id="secret-name"
              onChange={(event) =>
                setName(event.target.value.toUpperCase().replace(/\s/g, "_"))
              }
              placeholder="LLAMA_CLOUD_API_KEY"
              value={name}
            />
            <FieldDescription>
              The environment variable a script reads: upper-case letters,
              digits and underscores.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="secret-value">
              {secret ? "New value" : "Value"}
            </FieldLabel>
            <Input
              autoComplete="new-password"
              disabled={busy}
              id="secret-value"
              onChange={(event) => setValue(event.target.value)}
              type="password"
              value={value}
            />
            <FieldDescription>
              Stored encrypted. Nobody can read it back here.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="secret-scope">For</FieldLabel>
            <Select
              disabled={busy || secret !== undefined}
              onValueChange={(next) => setScope(String(next))}
              value={scope}
            >
              <SelectTrigger id="secret-scope">
                <SelectValue>
                  {scope === EVERY_BOT
                    ? "Every Bot"
                    : (roster.find((agent) => agent.id === scope)?.name ??
                      scope)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={EVERY_BOT}>Every Bot</SelectItem>
                  {roster.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              A Bot's own value is used instead of the one for every Bot.
            </FieldDescription>
          </Field>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          {secret && (
            <Button
              disabled={busy}
              onClick={() =>
                remove.mutate(secret.id, { onSuccess: onClose })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Remove
            </Button>
          )}
          <Button
            disabled={busy || !nameOk || value === ""}
            onClick={save}
            size="sm"
            type="button"
          >
            {put.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
