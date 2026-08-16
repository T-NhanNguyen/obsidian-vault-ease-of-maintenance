// Build orchestrator — index build + manifest derivation. Split out of
// runtime.ts so adjusting the build concern does not touch the cleanup/sort/
// chat orchestrators.

import * as path from "path";
import { settings, INDEX_DB_SUFFIX, thinkingEnabledFor } from "../config";
import { VaultIO } from "../io/vault_io";
import { errorMessage } from "../errors";
import { LLMClient } from "./llm";
import { parseIgnorePatterns, pathMatchesPatterns } from "./engine";
import * as toolImpl from "./tools";
import { TocReader } from "../indexer/manifest";
import { Indexer } from "../indexer/indexer";
import { ChatReportLlm } from "../indexer/community_reports";
import { DatabaseManager } from "../indexer/db";

// ---------------------------------------------------------------------------
// Orchestrator: build
// ---------------------------------------------------------------------------

export async function runBuild(vaultPath: string): Promise<string> {
  settings.vaultPath = vaultPath;
  settings.dbPath = path.join(vaultPath, INDEX_DB_SUFFIX);
  toolImpl.resetRegistry();

  const t0 = Date.now();
  const manifestPath = new TocReader(vaultPath).findManifest();
  let manifestGenerated = false;

  if (!manifestPath) {
    console.warn("  [build] No _manifest.md found — building non-manifest index first, then deriving one.");
  }

  const indexer = new Indexer(settings, undefined, new ChatReportLlm());
  await indexer.build();
  const files = indexer.scanner.scan().length;

  if (!manifestPath) {
    try {
      await generateManifest(vaultPath);
      manifestGenerated = true;
      const indexer2 = new Indexer(settings, undefined, new ChatReportLlm());
      await indexer2.build();
    } catch (e) {
      console.warn(`  [build] Manifest generation failed (${errorMessage(e)}) — index remains degraded.`);
    }
  }

  const elapsed = (Date.now() - t0) / 1000;

  let msg = `Index built: ${files} files indexed in ${elapsed.toFixed(0)}s at ${settings.dbPath}`;
  if (manifestGenerated) {
    msg = `WARNING: No _manifest.md was found. A manifest was derived from the index and written to the vault — review it before running sort. ${msg}`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

export async function generateManifest(vaultPath: string): Promise<string> {
  const db = new DatabaseManager(settings.dbPath);
  const patterns = parseIgnorePatterns(settings.ignorePatterns);

  let folderFiles: Map<string, string[]> = new Map();
  let wikilinksByFolder: Map<string, Array<{ name: string; cnt: number }>> = new Map();
  let headingsByFolder: Map<string, Array<{ heading_path: string; text: string }>> = new Map();
  try {
    const rows = await db.getFolderedFiles();

    folderFiles = new Map<string, string[]>();
    for (const { folder, path: fpath } of rows) {
      if (pathMatchesPatterns(folder, patterns)) continue;
      const rel = path.relative(folder, fpath);
      if (!folderFiles.has(folder)) folderFiles.set(folder, []);
      folderFiles.get(folder)!.push(rel);
    }

    if (folderFiles.size === 0) {
      throw new Error("No indexed folders found — cannot derive a manifest.");
    }

    for (const folder of folderFiles.keys()) {
      wikilinksByFolder.set(folder, await db.getWikilinksForFolder(folder));
      headingsByFolder.set(folder, await db.getFolderHeadings(folder));
    }
  } finally {
    await db.close();
  }

  // Syllabus
  const syllabusLines = ["## Vault Tree"];
  const sortedFolders = [...folderFiles.keys()].sort();
  for (const folder of sortedFolders) {
    const depth = folder.split(path.sep).length - 1;
    syllabusLines.push("  ".repeat(depth) + folder + "/");
    for (const f of folderFiles.get(folder)!) {
      syllabusLines.push("  ".repeat(depth + 1) + f);
    }
  }

  for (const folder of sortedFolders) {
    const wikilinks = wikilinksByFolder.get(folder) || [];
    const headings = headingsByFolder.get(folder) || [];

    syllabusLines.push(`\n### ${folder}/`);
    if (wikilinks.length > 0) {
      syllabusLines.push("  Wikilinks: " + wikilinks.slice(0, 5).map((w) => `[[${w.name}]]`).join(", "));
    }
    for (const { heading_path, text } of headings) {
      const snippet = text.slice(0, 100).replace(/\n/g, " ");
      syllabusLines.push(`  - ${heading_path}: ${snippet}...`);
    }
  }
  const syllabus = syllabusLines.join("\n");

  // LLM synthesis
  const scaffoldLines = sortedFolders.map(f => `${f}/ — `);
  const scaffold = scaffoldLines.join("\n");

  const system =
    "Complete each line. The part before ' — ' is a folder path; " +
    "write the folder's PURPOSE after it, in at most 8 words.\n" +
    "Rules:\n- NEVER list file names. NEVER repeat the syllabus.\n" +
    "- Use only information present in the syllabus — no speculation.\n" +
    "- If a folder's content is ambiguous, write '(needs review)'.\n" +
    "Output ONLY the completed lines, one per folder, in the given order.";

  let purposes: Record<string, string> = {};
  try {
    const [response] = await new LLMClient(undefined, undefined, {
      enableThinking: thinkingEnabledFor("build"),
    }).chat(
      system,
      `Syllabus:\n\n${syllabus}\n\nComplete these lines:\n${scaffold}`,
      null, 1,
    );
    purposes = parseLlmPurposes(response, new Set(sortedFolders));
  } catch (e) {
    console.warn(`  [manifest-gen] LLM synthesis failed (${errorMessage(e)}) — using folder-name hints.`);
  }

  // Render §5.1 manifest
  const lines = ["# vault <!-- Auto-generated from GraphRAG index — review and edit -->"];
  for (const folder of sortedFolders) {
    const folderDepth = folder.split(path.sep).length - 1;
    const parenMatch = folder.match(/\(([^)]+)\)/);
    let purpose: string;
    if (parenMatch) {
      purpose = parenMatch[1].trim();
    } else {
      purpose = purposes[folder] || "(needs review)";
    }
    const indent = "##" + "#".repeat(folderDepth);
    lines.push(`${indent} ${folder}/ <!-- ${purpose} -->`);
    for (const f of folderFiles.get(folder)!) {
      lines.push("     " + f);
    }
    lines.push("");
  }

  const manifestContent = lines.join("\n").trimEnd() + "\n";
  const manifestPath = path.join(vaultPath, settings.manifest.filename);
  new VaultIO(vaultPath).writeTextAtomic(
    settings.manifest.filename.replace(/\\/g, "/"),
    manifestContent,
  );
  return manifestPath;
}

function parseLlmPurposes(response: string, knownFolders: Set<string>): Record<string, string> {
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
