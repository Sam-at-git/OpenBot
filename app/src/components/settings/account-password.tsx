import { MIN_PASSWORD_LENGTH } from "@openbot/shared/llm";
import { IconChevronRight, IconKey } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { changePasswordMutationOptions } from "@/lib/auth/mutations";
import { authProvidersQueryOptions } from "@/lib/auth/queries";

/** Settings, Account: change your password. Shown only when OpenBot has password sign-in turned on. */
export function AccountSettings() {
  const { data: options } = useQuery(authProvidersQueryOptions());
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);

  if (!options?.passwordSignIn) return null;

  return (
    <PageSection title="Account">
      <PageRows>
        <Item
          render={
            <button
              onClick={() => {
                setChanged(false);
                setOpen(true);
              }}
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconKey />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Password</ItemTitle>
            <ItemDescription>
              Change the password you sign in with.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {changed ? (
        <p className="mt-3 text-muted-foreground text-sm" role="status">
          Password changed. Other devices are signed out.
        </p>
      ) : null}
      {open ? (
        <PasswordDialog
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            setChanged(true);
          }}
        />
      ) : null}
    </PageSection>
  );
}

function PasswordDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const change = useMutation(changePasswordMutationOptions());

  const problem =
    next.length < MIN_PASSWORD_LENGTH
      ? `Use at least ${MIN_PASSWORD_LENGTH} characters for your new password.`
      : confirm !== next
        ? "The two new passwords don't match."
        : null;

  function handleSubmit(submission: React.FormEvent) {
    submission.preventDefault();
    setSubmitted(true);
    if (problem || current.length === 0) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      { onSuccess: onSaved },
    );
  }

  const message = (submitted && problem) || change.error?.message;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
        </DialogHeader>
        {/* The form sits inside the body so the body stays a direct child of the dialog and keeps scrolling. */}
        <DialogBody className="mt-4 overflow-y-auto">
          <form
            className="grid gap-4"
            id="change-password"
            noValidate
            onSubmit={handleSubmit}
          >
            <Field>
              <FieldLabel htmlFor="password-current">
                Current password
              </FieldLabel>
              <Input
                autoComplete="current-password"
                id="password-current"
                onChange={(event) => setCurrent(event.target.value)}
                required
                type="password"
                value={current}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-new">New password</FieldLabel>
              <Input
                autoComplete="new-password"
                id="password-new"
                minLength={MIN_PASSWORD_LENGTH}
                onChange={(event) => setNext(event.target.value)}
                required
                type="password"
                value={next}
              />
              <FieldDescription>
                At least {MIN_PASSWORD_LENGTH} characters. Saving signs you out
                on every other device.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="password-confirm">
                Confirm new password
              </FieldLabel>
              <Input
                autoComplete="new-password"
                id="password-confirm"
                onChange={(event) => setConfirm(event.target.value)}
                required
                type="password"
                value={confirm}
              />
            </Field>
            {message ? (
              <p className="text-destructive text-sm" role="alert">
                {message}
              </p>
            ) : null}
          </form>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={change.isPending || current.length === 0}
            form="change-password"
            size="sm"
            type="submit"
          >
            {change.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
