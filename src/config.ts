// Configuration constants and settings — single source of truth.
// Ported from src/config.py

// Env var names for API key resolution
export const API_KEY_ENV_VARS = ["OMLX_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
export const CONFIG_FILENAME = "config.yaml";
export const EXAMPLE_CONFIG_FILENAME = "config.example.yaml";
// NOTE: no vault-level config file. Vaults may live in company-wide databases
// where API keys/parameters must not be shared — config lives only in the
// Settings tab (main) and the repo's plugin-dir config.yaml (fallback).

// Shared paths
export const INDEX_DB_SUFFIX = ".note-maintainer/index.db";

// Plugin settings defaults — overridable via Obsidian Settings tab
export interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

export interface EmbeddingSettings {
  model: string;
  dimensions: number;
}

export interface ManifestSettings {
  filename: string;
}

export interface QuerySettings {
  topK: number;
  /** Hybrid-search BFS levels past the resolved seeds (graph_search.ts). */
  depth: number;
  /** Max outgoing edges followed per key per level (graph_search.ts). */
  maxFanOut: number;
  /** Max resolver seeds to expand from (graph_search.ts). */
  maxSeeds: number;
  /** Max community reports grounding the global-mode answer
   * (community_reports.ts — Phase 4). */
  topReports: number;
}

// Graph-build tuning — the knobs that shape the stored graph (EDGES +
// COMMUNITIES). Single source of truth: config.yaml `graph:` section; the
// Settings tab deliberately does NOT expose them (advanced tuning).
export interface GraphSettings {
  /** Cosine threshold below which a section starts a new auto-cluster
   * (communities.ts — unseeded vaults). Higher = fewer, larger communities. */
  clusterThreshold: number;
  /** Cosine threshold for inferred (cosine-derived) edges (graph.ts).
   * Higher = fewer inferred edges, leaner EDGES table. */
  inferredThreshold: number;
  /** Max inferred edges emitted per section (graph.ts). */
  inferredMaxEdgesPerSection: number;
}

// Community-report tuning — config.yaml `reports:` section. Drives the
// build-side LLM report pass (community_reports.ts — Phase 4 of the GraphRAG
// buildout). YAML-only like graph: (advanced tuning; Settings tab untouched).
export interface ReportsSettings {
  /** Per-community token budget for the member-section context a report is
   * generated from (community_reports.ts). Higher = richer reports, more
   * LLM tokens per build. */
  contextCapTokens: number;
}

// LLM entity-extraction tuning — config.yaml `extraction:` section. Drives
// the build-side semantic-graph pass (entity_extraction.ts — Phase 5 of the
// GraphRAG buildout). YAML-only like graph:/reports: (advanced tuning;
// Settings tab untouched).
export interface ExtractionSettings {
  /** Token budget per extraction call — also the per-file cap (batch = the
   * greedy packing of files under this budget). Higher = more sections per
   * LLM call, fewer calls, richer extraction. */
  contextCapTokens: number;
}

// Vault-comprehension tuning — config.yaml `comprehension:` section. Drives
// the read-the-vault-like-a-book pipeline (src/comprehension/ — batch skim,
// assumption ledger, state machine). YAML-only like graph:/reports:/extraction:
// (advanced tuning; Settings tab untouched).
export interface ComprehensionSettings {
  /** Total excerpt budget (words) shared by the sampled regular notes.
   * (skim.ts). */
  tokenBudget: number;
  /** Full excerpt for root notes (README etc.). */
  rootExcerptWords: number;
  /** Full excerpt for MOC notes. */
  mocExcerptWords: number;
  /** Per-file cap for regular notes (adaptive: budget / sample count). */
  regularExcerptWords: number;
  /** Target sample size across all regular notes (proportional per folder). */
  sampleTargetFiles: number;
  /** Top-k snippets retrieved per verify question (graph_search hybridQuery). */
  verifyTopK: number;
  /** Verify questions asked per round (2–4; one multi-query batch). */
  verifyQuestionsPerRound: number;
  /** Hard cap on LLM tool calls per comprehension run — rounds vary in cost,
   * tool calls are the real constraint. */
  toolCallBudget: number;
  /** Soft threshold: hypotheses at/above it can make status conflicted. */
  softThreshold: number;
  /** Score at/above which the leading hypothesis confirms the run. */
  confirmThreshold: number;
  /** Score below which a verified-but-weak run is low_confidence. */
  lowConfidenceThreshold: number;
  /** Minimum sampled-coverage fraction before a run may confirm. */
  minCoverage: number;
  /** User-supplied hot-topic keywords (comma-separated in config.yaml): a
   * hit in a newly sampled file fires an optional clarification. */
  hotTopics: string[];
  /** Max folders/notes the progressive-deepening pass re-reads deeper. */
  deepenMaxFolders: number;
  /** When true, "Understand vault" always re-runs the pipeline, ignoring a
   * valid summary card (the run-once reuse rule, handoff Part A). Sticky:
   * flip it back to false to resume reuse. */
  forceRefresh?: boolean;
}

export interface AgentSettings {
  model: string;
  // Per-feature reasoning gate (config.yaml `agent.thinking.*`). Reasoning
  // models (gemma-4-31b-it) emit a long thinking phase before any visible
  // answer — measured to give no quality gain for sort/build, so everything
  // defaults OFF and is toggled per feature where quality justifies latency
  // (see .dev-vault/roadmap/thinking-enable-sort-build.md).
  thinking: ThinkingSettings;
}

export interface ThinkingSettings {
  chat: boolean;
  build: boolean;
  sort: boolean;
}

export interface PreviewSettings {
  enabled: boolean;
  ttlMinutes: number;
}

// Index-size warning threshold (index.warn_mb in config.yaml). When the
// exported index file exceeds it, DatabaseManager warns: sql.js builds grow
// ~10× the file size in RAM, so a big index is a RAM event, not just disk.
export interface IndexSettings {
  warnMb: number;
}

export interface Settings {
  vaultPath: string;
  configDir: string;
  pluginDir: string;
  dbPath: string;
  inboxFolder: string;
  ignorePatterns: string;
  api: ApiSettings;
  embedding: EmbeddingSettings;
  manifest: ManifestSettings;
  query: QuerySettings;
  agent: AgentSettings;
  preview: PreviewSettings;
  index: IndexSettings;
  graph: GraphSettings;
  reports: ReportsSettings;
  extraction: ExtractionSettings;
  comprehension: ComprehensionSettings;
}

export function defaultSettings(): Settings {
  return {
    vaultPath: "",
    configDir: "",
    pluginDir: "",
    dbPath: "",
    inboxFolder: "",
    ignorePatterns: "",
    api: {
      baseUrl: "",
      apiKey: "",
    },
    embedding: {
      model: "",
      dimensions: 0,
    },
    manifest: {
      filename: "_manifest.md",
    },
    query: {
      topK: 5,
      depth: 1,
      maxFanOut: 8,
      maxSeeds: 8,
      topReports: 3,
    },
    agent: {
      model: "",
      thinking: {
        chat: false,
        build: false,
        sort: false,
      },
    },
    preview: {
      enabled: true,
      ttlMinutes: 30,
    },
    index: {
      warnMb: 256,
    },
    graph: {
      clusterThreshold: 0.5,
      inferredThreshold: 0.7,
      inferredMaxEdgesPerSection: 3,
    },
    reports: {
      contextCapTokens: 3000,
    },
    extraction: {
      contextCapTokens: 3000,
    },
    comprehension: {
      tokenBudget: 4000,
      rootExcerptWords: 100,
      mocExcerptWords: 100,
      regularExcerptWords: 40,
      sampleTargetFiles: 20,
      verifyTopK: 3,
      verifyQuestionsPerRound: 3,
      toolCallBudget: 60,
      softThreshold: 0.7,
      confirmThreshold: 0.8,
      lowConfidenceThreshold: 0.4,
      minCoverage: 0.6,
      hotTopics: [],
      deepenMaxFolders: 3,
      forceRefresh: false,
    },
  };
}

// Global mutable settings — set once at plugin load, then read everywhere
export let settings: Settings = defaultSettings();

/** Merge a partial into a full object, ignoring keys whose new value is
 * `undefined` — a missing scalar must never clobber an existing default
 * (R2.7). Partial settings from YAML/data.json routinely omit keys. */
function definedMerge<T extends object>(target: T, partial: Partial<T>): T {
  const merged: T = { ...target };
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const value = partial[key];
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key as string] = value;
    }
  }
  return merged;
}

export function updateSettings(partial: Partial<Settings>): void {
  // Capture the previous sections BEFORE the shallow merge — after it,
  // settings.<section> IS partial.<section> (undefined keys included).
  const prev = settings;
  settings = { ...settings, ...partial };
  if (partial.api) {
    settings.api = definedMerge(prev.api, partial.api);
  }
  if (partial.embedding) {
    settings.embedding = definedMerge(prev.embedding, partial.embedding);
  }
  if (partial.manifest) {
    settings.manifest = definedMerge(prev.manifest, partial.manifest);
  }
  if (partial.query) {
    settings.query = definedMerge(prev.query, partial.query);
  }
  if (partial.agent) {
    settings.agent = definedMerge(prev.agent, partial.agent);
  }
  if (partial.preview) {
    settings.preview = definedMerge(prev.preview, partial.preview);
  }
  if (partial.index) {
    settings.index = definedMerge(prev.index, partial.index);
  }
  if (partial.graph) {
    settings.graph = definedMerge(prev.graph, partial.graph);
  }
  if (partial.reports) {
    settings.reports = definedMerge(prev.reports, partial.reports);
  }
  if (partial.extraction) {
    settings.extraction = definedMerge(prev.extraction, partial.extraction);
  }
  if (partial.comprehension) {
    settings.comprehension = definedMerge(prev.comprehension, partial.comprehension);
  }
}

export function resolveApiKey(): string | null {
  if (settings.api.apiKey) return settings.api.apiKey;
  for (const varName of API_KEY_ENV_VARS) {
    const val = process.env[varName];
    if (val) return val;
  }
  return null;
}

/**
 * Per-feature reasoning gate (config.yaml `agent.thinking.*`). Undefined
 * (absent config, partial Settings) degrades to OFF — the measured default.
 */
export function thinkingEnabledFor(feature: keyof ThinkingSettings): boolean {
  return settings.agent.thinking?.[feature] ?? false;
}
