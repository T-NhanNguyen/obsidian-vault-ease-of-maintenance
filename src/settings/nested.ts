// ---------------------------------------------------------------------------
// Flat settings → nested runtime settings
// ---------------------------------------------------------------------------
// PluginSettings is flat (one field per Settings-tab control); the runtime
// Settings in src/config.ts is nested (one section per subsystem). Both plugin
// startup and every Settings-tab edit project through THIS function, so a whole
// section cannot be wired into one path and forgotten in the other — the
// comprehension section and index.warnMb were missing from the startup path
// until this refactor.

import { settings as runtimeSettings, type Settings } from "../config";
import type { PluginSettings } from "./schema";

// The legacy name-based inference (1536/3072) is only a last-resort fallback
// when no dimension was configured.
export function resolveEmbeddingDimensions(model: string, configured: number): number {
  if (configured > 0) return configured;
  return model.includes("large") ? 3072 : 1536;
}

export function pluginSettingsToNested(s: PluginSettings): Partial<Settings> {
  return {
    api: {
      apiKey: s.apiKey,
      baseUrl: s.apiBaseUrl,
    },
    embedding: {
      model: s.embeddingModel,
      dimensions: resolveEmbeddingDimensions(s.embeddingModel, s.embeddingDimensions),
    },
    agent: {
      model: s.agentModel,
    },
    reasoning: {
      enabled: s.reasoningEnabled,
      effort: s.reasoningEffort,
    },
    inboxFolder: s.inboxFolder,
    ignorePatterns: s.ignorePatterns,
    manifest: {
      filename: s.manifestFilename,
    },
    index: {
      warnMb: s.indexWarnMb,
    },
    query: {
      topK: s.queryTopK,
      depth: s.queryDepth,
      maxFanOut: s.queryMaxFanOut,
      maxSeeds: s.queryMaxSeeds,
      topReports: s.queryTopReports,
    },
    graph: {
      clusterThreshold: s.graphClusterThreshold,
      inferredThreshold: s.graphInferredThreshold,
      inferredMaxEdgesPerSection: s.graphInferredMaxEdgesPerSection,
    },
    reports: {
      contextCapTokens: s.reportsContextCapTokens,
      maxOutputTokens: s.reportsMaxOutputTokens,
    },
    extraction: {
      contextCapTokens: s.extractionContextCapTokens,
      maxOutputTokens: s.extractionMaxOutputTokens,
    },
    comprehension: {
      contextBudgetTokens: s.comprehensionContextBudgetTokens ?? runtimeSettings.comprehension.contextBudgetTokens,
      tokenBudget: s.comprehensionTokenBudget ?? runtimeSettings.comprehension.tokenBudget,
      rootExcerptWords: s.comprehensionRootExcerptWords ?? runtimeSettings.comprehension.rootExcerptWords,
      mocExcerptWords: s.comprehensionMocExcerptWords ?? runtimeSettings.comprehension.mocExcerptWords,
      regularExcerptWords: s.comprehensionRegularExcerptWords ?? runtimeSettings.comprehension.regularExcerptWords,
      sampleTargetFiles: s.comprehensionSampleTargetFiles ?? runtimeSettings.comprehension.sampleTargetFiles,
      verifyTopK: s.comprehensionVerifyTopK ?? runtimeSettings.comprehension.verifyTopK,
      verifyQuestionsPerRound: s.comprehensionVerifyQuestionsPerRound ?? runtimeSettings.comprehension.verifyQuestionsPerRound,
      toolCallBudget: s.comprehensionToolCallBudget ?? runtimeSettings.comprehension.toolCallBudget,
      softThreshold: s.comprehensionSoftThreshold ?? runtimeSettings.comprehension.softThreshold,
      confirmThreshold: s.comprehensionConfirmThreshold ?? runtimeSettings.comprehension.confirmThreshold,
      lowConfidenceThreshold: s.comprehensionLowConfidenceThreshold ?? runtimeSettings.comprehension.lowConfidenceThreshold,
      minCoverage: s.comprehensionMinCoverage ?? runtimeSettings.comprehension.minCoverage,
      hotTopics: (s.comprehensionHotTopics || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      deepenMaxFolders: s.comprehensionDeepenMaxFolders ?? runtimeSettings.comprehension.deepenMaxFolders,
    },
  };
}
