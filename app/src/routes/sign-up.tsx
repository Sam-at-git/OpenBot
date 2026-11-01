import { MIN_PASSWORD_LENGTH } from "@openbot/shared/llm";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { passwordSignUpMutationOptions } from "@/lib/invites/mutations";
import { inviteCheckQueryOptions } from "@/lib/invites/queries";
import { searchTextEntry } from "@/lib/search-text";
import { queryClient } from "@/query-client";

// The sign-in screen's entrance, so arriving from an invite looks like arriving at sign-in.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign-up")({
  /*
   * `?invite=` is read as the text it was in the URL, whatever the router parsed it into: a code made of digits
   * would otherwise arrive as a number. See `searchTextEntry` and the same note on `/sign`.
   */
  validateSearch: (search: Record<string, unknown>): { invite?: string } =>
    searchTextEntry("invite", search.invite),
  beforeLoad: async ({ context, search }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) throw redirect({ to: "/" });
    // Loaded here so the screen paints with its answer. `prefetchQuery` never throws; the screen shows a failure.
    await context.queryClient.prefetchQuery(
      inviteCheckQueryOptions(search.invite ?? ""),
    );
  },
  component: SignUpScreen,
});

function SignUpScreen() {
  const { invite = "" } = Route.useSearch();
  const check = useQuery(inviteCheckQueryOptions(invite));
  const signUp = useMutation(passwordSignUpMutationOptions(queryClient));
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm !== password;
  const problem = tooShort
    ? `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`
    : mismatch
      ? "The two passwords don't match."
      : null;

  function handleSubmit(submission: React.FormEvent) {
    submission.preventDefault();
    setSubmitted(true);
    if (problem) return;
    signUp.mutate(
      { invite, name: name.trim(), email: email.trim(), password },
      { onSuccess: () => navigate({ to: "/" }) },
    );
  }

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <AgentOrb size="56px" />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          Join {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {check.isPending ? null : check.error ? (
            <p className="text-center text-sm text-destructive" role="alert">
              {check.error.message}
            </p>
          ) : !check.data.valid ? (
            <div className="flex flex-col items-center gap-4">
              <p className="text-center text-sm text-muted-foreground">
                This invite link isn't valid or has already been used. Ask
                your admin for a new one.
              </p>
              <Button
                render={(props) => <Link {...props} to="/sign" />}
                size="sm"
                variant="outline"
              >
                Go to sign in
              </Button>
            </div>
          ) : (
            <form noValidate onSubmit={handleSubmit}>
              {check.data.bootstrap ? (
                <p className="mb-4 text-center text-sm text-muted-foreground">
                  This is the first account. It becomes the admin and keeps
                  everything already in OpenBot.
                </p>
              ) : null}
              <FieldGroup className="gap-3">
                <Field>
                  <FieldLabel htmlFor="sign-up-name">Name</FieldLabel>
                  <Input
                    autoComplete="name"
                    id="sign-up-name"
                    onChange={(event) => setName(event.target.value)}
                    required
                    value={name}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sign-up-email">Email</FieldLabel>
                  <Input
                    autoComplete="email"
                    id="sign-up-email"
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    type="email"
                    value={email}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sign-up-password">Password</FieldLabel>
                  <Input
                    aria-invalid={submitted && tooShort}
                    autoComplete="new-password"
                    id="sign-up-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                  <FieldDescription>
                    At least {MIN_PASSWORD_LENGTH} characters.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="sign-up-confirm">
                    Confirm password
                  </FieldLabel>
                  <Input
                    aria-invalid={submitted && !tooShort && mismatch}
                    autoComplete="new-password"
                    id="sign-up-confirm"
                    onChange={(event) => setConfirm(event.target.value)}
                    required
                    type="password"
                    value={confirm}
                  />
                </Field>
              </FieldGroup>
              <Button
                className="mt-4 h-10 w-full tracking-tight"
                disabled={
                  signUp.isPending ||
                  name.trim().length === 0 ||
                  email.trim().length === 0
                }
                size="lg"
                type="submit"
              >
                {signUp.isPending ? "Creating account…" : "Create account"}
              </Button>
              {(submitted && problem) || signUp.error ? (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  {submitted && problem ? problem : signUp.error?.message}
                </p>
              ) : null}
            </form>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
