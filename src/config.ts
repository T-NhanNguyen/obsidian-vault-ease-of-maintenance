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
}

export interface AgentSettings {
  model: string;
  // Reasoning models (e.g. gemma-4-31b-it) emit a long thinking phase before
  // any visible answer. False (default) sends `enable_thinking: false` to
  // local servers. True lets the server default apply — reserved for features
  // that need reasoning (see .dev-vault/roadmap/thinking-enable-sort-build.md).
  enableThinking: boolean;
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
    },
    agent: {
      model: "",
      enableThinking: false,
    },
    preview: {
      enabled: true,
      ttlMinutes: 30,
    },
    index: {
      warnMb: 256,
    },
  };
}

// Global mutable settings — set once at plugin load, then read everywhere
export let settings: Settings = defaultSettings();

export function updateSettings(partial: Partial<Settings>): void {
  settings = { ...settings, ...partial };
  if (partial.api) {
    settings.api = { ...settings.api, ...partial.api };
  }
  if (partial.embedding) {
    settings.embedding = { ...settings.embedding, ...partial.embedding };
  }
  if (partial.manifest) {
    settings.manifest = { ...settings.manifest, ...partial.manifest };
  }
  if (partial.query) {
    settings.query = { ...settings.query, ...partial.query };
  }
  if (partial.agent) {
    settings.agent = { ...settings.agent, ...partial.agent };
  }
  if (partial.preview) {
    settings.preview = { ...settings.preview, ...partial.preview };
  }
  if (partial.index) {
    settings.index = { ...settings.index, ...partial.index };
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
