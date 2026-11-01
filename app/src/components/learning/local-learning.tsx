import type {
  LocalLearnedSkill,
  LocalLearningSettings,
  LocalLearningState,
} from "@openbot/shared/learning";
import {
  IconBulb,
  IconChevronRight,
  IconClock,
  IconRobot,
  IconSparkles,
  IconToggleRight,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  decideLocalSkillMutationOptions,
  editLocalSkillMutationOptions,
  runLocalLearningMutationOptions,
  saveLocalLearningSettingsMutationOptions,
} from "@/lib/learning/mutations";
import { localLearningQueryOptions } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

const INTERVALS = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Every day" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Every week" },
];

function intervalLabel(hours: number): string {
  return (
    INTERVALS.find((interval) => interval.hours === hours)?.label ??
    `Every ${hours} hours`
  );
}

const when = (value: string) => new Date(value).toLocaleString();

/** The latest analysis, in one sentence. */
function runSummary(state: LocalLearningState): string {
  const run = state.latestRun;
  const waiting =
    state.waitingConversations === 1
      ? "1 conversation is waiting."
      : `${state.waitingConversations} conversations are waiting.`;
  const quiet =
    state.waitingConversations > 0
      ? " OpenBot reads a conversation once it has been quiet for 15 minutes."
      : "";
  if (!run) return `No analysis has run yet. ${waiting}${quiet}`;
  if (run.status === "running")
    return `Analyzing now. ${run.conversationsRead} read so far, ${run.proposed} skills proposed.`;
  if (run.status === "failed")
    return run.error ?? "The last analysis didn't finish. Try again.";
  return `Last analysis ${when(run.finishedAt ?? run.startedAt)}: read ${run.conversationsRead}, proposed ${run.proposed}. ${waiting}${quiet}`;
}

/**
 * Admin, Automatic learning, when conversations are kept on this machine.
 *
 * OpenBot's own model reads finished conversations and proposes skills. Each one waits here until an admin approves it,
 * and a Bot only ever uses approved ones.
 */
export function LocalLearningPage() {
  const state = useQuery(localLearningQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const roster = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const nameFor = (id: string) =>
    roster.find((agent) => agent.id === id)?.name ?? id;
  const [open, setOpen] = useState<string | null>(null);
  const [botsOpen, setBotsOpen] = useState(false);
  const saveSettings = useMutation(
    saveLocalLearningSettingsMutationOptions(queryClient),
  );
  const run = useMutation(runLocalLearningMutationOptions(queryClient));

  return (
    <PageShell
      title="Automatic learning"
      description="OpenBot reads finished conversations on this machine and proposes skills for your Bots. A Bot uses a skill only after you approve it. Nothing leaves this machine."
    >
      {state.isPending ? null : state.error ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : (
        <LocalLearningSections
          botsOpen={botsOpen}
          nameFor={nameFor}
          onBotsOpenChange={setBotsOpen}
          onOpen={setOpen}
          onRun={() => run.mutate()}
          onSettings={(settings) => saveSettings.mutate(settings)}
          open={open}
          roster={roster.map((agent) => ({ id: agent.id, name: agent.name }))}
          runError={run.error?.message}
          running={run.isPending}
          saving={saveSettings.isPending}
          settingsError={saveSettings.error?.message}
          state={state.data}
        />
      )}
    </PageShell>
  );
}

function LocalLearningSections({
  state,
  roster,
  nameFor,
  open,
  onOpen,
  botsOpen,
  onBotsOpenChange,
  onSettings,
  onRun,
  saving,
  running,
  settingsError,
  runError,
}: {
  state: LocalLearningState;
  roster: { id: string; name: string }[];
  nameFor: (id: string) => string;
  open: string | null;
  onOpen: (id: string | null) => void;
  botsOpen: boolean;
  onBotsOpenChange: (open: boolean) => void;
  onSettings: (settings: LocalLearningSettings) => void;
  onRun: () => void;
  saving: boolean;
  running: boolean;
  settingsError?: string;
  runError?: string;
}) {
  const { settings } = state;
  const pending = state.skills.filter((skill) => skill.status === "pending");
  const approved = state.skills.filter((skill) => skill.status === "approved");
  const decided = state.skills.filter(
    (skill) => skill.status === "rejected" || skill.status === "retired",
  );
  const included = roster.filter(
    (agent) => !settings.excludedAgents.includes(agent.id),
  );
  const analyzing = state.latestRun?.status === "running";
  const selected = state.skills.find((skill) => skill.id === open);

  return (
    <>
      <PageSection title="Settings">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconToggleRight />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Learn from conversations</ItemTitle>
              <ItemDescription>
                {settings.enabled
                  ? "OpenBot reads new conversations and Bots use the skills you approve."
                  : "OpenBot doesn't read conversations, and Bots don't use learned skills."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Learn from conversations"
                checked={settings.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSettings({ ...settings, enabled })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>How often</ItemTitle>
              <ItemDescription>
                {settings.enabled && state.nextRunAt
                  ? `Next analysis ${when(state.nextRunAt)}.`
                  : "No analysis is scheduled while learning is off."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select
                disabled={saving}
                onValueChange={(value) =>
                  onSettings({ ...settings, intervalHours: Number(value) })
                }
                value={String(settings.intervalHours)}
              >
                <SelectTrigger aria-label="How often" size="sm">
                  <SelectValue>
                    {intervalLabel(settings.intervalHours)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {INTERVALS.map((interval) => (
                      <SelectItem
                        key={interval.hours}
                        value={String(interval.hours)}
                      >
                        {interval.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button onClick={() => onBotsOpenChange(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconRobot />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Bots</ItemTitle>
              <ItemDescription>
                {included.length === roster.length
                  ? `All ${roster.length} Bots learn and use learned skills.`
                  : `${included.length} of ${roster.length} Bots learn and use learned skills.`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconSparkles />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Analysis</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {runSummary(state)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={!settings.enabled || analyzing || running}
                onClick={onRun}
                size="sm"
                type="button"
                variant="outline"
              >
                {analyzing ? "Analyzing…" : "Analyze now"}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
        {(settingsError || runError) && (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {settingsError ?? runError}
          </p>
        )}
      </PageSection>

      <SkillSection
        description="Read each one before you approve it. A skill learned from one person's conversation reaches everyone who uses that Bot."
        empty={{
          title: "No skills to review",
          description:
            "OpenBot proposes skills after it reads new conversations.",
        }}
        nameFor={nameFor}
        onOpen={onOpen}
        skills={pending}
        title="Waiting for review"
      />
      <SkillSection
        description="Bots load these when a conversation calls for them."
        empty={{
          title: "No skills in use",
          description: "Skills you approve appear here.",
        }}
        nameFor={nameFor}
        onOpen={onOpen}
        skills={approved}
        title="In use"
      />
      {decided.length > 0 && (
        <SkillSection
          nameFor={nameFor}
          onOpen={onOpen}
          skills={decided}
          title="Declined and turned off"
        />
      )}

      <BotsDialog
        onOpenChange={onBotsOpenChange}
        onSettings={onSettings}
        open={botsOpen}
        roster={roster}
        saving={saving}
        settings={settings}
      />
      {selected && (
        <SkillDialog
          botName={nameFor(selected.agentId)}
          key={`${selected.id}:${selected.updatedAt}`}
          onClose={() => onOpen(null)}
          skill={selected}
        />
      )}
    </>
  );
}

function skillStatusLabel(skill: LocalLearnedSkill): string {
  if (skill.status === "pending") return skill.revisionOf ? "Update" : "New";
  if (skill.status === "approved") return "In use";
  if (skill.status === "retired") return "Turned off";
  return "Declined";
}

function SkillSection({
  title,
  description,
  skills,
  empty,
  nameFor,
  onOpen,
}: {
  title: string;
  description?: string;
  skills: LocalLearnedSkill[];
  empty?: { title: string; description: string };
  nameFor: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <PageSection description={description} title={title}>
      {skills.length === 0 && empty ? (
        <PageEmpty icon={IconBulb} title={empty.title}>
          {empty.description}
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.map((skill, index) => (
            <div key={skill.id}>
              {index > 0 && <Separator />}
              <Item
                render={
                  <button onClick={() => onOpen(skill.id)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconBulb />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {skill.name} · {nameFor(skill.agentId)}
                  </ItemTitle>
                  <ItemDescription>{skill.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">
                    {skillStatusLabel(skill)}
                  </span>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

function BotsDialog({
  open,
  onOpenChange,
  roster,
  settings,
  onSettings,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roster: { id: string; name: string }[];
  settings: LocalLearningSettings;
  onSettings: (settings: LocalLearningSettings) => void;
  saving: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bots that learn</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <PageRows>
            {roster.map((agent, index) => {
              const on = !settings.excludedAgents.includes(agent.id);
              return (
                <div key={agent.id}>
                  {index > 0 && <Separator />}
                  <Item size="sm" variant="muted">
                    <ItemContent>
                      <ItemTitle>{agent.name}</ItemTitle>
                      <ItemDescription>
                        {on
                          ? "Learns from its conversations and uses approved skills."
                          : "Doesn't learn or use learned skills."}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Switch
                        aria-label={agent.name}
                        checked={on}
                        disabled={saving}
                        onCheckedChange={(checked) =>
                          onSettings({
                            ...settings,
                            excludedAgents: checked
                              ? settings.excludedAgents.filter(
                                  (id) => id !== agent.id,
                                )
                              : [...settings.excludedAgents, agent.id],
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                </div>
              );
            })}
          </PageRows>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One learned skill: read it, edit it, and decide. */
function SkillDialog({
  skill,
  botName,
  onClose,
}: {
  skill: LocalLearnedSkill;
  botName: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions);
  const edit = useMutation(editLocalSkillMutationOptions(queryClient));
  const decide = useMutation(decideLocalSkillMutationOptions(queryClient));
  const editable = skill.status === "pending" || skill.status === "approved";
  const changed =
    name !== skill.name ||
    description !== skill.description ||
    instructions !== skill.instructions;
  const busy = edit.isPending || decide.isPending;

  useEffect(() => {
    if (decide.isSuccess) onClose();
  }, [decide.isSuccess, onClose]);

  const saveThen = async (
    decision?: "approve" | "decline" | "retire",
  ): Promise<void> => {
    if (changed && editable)
      await edit.mutateAsync({
        id: skill.id,
        input: { name, description, instructions },
      });
    if (decision) await decide.mutateAsync({ id: skill.id, decision });
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {skill.name} · {botName}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
          {skill.rationale && (
            <p className="text-muted-foreground text-sm">{skill.rationale}</p>
          )}
          <p className="text-muted-foreground text-sm">
            {skill.sourceCount === 1
              ? "Learned from 1 conversation."
              : `Learned from ${skill.sourceCount} conversations.`}
            {skill.revisionOf && skill.status === "pending"
              ? " Approving it replaces the skill in use with the same name."
              : ""}
          </p>
          <Field>
            <FieldLabel htmlFor="local-skill-name">Name</FieldLabel>
            <Input
              disabled={!editable || busy}
              id="local-skill-name"
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <FieldDescription>
              Lower-case letters and numbers joined by hyphens.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="local-skill-description">
              When to use it
            </FieldLabel>
            <Textarea
              disabled={!editable || busy}
              id="local-skill-description"
              maxLength={400}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              value={description}
            />
            <FieldDescription>
              Bots see only this until they load the skill.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="local-skill-instructions">
              Instructions
            </FieldLabel>
            <Textarea
              className="font-mono text-sm"
              disabled={!editable || busy}
              id="local-skill-instructions"
              maxLength={8000}
              onChange={(event) => setInstructions(event.target.value)}
              rows={12}
              value={instructions}
            />
          </Field>
          {(edit.error || decide.error) && (
            <p className="text-destructive text-sm" role="alert">
              {(edit.error ?? decide.error)?.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          {skill.status === "pending" && (
            <>
              <Button
                disabled={busy}
                onClick={() => void saveThen("decline").catch(() => {})}
                size="sm"
                type="button"
                variant="outline"
              >
                Decline
              </Button>
              <Button
                disabled={busy}
                onClick={() => void saveThen("approve").catch(() => {})}
                size="sm"
                type="button"
              >
                {busy ? "Saving…" : "Approve"}
              </Button>
            </>
          )}
          {skill.status === "approved" && (
            <>
              <Button
                disabled={busy}
                onClick={() => void saveThen("retire").catch(() => {})}
                size="sm"
                type="button"
                variant="outline"
              >
                Turn off
              </Button>
              <Button
                disabled={busy || !changed}
                onClick={() =>
                  void saveThen()
                    .then(onClose)
                    .catch(() => {})
                }
                size="sm"
                type="button"
              >
                {edit.isPending ? "Saving…" : "Save"}
              </Button>
            </>
          )}
          {skill.status === "retired" && (
            <Button
              disabled={busy}
              onClick={() => void saveThen("approve").catch(() => {})}
              size="sm"
              type="button"
            >
              Turn back on
            </Button>
          )}
          {skill.status === "rejected" && (
            <Button onClick={onClose} size="sm" type="button" variant="outline">
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
