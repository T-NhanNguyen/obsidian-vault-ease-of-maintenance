// config.yaml loader tests.
//
// config.yaml is the single source of truth for model + connection settings.
// These tests pin the mapping (snake_case YAML -> camelCase PluginSettings
// shape), the scalar parsing (quoted strings, numbers, booleans, empty
// values), and comment handling (full-line and inline).

import { describe, it, expect } from "vitest";
import { parseConfigYaml, mergeConfigLayers } from "../../src/config-yaml";

const CONFIG_FIXTURE = `# Vault Ease of Maintenance — Local Configuration
vault_path: ""          # informational
db_path: ""

inbox_folder: ""
ignore_patterns: ""

api:
  base_url: http://127.0.0.1:8000/v1
  api_key: "1234"

manifest:
  filename: _manifest.md

embedding:
  model: embeddinggemma-300m-8bit
  dimensions: 768        # measured: returns 768-dim vectors

agent:
  model: gemma-4-31b-it-4bit

# Per-feature reasoning gate. Reasoning models (gemma-4-31b-it) emit a long
# thinking phase (reasoning_content) before any visible answer — a big
# latency cost. OFF by default (measured: no quality gain for sort/build);
# toggle per feature where quality justifies it. See
# .dev-vault/roadmap/thinking-enable-sort-build.md
thinking:
  chat: false
  build: false
  sort: false

preview:
  enabled: true
  ttl_minutes: 30

query:
  top_k: 5
  top_reports: 3

graph:
  cluster_threshold: 0.5
  inferred_threshold: 0.7
  inferred_max_edges_per_section: 3

reports:
  context_cap_tokens: 3000
`;

describe("parseConfigYaml", () => {
  it("maps snake_case config.yaml sections onto the PluginSettings shape", () => {
    const cfg = parseConfigYaml(CONFIG_FIXTURE);
    expect(cfg.apiBaseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(cfg.apiKey).toBe("1234");
    expect(cfg.embeddingModel).toBe("embeddinggemma-300m-8bit");
    expect(cfg.embeddingDimensions).toBe(768);
    expect(cfg.agentModel).toBe("gemma-4-31b-it-4bit");
    expect(cfg.agentThinkingChat).toBe(false);
    expect(cfg.agentThinkingBuild).toBe(false);
    expect(cfg.agentThinkingSort).toBe(false);
    expect(cfg.manifestFilename).toBe("_manifest.md");
    expect(cfg.inboxFolder).toBe("");
    expect(cfg.ignorePatterns).toBe("");
  });

  it("maps the query, graph, and reports tuning sections", () => {
    const cfg = parseConfigYaml(CONFIG_FIXTURE);
    expect(cfg.queryTopK).toBe(5);
    expect(cfg.queryTopReports).toBe(3);
    expect(cfg.queryDepth).toBe(undefined); // not in the fixture — defaults apply
    expect(cfg.graphClusterThreshold).toBe(0.5);
    expect(cfg.graphInferredThreshold).toBe(0.7);
    expect(cfg.graphInferredMaxEdgesPerSection).toBe(3);
    expect(cfg.reportsContextCapTokens).toBe(3000);

    const tuned = parseConfigYaml(`
query:
  top_k: 10
  depth: 2
  max_fan_out: 12
  max_seeds: 4
  top_reports: 6
graph:
  cluster_threshold: 0.6
  inferred_threshold: 0.8
  inferred_max_edges_per_section: 5
reports:
  context_cap_tokens: 6000
`);
    expect(tuned.queryTopK).toBe(10);
    expect(tuned.queryDepth).toBe(2);
    expect(tuned.queryMaxFanOut).toBe(12);
    expect(tuned.queryMaxSeeds).toBe(4);
    expect(tuned.queryTopReports).toBe(6);
    expect(tuned.graphClusterThreshold).toBe(0.6);
    expect(tuned.graphInferredThreshold).toBe(0.8);
    expect(tuned.graphInferredMaxEdgesPerSection).toBe(5);
    expect(tuned.reportsContextCapTokens).toBe(6000);
  });

  it("maps the per-feature thinking section", () => {
    const cfg = parseConfigYaml(
      "agent:\n  model: gemma-4-31b-it-4bit\nthinking:\n  chat: true\n  build: false\n  sort: true\n"
    );
    expect(cfg.agentModel).toBe("gemma-4-31b-it-4bit");
    expect(cfg.agentThinkingChat).toBe(true);
    expect(cfg.agentThinkingBuild).toBe(false);
    expect(cfg.agentThinkingSort).toBe(true);
  });

  it("parses booleans, integers, and quoted strings via the mapping", () => {
    const direct = parseConfigYaml(
      "agent:\n  model: 'x'\nthinking:\n  chat: true\n  build: true\nembedding:\n  dimensions: 1024"
    );
    expect(direct.agentModel).toBe("x");
    expect(direct.agentThinkingChat).toBe(true);
    expect(direct.agentThinkingBuild).toBe(true);
    expect(direct.agentThinkingSort).toBe(undefined); // not set → default applies
    expect(direct.embeddingDimensions).toBe(1024);
  });

  it("handles inline comments without breaking URLs or values", () => {
    const cfg = parseConfigYaml(
      "api:\n  base_url: https://openrouter.ai/api/v1 # hosted\n  api_key: sk-abc # secret\nagent:\n  model: gemma-3-4b-it-qat-4bit\n"
    );
    expect(cfg.apiBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKey).toBe("sk-abc");
    expect(cfg.agentModel).toBe("gemma-3-4b-it-qat-4bit");
  });

  it("drops unknown keys and ignores malformed lines", () => {
    const cfg = parseConfigYaml(
      "unknown_top: x\nno_colon_line\nagent:\n  model: m\n  mystery: 1\n"
    );
    expect(cfg.agentModel).toBe("m");
    expect(cfg).not.toHaveProperty("unknownTop");
    expect(cfg).not.toHaveProperty("mystery");
    // The legacy flat enable_thinking key is dropped — the per-feature
    // subsection replaces it (unknown keys are ignored, never guessed).
    expect(parseConfigYaml("agent:\n  enable_thinking: true\n").agentThinkingChat).toBe(undefined);
  });

  it("returns an empty mapping for empty or comment-only input", () => {
    expect(parseConfigYaml("")).toEqual({});
    expect(parseConfigYaml("# just a comment\n\n# another\n")).toEqual({});
  });
});

describe("mergeConfigLayers", () => {
  it("applies strict later-wins priority: defaults ← config.yaml ← Settings tab", () => {
    const defaults = { apiBaseUrl: "https://api.openai.com/v1", embeddingModel: "text-embedding-3-small", embeddingDimensions: 0, agentModel: "gpt-4o-mini" };
    const pluginDirYaml = { apiBaseUrl: "http://127.0.0.1:8000/v1", embeddingModel: "embeddinggemma-300m-8bit", agentModel: "gemma-3-4b-it-qat-4bit" };
    const dataJson = { agentModel: "gpt-4o-mini" }; // Settings tab — MAIN, wins

    const merged = mergeConfigLayers(defaults, pluginDirYaml, dataJson);
    expect(merged).toEqual({
      apiBaseUrl: "http://127.0.0.1:8000/v1",
      embeddingModel: "embeddinggemma-300m-8bit",
      embeddingDimensions: 0,
      agentModel: "gpt-4o-mini",
    });
  });

  it("ignores null/undefined layers (absent config files)", () => {
    const merged = mergeConfigLayers({ a: 1 }, undefined, null, { b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
  });
});

describe("thinkingEnabledFor", () => {
  it("reads the per-feature gate from settings and defaults to OFF", async () => {
    const { thinkingEnabledFor, updateSettings, defaultSettings } = await import("../../src/config");
    updateSettings(defaultSettings());
    expect(thinkingEnabledFor("chat")).toBe(false);
    expect(thinkingEnabledFor("build")).toBe(false);
    expect(thinkingEnabledFor("sort")).toBe(false);

    updateSettings({ agent: { model: "", thinking: { chat: true, build: false, sort: true } } });
    expect(thinkingEnabledFor("chat")).toBe(true);
    expect(thinkingEnabledFor("build")).toBe(false);
    expect(thinkingEnabledFor("sort")).toBe(true);
  });
});
