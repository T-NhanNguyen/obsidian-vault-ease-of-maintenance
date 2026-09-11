// ---------------------------------------------------------------------------
// Plugin settings schema
// ---------------------------------------------------------------------------
// The flat settings shape the Settings tab renders, its defaults, and the
// metadata table that drives both rendering paths so the two surfaces cannot
// drift: the declarative getSettingDefinitions() (Obsidian 1.13.0+ settings
// search) and the imperative display() (Obsidian < 1.13.0).
//
// Split out of main.ts, which sits at the 1000-line lint budget.

import { REASONING_EFFORTS, type ReasoningEffort } from "../config";

// Bounds shared by every token-cap field: 100 tokens is below any useful batch,
// 65536 is the largest completion ceiling seen on a hosted model, and 100 is the
// step the number input advances by. The bounds stop a fat-fingered value from
// stalling a build for an hour.
export const TOKEN_CAP_MIN = 100;
export const TOKEN_CAP_MAX = 65536;
export const TOKEN_CAP_STEP = 100;

/** Parse one token-cap field; null means "reject, keep the stored value". */
export function parseTokenCap(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), TOKEN_CAP_MIN), TOKEN_CAP_MAX);
}

type ReviewContainer = "sidebar" | "modal";

export interface PluginSettings {
  apiKey: string;
  apiBaseUrl: string;
  agentModel: string;
  embeddingModel: string;
  // Embedding dimensions come from config (config.yaml → embedding.dimensions,
  // overridable in the Settings tab). 0 = unknown (legacy fallback applies).
  embeddingDimensions: number;
  // The ONE reasoning control — shared by local and hosted providers and
  // applied to every LLM call (see src/config.ts ReasoningSettings).
  reasoningEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  inboxFolder: string;
  ignorePatterns: string;
  manifestFilename: string;
  reviewContainer: ReviewContainer;
  // Index-size warning threshold (MB) — config.yaml index.warn_mb; when the
  // exported index exceeds it, DatabaseManager warns (sql.js builds hold ~10×
  // the file size in RAM).
  indexWarnMb: number;
  // GraphRAG tuning — config.yaml query: + graph: sections (single source of
  // truth; deliberately NOT in the Settings tab — advanced tuning).
  queryTopK: number;
  queryDepth: number;
  queryMaxFanOut: number;
  queryMaxSeeds: number;
  queryTopReports: number;
  graphClusterThreshold: number;
  graphInferredThreshold: number;
  graphInferredMaxEdgesPerSection: number;
  // Build-side token caps — config.yaml `reports:` + `extraction:` +
  // `comprehension:` sections. These five ARE in the Settings tab: which cap a
  // vault needs depends on the model and the corpus, so they are tuned per
  // vault while testing rather than guessed once in YAML.
  reportsContextCapTokens: number;
  extractionContextCapTokens: number;
  reportsMaxOutputTokens: number;
  extractionMaxOutputTokens: number;
  // Vault-comprehension tuning — config.yaml `comprehension:` section
  // (single source of truth; deliberately NOT in the Settings tab —
  // advanced tuning). hot_topics is comma-separated in YAML (the parser is
  // scalar-only) and split into an array when applied.
  comprehensionTokenBudget: number;
  comprehensionRootExcerptWords: number;
  comprehensionMocExcerptWords: number;
  comprehensionRegularExcerptWords: number;
  comprehensionSampleTargetFiles: number;
  comprehensionVerifyTopK: number;
  comprehensionVerifyQuestionsPerRound: number;
  comprehensionToolCallBudget: number;
  comprehensionSoftThreshold: number;
  comprehensionConfirmThreshold: number;
  comprehensionLowConfidenceThreshold: number;
  comprehensionMinCoverage: number;
  comprehensionHotTopics: string;
  comprehensionDeepenMaxFolders: number;
  comprehensionContextBudgetTokens: number;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1",
  agentModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 0,
  reasoningEnabled: false,
  reasoningEffort: "medium",
  inboxFolder: "",
  ignorePatterns: "",
  manifestFilename: "_manifest.md",
  reviewContainer: "sidebar",
  indexWarnMb: 256,
  queryTopK: 5,
  queryDepth: 1,
  queryMaxFanOut: 8,
  queryMaxSeeds: 8,
  queryTopReports: 3,
  graphClusterThreshold: 0.5,
  graphInferredThreshold: 0.7,
  graphInferredMaxEdgesPerSection: 3,
  reportsContextCapTokens: 3000,
  extractionContextCapTokens: 3000,
  reportsMaxOutputTokens: 1000,
  extractionMaxOutputTokens: 1000,
  comprehensionTokenBudget: 4000,
  comprehensionRootExcerptWords: 100,
  comprehensionMocExcerptWords: 100,
  comprehensionRegularExcerptWords: 40,
  comprehensionSampleTargetFiles: 20,
  comprehensionVerifyTopK: 3,
  comprehensionVerifyQuestionsPerRound: 3,
  comprehensionToolCallBudget: 60,
  comprehensionSoftThreshold: 0.7,
  comprehensionConfirmThreshold: 0.8,
  comprehensionLowConfidenceThreshold: 0.4,
  comprehensionMinCoverage: 0.6,
  comprehensionHotTopics: "",
  comprehensionDeepenMaxFolders: 3,
  comprehensionContextBudgetTokens: 6000,
};

interface SettingMetaBase {
  name: string;
  desc: string;
  placeholder?: string;
  buttonText?: string;
}

/** A value-bearing setting — stores one PluginSettings key. */
export interface SettingValueMeta extends SettingMetaBase {
  kind: "text" | "textarea" | "dropdown" | "number";
  key: keyof PluginSettings;
  rows?: number;
  options?: Record<string, string>;
}

/** Which handler a button row runs. */
type SettingButtonAction = "test" | "clearIndex" | "clearComprehension";

/** An action row — runs a handler on click, stores nothing (no key). */
export interface SettingButtonMeta extends SettingMetaBase {
  kind: "button";
  buttonText: string;
  action: SettingButtonAction;
}

export type SettingMeta = SettingValueMeta | SettingButtonMeta;

export const SETTING_META: SettingMeta[] = [
  {
    kind: "dropdown",
    key: "reviewContainer",
    name: "Review container",
    desc: "Where clean/sort reviews and chat open: a docked sidebar pane or a centered modal overlay.",
    options: { sidebar: "Sidebar pane", modal: "Modal overlay" },
  },
  {
    kind: "text",
    key: "apiKey",
    name: "API key",
    desc: "API key for the OpenAI-compatible API. Save a copy somewhere safe — it may be erased when the plugin updates.",
    placeholder: "Sk-...",
  },
  {
    kind: "text",
    key: "apiBaseUrl",
    name: "API base URL",
    desc: "Base URL for the OpenAI-compatible API.",
    placeholder: "https://api.openai.com/v1",
  },
  {
    kind: "text",
    key: "agentModel",
    name: "Reasoning model",
    desc: "Model for cleanup, sort, and chat agents (e.g. a reasoning model like gemma-4-31b-it).",
    placeholder: "gpt-4o-mini",
  },
  {
    kind: "text",
    key: "embeddingModel",
    name: "Embedding model",
    desc: "Model for text embeddings.",
    placeholder: "text-embedding-3-small",
  },
  {
    kind: "dropdown",
    key: "reasoningEnabled",
    name: "Reasoning",
    desc: "Let the model think before answering. Off is faster and keeps extraction output clean; On suits heavy reasoning models. Works for local and hosted providers alike.",
    options: { "true": "On", "false": "Off" },
  },
  {
    kind: "dropdown",
    key: "reasoningEffort",
    name: "Thinking effort",
    desc: "How much thinking to allow when Reasoning is On. Providers or models without thinking levels simply ignore it.",
    options: Object.fromEntries(
      REASONING_EFFORTS.map((effort) => [effort, effort.charAt(0).toUpperCase() + effort.slice(1)]),
    ),
  },
  {
    kind: "button",
    action: "test",
    name: "Test connection",
    desc: "Ping the configured API (the same probe chat's tool-call detection uses) to confirm the API key and base URL are reachable.",
    buttonText: "Test connection",
  },
  {
    kind: "text",
    key: "inboxFolder",
    name: "Inbox folder",
    desc: "Folder name for inbox triage (leave empty for auto-discover).",
    placeholder: "Inbox",
  },
  {
    kind: "textarea",
    key: "ignorePatterns",
    name: "Ignore patterns",
    desc: "One glob pattern per line. The plugin skips matching files and folders during indexing and sorting.",
    placeholder: "archive/\n*.bak",
    rows: 5,
  },
  {
    kind: "text",
    key: "manifestFilename",
    name: "Manifest filename",
    desc: "Name of the vault manifest file (default: _manifest.md).",
    placeholder: "_manifest.md",
  },
  {
    kind: "number",
    key: "extractionMaxOutputTokens",
    name: "Entity extraction output cap",
    desc: "Most tokens one entity-extraction call may generate. Raise it when the build reports that extraction hit the output cap.",
    placeholder: "2000",
  },
  {
    kind: "number",
    key: "extractionContextCapTokens",
    name: "Entity extraction batch budget",
    desc: "Tokens of note text per entity-extraction call. Notes are batched under this budget. A smaller batch asks for fewer entities, so the model finishes inside the output cap.",
    placeholder: "3000",
  },
  {
    kind: "number",
    key: "reportsMaxOutputTokens",
    name: "Community report output cap",
    desc: "Most tokens one community-report call may generate. Raise it when the build reports that reports hit the output cap.",
    placeholder: "2000",
  },
  {
    kind: "number",
    key: "reportsContextCapTokens",
    name: "Community report context budget",
    desc: "Tokens of member-note text per community report. Higher feeds more evidence into each report for global-mode answers.",
    placeholder: "3000",
  },
  {
    kind: "number",
    key: "comprehensionContextBudgetTokens",
    name: "Comprehension window budget",
    desc: "Estimated tokens of the growing comprehension conversation. Older turns are compacted away beyond it, so a larger value keeps more of the vault in view per turn.",
    placeholder: "6000",
  },
  {
    kind: "button",
    action: "clearIndex",
    name: "Clear vault index",
    desc: "Deletes the GraphRAG index (index.db, its sql.js sidecars) and the embedding cache so the next build starts from scratch. Derived data — rebuilt on the next build.",
    buttonText: "Clear index",
  },
  {
    kind: "button",
    action: "clearComprehension",
    name: "Clear comprehension data",
    desc: "Deletes the comprehension ledger, state, skim cache, and summary card so the next build re-understands the vault. Derived data — rebuilt on the next build.",
    buttonText: "Clear comprehension",
  },
];

// Only the keys the Settings tab renders reach data.json: config.yaml owns
// every other knob, and data.json is the LAST merge layer. embeddingDimensions
// is the exception — losing it would change the vector width of the index.
export const PERSISTED_SETTING_KEYS: readonly (keyof PluginSettings)[] = [
  ...SETTING_META.filter((meta): meta is SettingValueMeta => meta.kind !== "button").map(
    (meta) => meta.key,
  ),
  "embeddingDimensions",
];

// Single write path for both renderers: normalize, store, persist, apply.
export function normalizeSettingValue(key: keyof PluginSettings, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (key) {
    case "apiKey":
    case "apiBaseUrl":
    case "agentModel":
    case "embeddingModel":
    case "inboxFolder":
      return value.trim();
    case "manifestFilename":
      return value.trim() || "_manifest.md";
    case "reasoningEnabled":
      // The dropdown stores "true"/"false" strings; the setting is a boolean.
      return value === "true";
    case "reasoningEffort":
      return (REASONING_EFFORTS as string[]).includes(value) ? value : "medium";
    default:
      return value;
  }
}
