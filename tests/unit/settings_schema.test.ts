// The Settings-tab schema: token-cap parsing bounds, the persisted-key set, and
// the single flat-to-nested projection both plugin paths use.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLUGIN_SETTINGS,
  PERSISTED_SETTING_KEYS,
  SETTING_META,
  TOKEN_CAP_MAX,
  TOKEN_CAP_MIN,
  normalizeSettingValue,
  parseTokenCap,
} from "../../src/settings/schema";
import { pluginSettingsToNested } from "../../src/settings/nested";

const TOKEN_CAP_KEYS = [
  "extractionMaxOutputTokens",
  "extractionContextCapTokens",
  "reportsMaxOutputTokens",
  "reportsContextCapTokens",
  "comprehensionContextBudgetTokens",
] as const;

describe("parseTokenCap", () => {
  it("accepts a token count inside the bounds", () => {
    expect(parseTokenCap("2000")).toBe(2000);
  });

  it("clamps a value below the minimum up to the minimum", () => {
    expect(parseTokenCap("0")).toBe(TOKEN_CAP_MIN);
    expect(parseTokenCap("-500")).toBe(TOKEN_CAP_MIN);
  });

  it("clamps a value above the maximum down to the maximum", () => {
    expect(parseTokenCap("900000")).toBe(TOKEN_CAP_MAX);
  });

  it("rejects input that is not a number so the stored value survives", () => {
    expect(parseTokenCap("")).toBeNull();
    expect(parseTokenCap("   ")).toBeNull();
    expect(parseTokenCap("abc")).toBeNull();
    expect(parseTokenCap("2e")).toBeNull();
  });

  it("truncates a fractional token count", () => {
    expect(parseTokenCap("2500.7")).toBe(2500);
  });
});

describe("SETTING_META token caps", () => {
  it("exposes exactly the five build-side caps as numeric rows", () => {
    const numericKeys = SETTING_META.flatMap((meta) => (meta.kind === "number" ? [meta.key] : []));

    expect([...numericKeys].sort()).toEqual([...TOKEN_CAP_KEYS].sort());
  });

  it("persists every token cap into data.json", () => {
    for (const key of TOKEN_CAP_KEYS) {
      expect(PERSISTED_SETTING_KEYS).toContain(key);
    }
  });

  it("keeps the YAML-only knobs out of data.json", () => {
    expect(PERSISTED_SETTING_KEYS).not.toContain("queryTopK");
    expect(PERSISTED_SETTING_KEYS).not.toContain("graphInferredThreshold");
    expect(PERSISTED_SETTING_KEYS).not.toContain("comprehensionTokenBudget");
  });

  it("gives every rendered row a name and a description", () => {
    for (const meta of SETTING_META) {
      expect(meta.name).toBeTruthy();
      expect(meta.desc).toBeTruthy();
    }
  });
});

describe("normalizeSettingValue", () => {
  it("trims a text field", () => {
    expect(normalizeSettingValue("agentModel", "  local-model  ")).toBe("local-model");
  });

  it("maps the reasoning dropdown strings onto booleans", () => {
    expect(normalizeSettingValue("reasoningEnabled", "true")).toBe(true);
    expect(normalizeSettingValue("reasoningEnabled", "false")).toBe(false);
  });

  it("falls back to medium for an unknown thinking effort", () => {
    expect(normalizeSettingValue("reasoningEffort", "extreme")).toBe("medium");
  });

  it("keeps the manifest filename default when the field is cleared", () => {
    expect(normalizeSettingValue("manifestFilename", "   ")).toBe("_manifest.md");
  });
});

describe("pluginSettingsToNested", () => {
  it("carries every token cap onto its nested section", () => {
    const nested = pluginSettingsToNested({
      ...DEFAULT_PLUGIN_SETTINGS,
      extractionMaxOutputTokens: 4321,
      extractionContextCapTokens: 2200,
      reportsMaxOutputTokens: 3300,
      reportsContextCapTokens: 4400,
      comprehensionContextBudgetTokens: 9000,
    });

    expect(nested.extraction?.maxOutputTokens).toBe(4321);
    expect(nested.extraction?.contextCapTokens).toBe(2200);
    expect(nested.reports?.maxOutputTokens).toBe(3300);
    expect(nested.reports?.contextCapTokens).toBe(4400);
    expect(nested.comprehension?.contextBudgetTokens).toBe(9000);
  });

  it("always projects the comprehension and index sections", () => {
    const nested = pluginSettingsToNested(DEFAULT_PLUGIN_SETTINGS);

    // Regression pin: the hand-written startup literal omitted both sections.
    expect(nested.comprehension?.toolCallBudget).toBe(
      DEFAULT_PLUGIN_SETTINGS.comprehensionToolCallBudget,
    );
    expect(nested.index?.warnMb).toBe(DEFAULT_PLUGIN_SETTINGS.indexWarnMb);
  });

  it("resolves the embedding dimensions from the configured value", () => {
    const nested = pluginSettingsToNested({
      ...DEFAULT_PLUGIN_SETTINGS,
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1024,
    });

    expect(nested.embedding?.dimensions).toBe(1024);
  });

  it("falls back to the legacy dimension inference when none is configured", () => {
    const nested = pluginSettingsToNested({
      ...DEFAULT_PLUGIN_SETTINGS,
      embeddingModel: "text-embedding-3-large",
      embeddingDimensions: 0,
    });

    expect(nested.embedding?.dimensions).toBe(3072);
  });

  it("splits the comma-separated hot topics into an array", () => {
    const nested = pluginSettingsToNested({
      ...DEFAULT_PLUGIN_SETTINGS,
      comprehensionHotTopics: "a, b ,c",
    });

    expect(nested.comprehension?.hotTopics).toEqual(["a", "b", "c"]);
  });
});
