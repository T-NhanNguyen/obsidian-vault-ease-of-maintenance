// Configuration constants and settings — single source of truth.
// Ported from src/config.py

// Env var names for API key resolution
export const API_KEY_ENV_VARS = ["OMLX_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
export const CONFIG_FILENAME = "config.yaml";
export const EXAMPLE_CONFIG_FILENAME = "config.example.yaml";

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
}

export interface PreviewSettings {
  enabled: boolean;
  ttlMinutes: number;
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
    },
    preview: {
      enabled: true,
      ttlMinutes: 30,
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
}

export function resolveApiKey(): string | null {
  if (settings.api.apiKey) return settings.api.apiKey;
  for (const varName of API_KEY_ENV_VARS) {
    const val = process.env[varName];
    if (val) return val;
  }
  return null;
}
