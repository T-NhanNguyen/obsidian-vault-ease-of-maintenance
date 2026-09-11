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

# The ONE reasoning control — local and hosted providers share it.
reasoning:
  enabled: false
  effort: medium

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
    expect(cfg.reasoningEnabled).toBe(false);
    expect(cfg.reasoningEffort).toBe("medium");
    expect(cfg.manifestFilename).toBe("_manifest.md");
    expect(cfg.inboxFolder).toBe("");
    expect(cfg.ignorePatterns).toBe("");
  });

  it("maps the comprehension tuning section (hot_topics is scalar-only)", () => {
    const cfg = parseConfigYaml(`
comprehension:
  token_budget: 2000
  root_excerpt_words: 50
  moc_excerpt_words: 60
  regular_excerpt_words: 20
  sample_target_files: 15
  verify_top_k: 5
  verify_questions_per_round: 4
  tool_call_budget: 40
  soft_threshold: 0.6
  confirm_threshold: 0.75
  low_confidence_threshold: 0.3
  min_coverage: 0.5
  hot_topics: "colmac, recipes"
  deepen_max_folders: 2
  force_refresh: true
`);
    expect(cfg.comprehensionTokenBudget).toBe(2000);
    expect(cfg.comprehensionRootExcerptWords).toBe(50);
    expect(cfg.comprehensionMocExcerptWords).toBe(60);
    expect(cfg.comprehensionRegularExcerptWords).toBe(20);
    expect(cfg.comprehensionSampleTargetFiles).toBe(15);
    expect(cfg.comprehensionVerifyTopK).toBe(5);
    expect(cfg.comprehensionVerifyQuestionsPerRound).toBe(4);
    expect(cfg.comprehensionToolCallBudget).toBe(40);
    expect(cfg.comprehensionSoftThreshold).toBe(0.6);
    expect(cfg.comprehensionConfirmThreshold).toBe(0.75);
    expect(cfg.comprehensionLowConfidenceThreshold).toBe(0.3);
    expect(cfg.comprehensionMinCoverage).toBe(0.5);
    expect(cfg.comprehensionHotTopics).toBe("colmac, recipes");
    expect(cfg.comprehensionDeepenMaxFolders).toBe(2);
    expect(cfg.comprehensionForceRefresh).toBe(true);

    // Absent keys stay undefined — code defaults apply.
    expect(parseConfigYaml("").comprehensionTokenBudget).toBe(undefined);
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

  it("maps the reasoning section", () => {
    const cfg = parseConfigYaml(
      "agent:\n  model: gemma-4-31b-it-4bit\nreasoning:\n  enabled: true\n  effort: high\n"
    );
    expect(cfg.agentModel).toBe("gemma-4-31b-it-4bit");
    expect(cfg.reasoningEnabled).toBe(true);
    expect(cfg.reasoningEffort).toBe("high");
  });

  it("maps the build-side output caps and the comprehension window budget", () => {
    const cfg = parseConfigYaml(
      "reports:\n  max_output_tokens: 900\nextraction:\n  max_output_tokens: 700\n" +
        "comprehension:\n  context_budget_tokens: 5000\n"
    );
    expect(cfg.reportsMaxOutputTokens).toBe(900);
    expect(cfg.extractionMaxOutputTokens).toBe(700);
    expect(cfg.comprehensionContextBudgetTokens).toBe(5000);
  });

  it("parses booleans, integers, and quoted strings via the mapping", () => {
    const direct = parseConfigYaml(
      "agent:\n  model: 'x'\nreasoning:\n  enabled: true\nembedding:\n  dimensions: 1024"
    );
    expect(direct.agentModel).toBe("x");
    expect(direct.reasoningEnabled).toBe(true);
    expect(direct.reasoningEffort).toBe(undefined); // not set → default applies
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
    // The legacy per-feature gate is dropped — the global reasoning section
    // replaces it (unknown keys are ignored, never guessed).
    expect(parseConfigYaml("agent:\n  enable_thinking: true\n").reasoningEnabled).toBe(undefined);
    expect(parseConfigYaml("thinking:\n  chat: true\n").reasoningEnabled).toBe(undefined);
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

describe("reasoningConfig", () => {
  it("reads the global reasoning setting and defaults to OFF at medium effort", async () => {
    const { reasoningConfig, updateSettings, defaultSettings } = await import("../../src/config");
    updateSettings(defaultSettings());
    expect(reasoningConfig()).toEqual({ enabled: false, effort: "medium" });

    updateSettings({ reasoning: { enabled: true, effort: "high" } });
    expect(reasoningConfig()).toEqual({ enabled: true, effort: "high" });

    // Partial Settings (tests, fresh installs) degrade to the default.
    updateSettings({ reasoning: undefined });
    expect(reasoningConfig()).toEqual({ enabled: false, effort: "medium" });
  });
});
