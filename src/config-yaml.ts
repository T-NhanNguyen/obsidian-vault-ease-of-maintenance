// config.yaml loader — pure TypeScript, no obsidian dependency.
//
// Config resolution is layered. The Obsidian Settings tab (data.json) is the
// MAIN config and always wins; the repo's plugin-dir config.yaml is the only
// fallback file:
//
//   DEFAULT_PLUGIN_SETTINGS  ←  <pluginDir>/config.yaml  (repo-local dev)
//   ←  data.json  (Settings tab — MAIN, wins)
//
// There is deliberately NO vault-level config file: a vault may live in a
// company-wide database where API keys/parameters must not be shared.
// Plugin-store users have no config.yaml at all and configure the Settings
// tab only; repo cloners copy config.example.yaml → config.yaml.
//
// Only the YAML subset used by this plugin's config files is parsed: two-level
// nesting (sections like `api:`, `embedding:`, `agent:`), `key: value`
// scalars, `#` comments, quoted strings, booleans, and integers. Unknown keys
// are dropped by the explicit mapping below — nothing is guessed.

export interface YamlPluginSettings {
  apiBaseUrl?: string;
  apiKey?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  agentModel?: string;
  agentThinkingChat?: boolean;
  agentThinkingBuild?: boolean;
  agentThinkingSort?: boolean;
  manifestFilename?: string;
  inboxFolder?: string;
  ignorePatterns?: string;
  indexWarnMb?: number;
  queryTopK?: number;
  queryDepth?: number;
  queryMaxFanOut?: number;
  queryMaxSeeds?: number;
  graphClusterThreshold?: number;
  graphInferredThreshold?: number;
  graphInferredMaxEdgesPerSection?: number;
}

interface YamlSection {
  [key: string]: string | number | boolean;
}

type YamlTree = Record<string, YamlSection | string | number | boolean>;

function stripInlineComment(line: string): string {
  // A "#" preceded by whitespace starts a comment. URLs with fragments
  // ("http://x/y#z") keep the "#" because it is not preceded by whitespace.
  const idx = line.search(/\s+#/);
  return idx === -1 ? line : line.slice(0, idx);
}

function parseScalar(rawValue: string): string | number | boolean {
  const value = rawValue.trim();
  if (value === "") return "";
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value) || /^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

export function parseConfigYaml(text: string): YamlPluginSettings {
  const tree: YamlTree = {};
  let section: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();

    if (rawValue === "") {
      // Section header (e.g. `api:`).
      section = key;
      tree[key] = {};
    } else if (section) {
      const sectionObj = tree[section];
      if (sectionObj && typeof sectionObj === "object") {
        sectionObj[key] = parseScalar(rawValue);
      }
    } else {
      tree[key] = parseScalar(rawValue);
    }
  }

  const api = tree["api"] as YamlSection | undefined;
  const embedding = tree["embedding"] as YamlSection | undefined;
  const agent = tree["agent"] as YamlSection | undefined;
  const thinking = tree["thinking"] as YamlSection | undefined;
  const manifest = tree["manifest"] as YamlSection | undefined;
  const index = tree["index"] as YamlSection | undefined;
  const query = tree["query"] as YamlSection | undefined;
  const graph = tree["graph"] as YamlSection | undefined;

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

  return {
    inboxFolder: str(tree["inbox_folder"]),
    ignorePatterns: str(tree["ignore_patterns"]),
    apiBaseUrl: str(api?.["base_url"]),
    apiKey: str(api?.["api_key"]),
    embeddingModel: str(embedding?.["model"]),
    embeddingDimensions: num(embedding?.["dimensions"]),
    agentModel: str(agent?.["model"]),
    agentThinkingChat: bool(thinking?.["chat"]),
    agentThinkingBuild: bool(thinking?.["build"]),
    agentThinkingSort: bool(thinking?.["sort"]),
    manifestFilename: str(manifest?.["filename"]),
    indexWarnMb: num(index?.["warn_mb"]),
    queryTopK: num(query?.["top_k"]),
    queryDepth: num(query?.["depth"]),
    queryMaxFanOut: num(query?.["max_fan_out"]),
    queryMaxSeeds: num(query?.["max_seeds"]),
    graphClusterThreshold: num(graph?.["cluster_threshold"]),
    graphInferredThreshold: num(graph?.["inferred_threshold"]),
    graphInferredMaxEdgesPerSection: num(graph?.["inferred_max_edges_per_section"]),
  };
}

// Merge config layers with strict priority: later layers win. Used by main.ts
// for DEFAULT_PLUGIN_SETTINGS ← <pluginDir>/config.yaml ← data.json.
// Pure + unit-tested so the precedence order is pinned.
export function mergeConfigLayers<T extends object>(
  defaults: T,
  ...layers: Array<Partial<T> | null | undefined>
): T {
  const present = layers.filter((l): l is Partial<T> => !!l);
  return Object.assign({}, defaults, ...present) as T;
}
