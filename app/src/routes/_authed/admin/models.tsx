import {
  isLocalBaseUrl,
  LLM_PRESETS,
  type LlmChoice,
  type LlmOverview,
  type LlmProvider,
  type LlmProviderInput,
  type LlmSettings,
  type LlmTestResult,
} from "@openbot/shared/llm";
import {
  IconBrain,
  IconChevronRight,
  IconPlus,
  IconRobot,
  IconRoute,
  IconServer,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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
  DialogDescription,
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
  formatModelsText,
  mergeModelIds,
  parseModelsText,
} from "@/lib/llm/models-text";
import {
  createLlmProviderMutationOptions,
  deleteLlmProviderMutationOptions,
  saveLlmSettingsMutationOptions,
  updateLlmProviderMutationOptions,
} from "@/lib/llm/mutations";
import {
  discoverLlmModels,
  llmOverviewQueryOptions,
  testLlmProvider,
} from "@/lib/llm/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/models")({
  component: ModelsPage,
});

/** The Select value that stands for "no choice of its own" (the built-in model, or the default). */
const NONE = "__none__";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function modelLabel(provider: LlmProvider | undefined, model: string): string {
  return provider?.models.find((entry) => entry.id === model)?.label ?? model;
}

/** "DeepSeek · deepseek-chat", or the IDs when the provider is gone. */
function choiceLabel(choice: LlmChoice, providers: LlmProvider[]): string {
  const provider = providers.find((entry) => entry.id === choice.providerId);
  const name = provider?.name ?? "Deleted provider";
  const off = provider && !provider.enabled ? " (turned off)" : "";
  return `${name} · ${modelLabel(provider, choice.model)}${off}`;
}

function modelCount(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

/** What is being chosen in the model dialog: the default, the auxiliary model, or one Bot's own. */
type ChoiceTarget =
  | { kind: "default" }
  | { kind: "auxiliary" }
  | { kind: "bot"; id: string; name: string };

/** Which provider dialog is open: a new one, or an existing one by ID. */
type ProviderTarget = { kind: "new" } | { kind: "edit"; id: string };

/**
 * Admin, Models: the model providers OpenBot can call, the default and auxiliary models, and each Bot's own model.
 * Every provider speaks the OpenAI-compatible chat API.
 */
function ModelsPage() {
  const overview = useQuery(llmOverviewQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const roster = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])].map(
    (agent) => ({ id: agent.id, name: agent.name }),
  );
  const [providerTarget, setProviderTarget] = useState<ProviderTarget | null>(
    null,
  );

  return (
    <PageShell
      description="Choose the model each Bot uses, and add the providers OpenBot can call. Any provider with an OpenAI-compatible API works."
      title="Models"
    >
      {overview.isPending ? null : overview.error ? (
        <p className="text-destructive text-sm" role="alert">
          {overview.error.message}
        </p>
      ) : (
        <ModelSections
          onProvider={setProviderTarget}
          overview={overview.data}
          providerTarget={providerTarget}
          roster={roster}
        />
      )}
    </PageShell>
  );
}

function ModelSections({
  overview,
  roster,
  providerTarget,
  onProvider,
}: {
  overview: LlmOverview;
  roster: { id: string; name: string }[];
  providerTarget: ProviderTarget | null;
  onProvider: (target: ProviderTarget | null) => void;
}) {
  const { providers, settings, builtIn } = overview;
  const [choiceTarget, setChoiceTarget] = useState<ChoiceTarget | null>(null);
  const remote = providers.filter(
    (provider) => provider.enabled && !provider.local,
  );
  const editing =
    providerTarget?.kind === "edit"
      ? providers.find((provider) => provider.id === providerTarget.id)
      : undefined;

  const defaultSummary = settings.default
    ? choiceLabel(settings.default, providers)
    : `Built-in: ${builtIn.model} (from the environment)`;
  const auxiliarySummary = settings.auxiliary
    ? choiceLabel(settings.auxiliary, providers)
    : "Same as the default model";

  return (
    <>
      {remote.length > 0 ? (
        <p className="text-amber-600 text-sm dark:text-amber-500" role="status">
          {`Conversations answered by ${remote.map((provider) => provider.name).join(", ")} leave this machine.`}
        </p>
      ) : null}

      <PageSection
        description="Bots use the default model unless they have their own. The auxiliary model handles routing, tool selection, titles and Automatic learning."
        title="Defaults"
      >
        <PageRows>
          <ChoiceRow
            description={defaultSummary}
            icon={IconBrain}
            onOpen={() => setChoiceTarget({ kind: "default" })}
            title="Default model"
          />
          <Separator />
          <ChoiceRow
            description={auxiliarySummary}
            icon={IconRoute}
            onOpen={() => setChoiceTarget({ kind: "auxiliary" })}
            title="Auxiliary model"
          />
        </PageRows>
      </PageSection>

      <PageSection
        description="Give a Bot its own model when it needs a stronger or cheaper one than the default."
        title="Bots"
      >
        {roster.length === 0 ? (
          <PageEmpty icon={IconRobot} title="No Bots yet">
            Bots appear here once someone creates one.
          </PageEmpty>
        ) : (
          <PageRows>
            {roster.map((bot, index) => {
              const own = settings.bots[bot.id];
              return (
                <div key={bot.id}>
                  {index > 0 && <Separator />}
                  <ChoiceRow
                    description={own ? choiceLabel(own, providers) : "Default"}
                    icon={IconRobot}
                    onOpen={() =>
                      setChoiceTarget({
                        kind: "bot",
                        id: bot.id,
                        name: bot.name,
                      })
                    }
                    title={bot.name}
                  />
                </div>
              );
            })}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        action={
          <Button
            onClick={() => onProvider({ kind: "new" })}
            size="sm"
            variant="ghost"
          >
            <IconPlus />
            Add provider
          </Button>
        }
        description="OpenBot calls these providers with the OpenAI-compatible chat API. Keys stay on the server."
        title="Providers"
      >
        {providers.length === 0 ? (
          <PageEmpty
            action={
              <Button
                onClick={() => onProvider({ kind: "new" })}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add provider
              </Button>
            }
            icon={IconServer}
            title="No providers yet"
          >
            {`Every Bot uses the built-in model, ${builtIn.model}.`}
          </PageEmpty>
        ) : (
          <PageRows>
            {providers.map((provider, index) => (
              <div key={provider.id}>
                {index > 0 && <Separator />}
                <Item
                  render={
                    <button
                      onClick={() =>
                        onProvider({ kind: "edit", id: provider.id })
                      }
                      type="button"
                    />
                  }
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <IconServer />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{provider.name}</ItemTitle>
                    <ItemDescription>
                      {hostOf(provider.baseUrl)} ·{" "}
                      {modelCount(provider.models.length)}
                      {provider.local
                        ? ""
                        : ` · Sends conversations to ${hostOf(provider.baseUrl)}`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {provider.enabled ? null : (
                      <span className="text-muted-foreground text-sm">Off</span>
                    )}
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      {choiceTarget ? (
        <ChoiceDialog
          key={choiceKey(choiceTarget)}
          onClose={() => setChoiceTarget(null)}
          overview={overview}
          target={choiceTarget}
        />
      ) : null}
      {providerTarget?.kind === "new" ? (
        <ProviderDialog key="new" onClose={() => onProvider(null)} />
      ) : editing ? (
        <ProviderDialog
          key={editing.id}
          onClose={() => onProvider(null)}
          provider={editing}
        />
      ) : null}
    </>
  );
}

function choiceKey(target: ChoiceTarget): string {
  return target.kind === "bot" ? `bot:${target.id}` : target.kind;
}

function ChoiceRow({
  icon: Icon,
  title,
  description,
  onOpen,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onOpen: () => void;
}) {
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/** The current choice for a target, and what choosing nothing means for it. */
function choiceFor(
  target: ChoiceTarget,
  settings: LlmSettings,
  builtInModel: string,
): {
  title: string;
  description: string;
  current: LlmChoice | null;
  noneLabel: string;
} {
  if (target.kind === "default") {
    return {
      title: "Default model",
      description: "Every Bot without a model of its own uses this one.",
      current: settings.default,
      noneLabel: `Use the built-in model (${builtInModel})`,
    };
  }
  if (target.kind === "auxiliary") {
    return {
      title: "Auxiliary model",
      description:
        "OpenBot uses this model for routing, tool selection, titles and Automatic learning. A small, fast model works well.",
      current: settings.auxiliary,
      noneLabel: "Use the default model",
    };
  }
  return {
    title: target.name,
    description: "Choose the model this Bot answers with.",
    current: settings.bots[target.id] ?? null,
    noneLabel: "Use the default",
  };
}

function withChoice(
  target: ChoiceTarget,
  settings: LlmSettings,
  choice: LlmChoice | null,
): LlmSettings {
  if (target.kind === "default") return { ...settings, default: choice };
  if (target.kind === "auxiliary") return { ...settings, auxiliary: choice };
  const bots = Object.fromEntries(
    Object.entries(settings.bots).filter(([id]) => id !== target.id),
  );
  return {
    ...settings,
    bots: choice ? { ...bots, [target.id]: choice } : bots,
  };
}

function ChoiceDialog({
  target,
  overview,
  onClose,
}: {
  target: ChoiceTarget;
  overview: LlmOverview;
  onClose: () => void;
}) {
  const { settings, providers, builtIn } = overview;
  const { title, description, current, noneLabel } = choiceFor(
    target,
    settings,
    builtIn.model,
  );
  const [providerId, setProviderId] = useState(current?.providerId ?? NONE);
  const [model, setModel] = useState(current?.model ?? "");
  const save = useMutation(saveLlmSettingsMutationOptions(queryClient));

  // Turned-off providers are not offered, except the one already chosen, so the dialog can show it.
  const offered = providers.filter(
    (provider) => provider.enabled || provider.id === current?.providerId,
  );
  const provider = providers.find((entry) => entry.id === providerId);
  const models = provider?.models ?? [];
  const choice: LlmChoice | null =
    providerId === NONE ? null : { providerId, model };
  const ready = providerId === NONE || (provider !== undefined && model !== "");

  const providerItems: Record<string, string> = {
    [NONE]: noneLabel,
    ...Object.fromEntries(offered.map((entry) => [entry.id, entry.name])),
  };
  const modelItems: Record<string, string> = Object.fromEntries(
    models.map((entry) => [entry.id, entry.label ?? entry.id]),
  );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="model-choice-provider">Provider</FieldLabel>
            <Select
              items={providerItems}
              onValueChange={(value) => {
                const next = value ?? NONE;
                setProviderId(next);
                const first = providers.find((entry) => entry.id === next)
                  ?.models[0];
                setModel(first?.id ?? "");
              }}
              value={providerId}
            >
              <SelectTrigger className="w-full" id="model-choice-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NONE}>{noneLabel}</SelectItem>
                  {offered.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {providerId === NONE ? null : models.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This provider lists no models. Add them to the provider first.
            </p>
          ) : (
            <Field>
              <FieldLabel htmlFor="model-choice-model">Model</FieldLabel>
              <Select
                items={modelItems}
                onValueChange={(value) => setModel(value ?? "")}
                value={model || null}
              >
                <SelectTrigger className="w-full" id="model-choice-model">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {models.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.label ?? entry.id}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
          {provider && !provider.local ? (
            <p className="text-muted-foreground text-sm">
              Conversations this model answers go to {hostOf(provider.baseUrl)}.
            </p>
          ) : null}
          {save.error ? (
            <p className="text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!ready || save.isPending}
            onClick={() =>
              save.mutate(withChoice(target, settings, choice), {
                onSuccess: onClose,
              })
            }
            size="sm"
            type="button"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A line under Fetch models: what the provider listed, or why it couldn't. */
type Note = { ok: boolean; text: string };

const MODELS_PLACEHOLDER =
  "deepseek-chat\ndeepseek-reasoner | Reasoner | 0.55 | 2.19 | 200k\nqwen3:27b | | | | 40k";

function ProviderDialog({
  provider,
  onClose,
}: {
  /** Absent for Add provider. */
  provider?: LlmProvider;
  onClose: () => void;
}) {
  const [presetId, setPresetId] = useState<string | null>(null);
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [modelsText, setModelsText] = useState(
    formatModelsText(provider?.models ?? []),
  );
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [formError, setFormError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<Note | null>(null);
  const [testModel, setTestModel] = useState(provider?.models[0]?.id ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);

  const create = useMutation(createLlmProviderMutationOptions(queryClient));
  const update = useMutation(updateLlmProviderMutationOptions(queryClient));
  const remove = useMutation(deleteLlmProviderMutationOptions(queryClient));
  const busy = create.isPending || update.isPending || remove.isPending;
  const failure = create.error ?? update.error ?? remove.error;
  const keyStored = Boolean(provider?.hasKey) && !removeKey;

  const presetItems: Record<string, string> = Object.fromEntries(
    LLM_PRESETS.map((preset) => [preset.id, preset.name]),
  );
  const testItems: Record<string, string> = Object.fromEntries(
    (provider?.models ?? []).map((entry) => [
      entry.id,
      entry.label ?? entry.id,
    ]),
  );

  function applyPreset(id: string | null) {
    setPresetId(id);
    const preset = LLM_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setModelsText(preset.models.join("\n"));
    setDiscoverNote(null);
  }

  async function fetchModels() {
    setDiscovering(true);
    setDiscoverNote(null);
    try {
      const ids = await discoverLlmModels({
        baseUrl: baseUrl.trim(),
        ...(apiKey !== "" ? { apiKey } : {}),
        ...(provider ? { providerId: provider.id } : {}),
      });
      const merged = mergeModelIds(modelsText, ids);
      const added = parseModelsText(merged);
      const before = parseModelsText(modelsText);
      const count =
        added.ok && before.ok ? added.models.length - before.models.length : 0;
      setModelsText(merged);
      setDiscoverNote({
        ok: true,
        text:
          ids.length === 0
            ? "The provider listed no models."
            : count === 0
              ? `The provider lists ${modelCount(ids.length)}, all already here.`
              : `Added ${modelCount(count)}.`,
      });
    } catch (error) {
      setDiscoverNote({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "Couldn't fetch the provider's models.",
      });
    } finally {
      setDiscovering(false);
    }
  }

  async function runTest() {
    if (!provider || testModel === "") return;
    setTesting(true);
    setTestResult(null);
    setTestResult(await testLlmProvider(provider.id, testModel));
    setTesting(false);
  }

  function handleSave() {
    setFormError(null);
    const parsed = parseModelsText(modelsText);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    if (name.trim() === "" || baseUrl.trim() === "") {
      setFormError("Give the provider a name and a base URL.");
      return;
    }
    // Absent keeps the stored key, an empty string removes it, anything else replaces it.
    const key = apiKey !== "" ? apiKey : removeKey ? "" : undefined;
    const input: LlmProviderInput = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      models: parsed.models,
      enabled,
      ...(key === undefined ? {} : { apiKey: key }),
    };
    if (provider) {
      update.mutate(
        { id: provider.id, provider: input },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(input, { onSuccess: onClose });
    }
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{provider ? provider.name : "Add provider"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
          {provider ? null : (
            <Field>
              <FieldLabel htmlFor="provider-preset">Start from</FieldLabel>
              <Select
                items={presetItems}
                onValueChange={(value) => applyPreset(value)}
                value={presetId}
              >
                <SelectTrigger className="w-full" id="provider-preset">
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {LLM_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Fills in the fields below. You can change every one.
              </FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="provider-name">Name</FieldLabel>
            <Input
              disabled={busy}
              id="provider-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
            <Input
              disabled={busy}
              id="provider-base-url"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              type="url"
              value={baseUrl}
            />
            <FieldDescription>
              The OpenAI-compatible address, ending at the version, such as /v1.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
            <Input
              autoComplete="off"
              disabled={busy}
              id="provider-api-key"
              onChange={(event) => {
                setApiKey(event.target.value);
                if (event.target.value !== "") setRemoveKey(false);
              }}
              placeholder={keyStored ? "Stored" : undefined}
              type="password"
              value={apiKey}
            />
            <FieldDescription>
              {keyStored
                ? "Leave it blank to keep the stored key."
                : removeKey
                  ? "Saving removes the stored key."
                  : "Leave it blank for a provider that needs no key, such as Ollama."}
              {provider?.hasKey && !removeKey ? (
                <>
                  {" "}
                  <button
                    className="underline underline-offset-4 hover:text-foreground"
                    disabled={busy}
                    onClick={() => {
                      setApiKey("");
                      setRemoveKey(true);
                    }}
                    type="button"
                  >
                    Remove key
                  </button>
                </>
              ) : null}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-models">Models</FieldLabel>
            <Textarea
              className="font-mono text-sm"
              disabled={busy}
              id="provider-models"
              onChange={(event) => setModelsText(event.target.value)}
              placeholder={MODELS_PLACEHOLDER}
              rows={6}
              value={modelsText}
            />
            <FieldDescription>
              One model per line: ID | label | input price | output price |
              conversation budget. Only the ID is required. Prices are per
              million tokens and feed the cost estimate on Usage. The budget is
              how much of a conversation the model reads, such as 64k. Past it,
              the oldest tool results are shortened. Leave it empty for 80k.
            </FieldDescription>
            <div className="flex items-center gap-3">
              <Button
                disabled={busy || discovering || baseUrl.trim() === ""}
                onClick={() => void fetchModels()}
                size="sm"
                type="button"
                variant="outline"
              >
                {discovering ? "Fetching…" : "Fetch models"}
              </Button>
              {discoverNote ? (
                <span
                  className={
                    discoverNote.ok
                      ? "text-muted-foreground text-sm"
                      : "text-destructive text-sm"
                  }
                  role={discoverNote.ok ? "status" : "alert"}
                >
                  {discoverNote.text}
                </span>
              ) : null}
            </div>
          </Field>
          <Item size="sm" variant="muted">
            <ItemContent>
              <ItemTitle>Turned on</ItemTitle>
              <ItemDescription>
                {enabled
                  ? "Bots can use this provider's models."
                  : "No Bot uses this provider until you turn it on."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Turned on"
                checked={enabled}
                disabled={busy}
                onCheckedChange={setEnabled}
              />
            </ItemActions>
          </Item>
          {baseUrl.trim() !== "" && !isLocalHint(provider, baseUrl) ? (
            <p className="text-muted-foreground text-sm">
              Conversations this provider answers go to {hostOf(baseUrl)}.
            </p>
          ) : null}
          {provider ? (
            <Field>
              <FieldLabel htmlFor="provider-test-model">Test</FieldLabel>
              <div className="flex items-center gap-2">
                <Select
                  items={testItems}
                  onValueChange={(value) => setTestModel(value ?? "")}
                  value={testModel || null}
                >
                  <SelectTrigger className="flex-1" id="provider-test-model">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {provider.models.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.label ?? entry.id}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  disabled={testing || testModel === ""}
                  onClick={() => void runTest()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {testing ? "Testing…" : "Test"}
                </Button>
              </div>
              <FieldDescription>
                Sends one short message with the saved settings. Save your
                changes first to test them.
              </FieldDescription>
              {testResult ? (
                testResult.ok ? (
                  <p className="text-sm" role="status">
                    Replied in {testResult.latencyMs.toLocaleString()} ms: “
                    {testResult.reply}”
                  </p>
                ) : (
                  <p className="text-destructive text-sm" role="alert">
                    {testResult.error}
                  </p>
                )
              ) : null}
            </Field>
          ) : null}
          {formError || failure ? (
            <p className="text-destructive text-sm" role="alert">
              {formError ?? failure?.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          {provider ? (
            <Button
              className="mr-auto"
              disabled={busy}
              onClick={() => remove.mutate(provider.id, { onSuccess: onClose })}
              size="sm"
              type="button"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          ) : null}
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={busy} onClick={handleSave} size="sm" type="button">
            {create.isPending || update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Whether the base URL being edited is local: the server's verdict until it changes, then the shared rule. */
function isLocalHint(
  provider: LlmProvider | undefined,
  baseUrl: string,
): boolean {
  return provider && baseUrl.trim() === provider.baseUrl
    ? provider.local
    : isLocalBaseUrl(baseUrl.trim());
}
