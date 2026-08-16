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
  enable_thinking: false

preview:
  enabled: true
  ttl_minutes: 30

query:
  top_k: 5

graph:
  cluster_threshold: 0.5
  inferred_threshold: 0.7
  inferred_max_edges_per_section: 3
`;

describe("parseConfigYaml", () => {
  it("maps snake_case config.yaml sections onto the PluginSettings shape", () => {
    const cfg = parseConfigYaml(CONFIG_FIXTURE);
    expect(cfg.apiBaseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(cfg.apiKey).toBe("1234");
    expect(cfg.embeddingModel).toBe("embeddinggemma-300m-8bit");
    expect(cfg.embeddingDimensions).toBe(768);
    expect(cfg.agentModel).toBe("gemma-4-31b-it-4bit");
    expect(cfg.enableThinking).toBe(false);
    expect(cfg.manifestFilename).toBe("_manifest.md");
    expect(cfg.inboxFolder).toBe("");
    expect(cfg.ignorePatterns).toBe("");
  });

  it("maps the query and graph tuning sections", () => {
    const cfg = parseConfigYaml(CONFIG_FIXTURE);
    expect(cfg.queryTopK).toBe(5);
    expect(cfg.queryDepth).toBe(undefined); // not in the fixture — defaults apply
    expect(cfg.graphClusterThreshold).toBe(0.5);
    expect(cfg.graphInferredThreshold).toBe(0.7);
    expect(cfg.graphInferredMaxEdgesPerSection).toBe(3);

    const tuned = parseConfigYaml(`
query:
  top_k: 10
  depth: 2
  max_fan_out: 12
  max_seeds: 4
graph:
  cluster_threshold: 0.6
  inferred_threshold: 0.8
  inferred_max_edges_per_section: 5
`);
    expect(tuned.queryTopK).toBe(10);
    expect(tuned.queryDepth).toBe(2);
    expect(tuned.queryMaxFanOut).toBe(12);
    expect(tuned.queryMaxSeeds).toBe(4);
    expect(tuned.graphClusterThreshold).toBe(0.6);
    expect(tuned.graphInferredThreshold).toBe(0.8);
    expect(tuned.graphInferredMaxEdgesPerSection).toBe(5);
  });

  it("parses booleans, integers, and quoted strings via the mapping", () => {
    const direct = parseConfigYaml(
      "agent:\n  enable_thinking: true\n  model: 'x'\nembedding:\n  dimensions: 1024"
    );
    expect(direct.enableThinking).toBe(true);
    expect(direct.agentModel).toBe("x");
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
  });

  it("returns an empty mapping for empty or comment-only input", () => {
    expect(parseConfigYaml("")).toEqual({});
    expect(parseConfigYaml("# just a comment\n\n# another\n")).toEqual({});
  });
});

describe("mergeConfigLayers", () => {
  it("applies strict later-wins priority: defaults ← config.yaml ← Settings tab", () => {
    const defaults = { apiBaseUrl: "https://api.openai.com/v1", embeddingModel: "text-embedding-3-small", embeddingDimensions: 0, agentModel: "gpt-4o-mini", enableThinking: false };
    const pluginDirYaml = { apiBaseUrl: "http://127.0.0.1:8000/v1", embeddingModel: "embeddinggemma-300m-8bit", agentModel: "gemma-3-4b-it-qat-4bit", enableThinking: false };
    const dataJson = { agentModel: "gpt-4o-mini" }; // Settings tab — MAIN, wins

    const merged = mergeConfigLayers(defaults, pluginDirYaml, dataJson);
    expect(merged).toEqual({
      apiBaseUrl: "http://127.0.0.1:8000/v1",
      embeddingModel: "embeddinggemma-300m-8bit",
      embeddingDimensions: 0,
      agentModel: "gpt-4o-mini",
      enableThinking: false,
    });
  });

  it("ignores null/undefined layers (absent config files)", () => {
    const merged = mergeConfigLayers({ a: 1 }, undefined, null, { b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
  });
});
