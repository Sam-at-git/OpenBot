/**
 * Model providers an admin configures in OpenBot (Admin, Models), which model each Bot uses, and what those calls
 * used (Admin, Usage). Every provider speaks the OpenAI-compatible chat API: OpenAI, DeepSeek, Qwen, Kimi, a local
 * Ollama, and most others do.
 */

/** One model a provider offers. Prices are optional and only feed the cost estimate on Admin, Usage. */
export type LlmModelEntry = {
  id: string;
  label?: string;
  /** Price per million input tokens, in the admin's own currency. */
  inputPricePerMillion?: number;
  /** Price per million output tokens, in the admin's own currency. */
  outputPricePerMillion?: number;
  /**
   * How much conversation this model is sent, in estimated tokens. Past it, the oldest tool results go as a short
   * note (`shared/history-budget.ts`). Absent uses the deployment's default (`HISTORY_TOKEN_BUDGET`, 80k).
   */
  historyTokens?: number;
};

export type LlmProvider = {
  id: string;
  name: string;
  /** The OpenAI-compatible base URL, ending at the version segment, e.g. `https://api.deepseek.com/v1`. */
  baseUrl: string;
  /** Whether a key is stored. The key itself never leaves the server. */
  hasKey: boolean;
  models: LlmModelEntry[];
  enabled: boolean;
  /**
   * Whether the base URL is this machine or the local network (localhost, a private address, `host.docker.internal`,
   * a `.local` name). A provider that is not local receives the conversations it answers.
   */
  local: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LlmProviderInput = {
  name: string;
  baseUrl: string;
  /** Absent keeps the stored key; an empty string removes it; anything else replaces it. */
  apiKey?: string;
  models: LlmModelEntry[];
  enabled: boolean;
};

export type LlmChoice = { providerId: string; model: string };

export type LlmSettings = {
  /** The model every Bot uses unless it has its own. Null uses the model this OpenBot was started with. */
  default: LlmChoice | null;
  /** Routing, tool selection, titles and Automatic learning. Null uses the default. */
  auxiliary: LlmChoice | null;
  /** A Bot's own model, by Bot ID. */
  bots: Record<string, LlmChoice>;
};

export type LlmOverview = {
  providers: LlmProvider[];
  settings: LlmSettings;
  /** The model this OpenBot was started with (its environment), used while `settings.default` is null. */
  builtIn: { provider: string; model: string; baseUrl: string | null };
};

export type LlmTestResult =
  | { ok: true; latencyMs: number; reply: string }
  | { ok: false; error: string };

/** Starting points for Add provider. The admin can change every field. */
export const LLM_PRESETS: readonly {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
}[] = [
  {
    id: "ollama",
    name: "Ollama (this Mac)",
    baseUrl: "http://host.docker.internal:11434/v1",
    models: [],
    needsKey: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.5", "gpt-5.5-mini"],
    needsKey: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    needsKey: true,
  },
  {
    id: "qwen",
    name: "Qwen (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max"],
    needsKey: true,
  },
  {
    id: "moonshot",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-turbo-preview"],
    needsKey: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    needsKey: true,
  },
];

/** What a model call was for. */
export const LLM_PURPOSES = [
  "chat",
  "routing",
  "tool-selection",
  "approval-review",
  "title",
  "learning",
  "test",
] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export type LlmUsageTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the model prices an admin entered, or null when a model used here has no price. */
  cost: number | null;
};

export type LlmUsageRow = LlmUsageTotals & { key: string; label: string };

export type LlmUsageReport = {
  from: string;
  to: string;
  totals: LlmUsageTotals;
  /** One row per day in the range, oldest first, including days with nothing (zeros). `key` is `YYYY-MM-DD`. */
  byDay: LlmUsageRow[];
  /** `key` is `providerId/model`, or `built-in/model` for the started-with model. */
  byModel: LlmUsageRow[];
  /** `key` is the Bot ID; empty for calls no Bot made (routing, titles, learning). */
  byBot: LlmUsageRow[];
  /** `key` is the user ID; empty for background calls. */
  byPerson: LlmUsageRow[];
  byPurpose: LlmUsageRow[];
};

/** Whether a base URL points at this machine or the local network. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[")) host = host.slice(1, -1);
  if (
    host === "localhost" ||
    host === "host.docker.internal" ||
    host.endsWith(".local") ||
    host === "::1"
  )
    return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    const [a = 0, b = 0] = parts;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(host);
}

// ---------------------------------------------------------------------------------------------
// Password sign-in (OPENBOT_PASSWORD_SIGN_IN=true)

/** An invite to create an account. The browser builds the link from `code`: `/sign-up?invite=<code>`. */
export type PasswordInvite = {
  code: string;
  createdAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
};

export const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------------------------
// Computer secrets (Admin, Computers)

/** A secret the Bots' computers get as an environment variable. The value is never sent to a browser. */
export type ComputerSecret = {
  id: string;
  /** The environment variable, e.g. `LLAMA_CLOUD_API_KEY`. */
  name: string;
  /** The one Bot it is for, or null for every Bot. A Bot's own value wins over the one for every Bot. */
  agentId: string | null;
  updatedAt: string;
};
