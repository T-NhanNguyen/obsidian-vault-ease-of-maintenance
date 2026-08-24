// Build orchestrator — manifest-first build (handoff-2). Split out of
// runtime.ts so adjusting the build concern does not touch the cleanup/sort/
// chat orchestrators.
//
// Stage 1: tree → _manifest.md skeleton (write-if-absent; every folder
//   marked `(needs review)`).
// Stage 2: the comprehension populates the manifest. Warm path (a valid
//   summary card) reuses the comprehension — no LLM call, markers stay.
//   Cold path runs the comprehension loop once, then the LLM purpose pass
//   (and the user channel, on the chat surface) replaces the markers.
// Stage 3: one index build — the enriched manifest maps the communities.

import * as path from "path";
import { settings, INDEX_DB_SUFFIX } from "../config";
import { ChatReportLlm } from "../indexer/community_reports";
import { Indexer } from "../indexer/indexer";
import { TocReader } from "../indexer/manifest";
import { runComprehension } from "../comprehension/runtime_comprehension";
import {
  writeSkeletonManifest,
  buildComprehensionPlan,
  populateManifestFromCard,
  type BuildComprehensionPlan,
} from "./manifest_populate";
import type { AskQuestion } from "./clarify";
import type { ClarifyAnswerProvider } from "./tools";
import * as toolImpl from "./tools";
import type { ChatQueryResponse } from "../types";

/** Stages 1 + 2 decision: ensure the manifest skeleton exists (never
 * overwriting an existing one) and decide whether the comprehension can be
 * reused (warm) or must run (cold). main.ts branches on the plan: warm stays
 * headless, cold opens the chat surface for the comprehension's clarify
 * channel, then the population pass and the index build follow. */
export async function prepareBuild(vaultPath: string): Promise<{ plan: BuildComprehensionPlan }> {
  settings.vaultPath = vaultPath;
  settings.dbPath = path.join(vaultPath, INDEX_DB_SUFFIX);
  toolImpl.resetRegistry();
  if (!new TocReader(vaultPath).findManifest()) {
    writeSkeletonManifest(vaultPath);
  }
  return { plan: buildComprehensionPlan(vaultPath) };
}

/** Stage 3 — the single index build. The indexer reads the manifest from
 * disk on every build (ManifestParser.getCommunitySeeds), so a populated
 * manifest maps the communities from real purposes; with markers left, the
 * folder-name fallback seeds them. */
export async function runBuildIndex(vaultPath: string): Promise<string> {
  const t0 = Date.now();
  const llmSeam = new ChatReportLlm();
  const indexer = new Indexer(settings, undefined, llmSeam, llmSeam);
  await indexer.build();
  const files = indexer.scanner.scan().length;
  const elapsed = (Date.now() - t0) / 1000;
  return `Index built: ${files} files indexed in ${elapsed.toFixed(0)}s at ${settings.dbPath}`;
}

/** Stage 2 on the cold path: run the comprehension loop once (the run-once
 * check inside runComprehension re-validates the card), then populate the
 * manifest's (needs review) markers with purposes. The optional ask channel
 * (the chat surface's in-flight answer provider) reaches the user for
 * folders the LLM pass could not describe. */
export async function runComprehensionBuildStage(
  vaultPath: string,
  question: string,
  ask?: ClarifyAnswerProvider,
): Promise<ChatQueryResponse> {
  const response = await runComprehension(question, ask);
  const askFolder: AskQuestion = async (q) =>
    ask ? await ask({ question: q.prompt, context: q.context, options: q.options }) : null;
  await populateManifestFromCard(vaultPath, askFolder);
  return response;
}
