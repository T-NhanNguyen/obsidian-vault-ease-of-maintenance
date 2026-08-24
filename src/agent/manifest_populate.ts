// Manifest population — the manifest-first build's Stage 1 + Stage 2
// (handoff-2). Stage 1 renders the vault tree to a pure `_manifest.md`
// skeleton (every folder marked `(needs review)`, written only when no
// manifest exists — never over a user-edited one). Stage 2 replaces those
// markers with purposes on the cold path only: it runs the LLM purpose pass
// against the comprehension summary card, asks the user (via the chat
// surface's answer channel) about folders the pass could not describe, and
// writes through the guarded marker replacement. The warm path never calls
// this module's LLM seam — it reuses the card and leaves the markers.

import { settings, thinkingEnabledFor } from "../config";
import { VaultIO } from "../io/vault_io";
import { errorMessage } from "../errors";
import { SummaryCardStore, isReusableCard } from "../comprehension/summary";
import { TocReader, TOC_HEADER } from "../indexer/manifest";
import {
  MANIFEST_H1,
  scanVaultFolders,
  buildFolderQuestion,
  sanitizePurpose,
  parseFolderPurposes,
  type VaultFolderInfo,
  type AskQuestion,
} from "./clarify";
import { parseIgnorePatterns } from "./engine";
import { LLMClient } from "./llm";
import { buildComprehendVaultTool } from "./tools_comprehend";
import { readPromptSection, fillTemplate } from "../definitions";
import manifestPopulateMd from "../../maintainer-definitions/manifest-populate.md";

/** The marker every skeleton folder carries until Stage 2 writes a purpose
 * (or the user edits the manifest). */
export const NEEDS_REVIEW = "(needs review)";

/** Whether the build reuses the comprehension (warm) or must run the loop
 * and the population pass (cold). */
export type BuildComprehensionPlan = "warm" | "cold";

/** The LLM seam for the Stage 2 purpose pass — the repo's factory-seam
 * pattern (see the comprehension runtime's setComprehensionLlmFactory). */
let manifestPopulateLlmFactory: (() => LLMClient) | null = null;
export function setManifestPopulateLlmFactory(factory: (() => LLMClient) | null): void {
  manifestPopulateLlmFactory = factory;
}
export function resetManifestPopulateLlmFactory(): void {
  manifestPopulateLlmFactory = null;
}

// ---------------------------------------------------------------------------
// Stage 1 — tree to manifest skeleton
// ---------------------------------------------------------------------------

/** Renders the §5.1 manifest format with every folder marked (needs review):
 * `## folder/ <!-- (needs review) -->` at the folder's heading depth, direct
 * files listed below (5-space indent, as the old index-derived renderer). */
function renderSkeleton(folders: VaultFolderInfo[]): string {
  const lines = [MANIFEST_H1];
  for (const folder of folders) {
    const depth = folder.path.split("/").length - 1;
    lines.push(`${"##" + "#".repeat(depth)} ${folder.path}/ <!-- ${NEEDS_REVIEW} -->`);
    for (const file of folder.files) {
      lines.push("     " + file);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Writes the skeleton manifest at the vault root. Returns the written path,
 * or null when a manifest already exists at that path (never overwrite a
 * manifest the user edited). */
export function writeSkeletonManifest(vaultPath: string): string | null {
  const io = new VaultIO(vaultPath);
  const relPath = settings.manifest.filename.replace(/\\/g, "/");
  if (io.exists(relPath)) return null;
  const folders = scanVaultFolders(vaultPath, parseIgnorePatterns(settings.ignorePatterns));
  io.writeTextAtomic(relPath, renderSkeleton(folders));
  return relPath;
}

/** Stage 2 decision (the run-once rule from handoff Part A, mirrored for the
 * build): warm when a reusable card exists and the config flag does not
 * force a refresh; cold otherwise. isReusableCard stays the single source of
 * truth — runComprehension re-validates on the cold path. */
export function buildComprehensionPlan(vaultPath: string): BuildComprehensionPlan {
  const card = new SummaryCardStore(vaultPath).readStructured();
  if (!settings.comprehension.forceRefresh && isReusableCard(card)) return "warm";
  return "cold";
}

// ---------------------------------------------------------------------------
// Stage 2 — comprehension populates the manifest
// ---------------------------------------------------------------------------

interface MarkerFolder {
  path: string;
  level: number;
}

/** Folder entries in the manifest still carrying the (needs review) marker,
 * in document order. */
function findMarkerFolders(content: string): MarkerFolder[] {
  const markers: MarkerFolder[] = [];
  for (const line of content.split("\n")) {
    const m = TOC_HEADER.exec(line);
    if (!m || m[1].length === 1) continue; // H1 = vault root marker, not a folder
    if ((m[3] || "").trim() === NEEDS_REVIEW) {
      markers.push({ path: m[2].trim().replace(/\/$/, ""), level: m[1].length });
    }
  }
  return markers;
}

/** Rebuilds each marker line whose folder got a purpose, in place; all other
 * lines are untouched. */
function replaceMarkers(content: string, purposes: Map<string, string>): string {
  return content
    .split("\n")
    .map((line) => {
      const m = TOC_HEADER.exec(line);
      if (!m || m[1].length === 1) return line;
      const folder = m[2].trim().replace(/\/$/, "");
      const purpose = purposes.get(folder);
      if (!purpose || (m[3] || "").trim() !== NEEDS_REVIEW) return line;
      return `${"#".repeat(m[1].length)} ${m[2].trim()} <!-- ${purpose} -->`;
    })
    .join("\n");
}

/** Maps LLM purpose lines (`folder/ — purpose`) onto the known folders —
 * ported from the old index-derived generateManifest, which it supersedes. */
export function parseLlmPurposes(response: string, knownFolders: Set<string>): Record<string, string> {
  const purposes: Record<string, string> = {};
  const known = new Map<string, string>();
  const knownLower = new Map<string, string>();
  for (const f of knownFolders) {
    known.set(f.replace(/\/$/, ""), f);
    knownLower.set(f.replace(/\/$/, "").toLowerCase(), f);
  }

  for (const rawLine of response.trim().split("\n")) {
    const line = rawLine.trim().replace(/^[*-]\s*/, "");
    if (!line || !line.includes("—")) continue;
    const [token, ...rest] = line.split("—");
    const purpose = rest.join("—").trim();
    const cleanToken = token.trim().replace(/\/$/, "");
    if (!purpose || purpose.startsWith("[") || purpose.length > 200) continue;

    let folder: string | undefined;
    if (known.has(cleanToken)) {
      folder = known.get(cleanToken);
    } else if (knownLower.has(cleanToken.toLowerCase())) {
      folder = knownLower.get(cleanToken.toLowerCase());
    } else {
      for (const [k, f] of known) {
        if (k.startsWith(cleanToken + " (") || k.startsWith(cleanToken + "/")) {
          folder = f;
          break;
        }
      }
    }
    if (folder) purposes[folder] = purpose;
  }
  return purposes;
}

/** Stage 2 population: replace the manifest's (needs review) markers with
 * purposes. The LLM pass describes the folders it understood from the
 * summary card (zero markers → no LLM call); the optional ask channel lets
 * the user describe leftovers; folders still undescribed keep the marker
 * (their community seed falls back to the folder name). The write is
 * guarded: every written purpose must reparse from the file (the manifest
 * format is structure-sensitive). */
export async function populateManifestFromCard(
  vaultPath: string,
  ask?: AskQuestion,
): Promise<{ replaced: number; kept: string[] }> {
  const io = new VaultIO(vaultPath);
  const manifestPath = new TocReader(vaultPath).findManifest();
  if (!manifestPath || !io.exists(manifestPath)) return { replaced: 0, kept: [] };
  const manifestContent = io.readText(manifestPath);
  const markers = findMarkerFolders(manifestContent);
  if (markers.length === 0) return { replaced: 0, kept: [] };

  const purposes = new Map<string, string>();

  // LLM purpose pass — describes the folders it understood.
  try {
    const client = manifestPopulateLlmFactory
      ? manifestPopulateLlmFactory()
      : new LLMClient(undefined, undefined, { enableThinking: thinkingEnabledFor("build") });
    const [response] = await client.chat(
      readPromptSection(manifestPopulateMd, "Populate system"),
      fillTemplate(readPromptSection(manifestPopulateMd, "Populate user"), {
        card: new SummaryCardStore(vaultPath).read() ?? "",
        manifest: manifestContent,
      }),
      [buildComprehendVaultTool()],
      1,
    );
    for (const [folder, purpose] of Object.entries(
      parseLlmPurposes(response, new Set(markers.map((m) => m.path))),
    )) {
      purposes.set(folder, purpose);
    }
  } catch (e) {
    console.warn(`  [manifest-populate] LLM purpose pass failed (${errorMessage(e)}) — leaving markers.`);
  }

  // User channel — describe the folders the pass could not.
  if (ask) {
    const foldersByPath = new Map(
      scanVaultFolders(vaultPath, parseIgnorePatterns(settings.ignorePatterns)).map((f) => [f.path, f]),
    );
    for (const marker of markers) {
      if (purposes.has(marker.path)) continue;
      const folder = foldersByPath.get(marker.path) ?? { path: marker.path, files: [] };
      const answer = await ask(buildFolderQuestion(folder));
      const purpose = answer ? sanitizePurpose(answer) : "";
      if (purpose) purposes.set(marker.path, purpose);
    }
  }

  if (purposes.size === 0) return { replaced: 0, kept: markers.map((m) => m.path) };

  const after = replaceMarkers(manifestContent, purposes);
  const reparsed = parseFolderPurposes(after);
  for (const [folder, purpose] of purposes) {
    if (reparsed.get(folder) !== purpose) {
      throw new Error(`Manifest round-trip failed for ${folder}`);
    }
  }
  io.writeTextAtomic(manifestPath.replace(/\\/g, "/"), after);
  const kept = markers.map((m) => m.path).filter((p) => !purposes.has(p));
  return { replaced: purposes.size, kept };
}
