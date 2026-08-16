// Top-level indexer orchestrator for v2 GraphRAG.
// Ported from src/indexer/indexer.py

import * as crypto from "crypto";
import * as path from "path";
import { settings, Settings } from "../config";
import { errorMessage } from "../errors";
import { VaultIO } from "../io/vault_io";
import { parseIgnorePatterns } from "../agent/engine";
import { Chunker, SectionInfo } from "./chunker";
import { DatabaseManager, FileWriteInput, SearchResult, SectionWriteInput } from "./db";
import { hybridQuery, HybridQueryOptions } from "./graph_search";
import { assignCommunities, computeSeedEmbeddings, ensureAutoCommunities } from "./communities";
import { generateCommunityReports, ReportLlm } from "./community_reports";
import { Embedder, IEmbedder } from "./embedder";
import { GraphBuilder } from "./graph";
import { ManifestParser } from "./manifest";
import { FileInfo, Scanner } from "./scanner";

// Journal replay entry — journal rows written by the sort pipeline.
interface JournalEntryRecord {
  verdict?: string;
  file_path?: string;
  old_path?: string;
}

export class Indexer {
  settings: Settings;
  db: DatabaseManager;
  scanner: Scanner;
  chunker: Chunker;
  graph: GraphBuilder;
  embedder: IEmbedder;
  manifestParser: ManifestParser;
  private io: VaultIO;
  private readonly reportLlm?: ReportLlm;

  constructor(customSettings?: Settings, embedder?: IEmbedder, reportLlm?: ReportLlm) {
    this.settings = customSettings || settings;
    this.io = new VaultIO(this.settings.vaultPath);
    this.db = new DatabaseManager(this.settings.dbPath);
    this.scanner = new Scanner(this.settings.vaultPath, parseIgnorePatterns(this.settings.ignorePatterns));
    this.chunker = new Chunker();
    this.graph = new GraphBuilder(this.db, {
      // `?.` guard: partial Settings in tests degrade to module defaults.
      inferredThreshold: this.settings.graph?.inferredThreshold,
      inferredMaxEdgesPerSection: this.settings.graph?.inferredMaxEdgesPerSection,
    });
    this.embedder = embedder || new Embedder(this.settings);
    this.manifestParser = new ManifestParser(this.settings.vaultPath);
    this.reportLlm = reportLlm;
  }

  // ------------------------------------------------------------------
  // Cold build
  // ------------------------------------------------------------------

  async build(): Promise<void> {
    try {
      await this.db.initialize();
      await this.db.clearAll();

      const manifestPath = this.manifestParser.findManifest();
      const seeds = this.manifestParser.getCommunitySeeds(manifestPath);
      const contentTypeDefaults = this.manifestParser.getContentTypeDefaults(manifestPath);
      const manifestHash = this.manifestParser.hashManifest(manifestPath);

      // Insert manifest-based communities
      for (const seed of seeds) {
        await this.db.insertCommunity({
          communityId: seed.communityId,
          seedSource: seed.seedSource,
          label: seed.label,
        });
      }

      // Seed embedding for community assignment
      const seedEmbeddings = await computeSeedEmbeddings(this.embedder, seeds);

      // Scan and index files
      const files = this.scanner.scan();
      const filePaths = new Set(files.map(f => f.path));
      const allSections: SectionInfo[] = [];

      for (const fileInfo of files) {
        if (path.basename(fileInfo.path) === this.settings.manifest.filename) continue;
        const sections = await this.indexFile(fileInfo, filePaths, contentTypeDefaults);
        allSections.push(...sections);
      }

      // Compute edges
      await this.graph.computeAllEdges(allSections, filePaths);

      // Assign sections to communities — seeded vaults keep the cosine
      // assignment; unseeded vaults get auto-clustered communities so every
      // vault has communities (Phase 3 of the GraphRAG buildout).
      if (seeds.length > 0) {
        await assignCommunities(this.db, allSections, seeds, seedEmbeddings);
      } else {
        await ensureAutoCommunities(
          this.db,
          allSections,
          this.settings.graph?.clusterThreshold,
        );
      }

      // Community reports — LLM-written per-community summaries for global
      // mode (Phase 4 of the GraphRAG buildout). Generated only when an LLM
      // was wired in (the production orchestrator passes ChatReportLlm; the
      // test harness passes none). Failure is non-fatal: reports stay absent
      // (or partial) and the index remains usable — global mode then degrades
      // to local retrieval.
      if (this.reportLlm) {
        try {
          await generateCommunityReports(this.db, this.reportLlm, {
            // `?.` guard: partial Settings in tests degrade to the module
            // default (DEFAULT_REPORT_CONTEXT_CAP_TOKENS).
            contextCapTokens: this.settings.reports?.contextCapTokens,
          });
        } catch (e) {
          console.warn(
            `[build] Community report generation failed (${errorMessage(e)}) — global mode unavailable.`,
          );
        }
      }

      // Insert metadata
      await this.db.insertMeta(`vault:${files.length}files`, manifestHash);
    } finally {
      await this.db.close();
    }
  }

  // ------------------------------------------------------------------
  // Incremental update
  // ------------------------------------------------------------------

  async incremental(): Promise<void> {
    try {
      await this.db.initialize();
      const files = this.scanner.scan();
      const changed: FileInfo[] = [];
      for (const f of files) {
        if (await this.db.hasFileChanged(f)) changed.push(f);
      }
      if (changed.length === 0) return;

      const filePaths = new Set(files.map(f => f.path));
      const manifestPath = this.manifestParser.findManifest();
      const seeds = this.manifestParser.getCommunitySeeds(manifestPath);
      const contentTypeDefaults = this.manifestParser.getContentTypeDefaults(manifestPath);
      const manifestHash = this.manifestParser.hashManifest(manifestPath);

      // Check if manifest changed
      const meta = await this.db.getLatestMeta();
      const oldManifestHash = meta ? (meta.manifest_hash || "") : "";
      const manifestChanged = oldManifestHash !== manifestHash;

      if (manifestChanged && seeds.length > 0) {
        await this.db.clearCommunityAssignments();
        for (const seed of seeds) {
          await this.db.insertCommunity({
            communityId: seed.communityId,
            seedSource: seed.seedSource,
            label: seed.label,
          });
        }
      }

      const changedSections: SectionInfo[] = [];
      for (const fileInfo of changed) {
        if (path.basename(fileInfo.path) === this.settings.manifest.filename) continue;
        await this.db.retireSections(fileInfo.path);
        await this.db.deleteEdgesForFile(fileInfo.path);
        const sections = await this.indexFile(fileInfo, filePaths, contentTypeDefaults);
        changedSections.push(...sections);
      }

      // Recompute edges for affected files
      if (changedSections.length > 0) {
        const changedFileIds = new Set(changedSections.map(s => s.fileId));
        const allSections = await this.db.getAllSections();
        await this.graph.computeEdgesForFiles(changedSections, changedFileIds, allSections, filePaths);
      }

      // Re-assign communities if manifest changed
      if (manifestChanged) {
        const seedEbs = await computeSeedEmbeddings(this.embedder, seeds);
        await assignCommunities(this.db, changedSections, seeds, seedEbs);
      }

      await this.db.insertMeta(`vault:${files.length}files`, manifestHash);
    } finally {
      await this.db.close();
    }
  }

  // ------------------------------------------------------------------
  // Journal replay
  // ------------------------------------------------------------------

  async replayJournal(journalEntries: JournalEntryRecord[]): Promise<void> {
    try {
      await this.db.initialize();
      const manifestPath = this.manifestParser.findManifest();
      const contentTypeDefaults = this.manifestParser.getContentTypeDefaults(manifestPath);
      const affectedFiles = new Set<string>();

      for (const entry of journalEntries) {
        const verdict = entry.verdict || "";
        const filePath = entry.file_path || "";
        if (!filePath) continue;
        affectedFiles.add(filePath);

        if (verdict === "new") {
          const fileInfo = this.readFileInfo(filePath);
          if (fileInfo) await this.indexFile(fileInfo, new Set([fileInfo.path]), contentTypeDefaults);
        } else if (["append", "revise", "cleaned"].includes(verdict)) {
          await this.db.retireSections(filePath);
          await this.db.deleteEdgesForFile(filePath);
          const fileInfo = this.readFileInfo(filePath);
          if (fileInfo) await this.indexFile(fileInfo, new Set(), contentTypeDefaults);
        } else if (verdict === "move") {
          const oldPath = entry.old_path || "";
          if (oldPath) {
            await this.db.retireSections(oldPath);
            await this.db.deleteEdgesForFile(oldPath);
            await this.db.removeFile(oldPath);
          }
          const fileInfo = this.readFileInfo(filePath);
          if (fileInfo) await this.indexFile(fileInfo, new Set(), contentTypeDefaults);
        }
      }

      if (affectedFiles.size > 0) {
        const allSections = await this.db.getAllSections();
        const filePaths = new Set(allSections.map(s => s.fileId));
        const affectedSections = allSections.filter(s => affectedFiles.has(s.fileId));
        await this.graph.computeEdgesForFiles(affectedSections, affectedFiles, allSections, filePaths);
      }
    } finally {
      await this.db.close();
    }
  }

  // ------------------------------------------------------------------
  // Query
  // ------------------------------------------------------------------

  async query(text: string, topK: number = this.settings.query.topK, opts?: HybridQueryOptions): Promise<SearchResult[]> {
    try {
      // Hybrid local search: cosine top-k + graph expansion over EDGES
      // (see graph_search.ts — Phase 1 of the GraphRAG buildout). Settings
      // supply the expansion defaults; explicit opts override them.
      const hybridOpts: HybridQueryOptions = {
        // `?.` guard: partial Settings in tests degrade to module defaults.
        depth: this.settings.query?.depth,
        maxFanOut: this.settings.query?.maxFanOut,
        maxSeeds: this.settings.query?.maxSeeds,
        ...opts,
      };
      return await hybridQuery(this.embedder, this.db, text, topK, hybridOpts);
    } finally {
      await this.db.close();
    }
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private async indexFile(
    fileInfo: FileInfo & Partial<FileWriteInput>,
    filePaths: Set<string>,
    contentTypeDefaults: Record<string, string>,
  ): Promise<SectionInfo[]> {
    const filePath = fileInfo.path;
    const folder = path.dirname(filePath);

    // Infer content type from manifest defaults
    let contentType = "";
    if (folder in contentTypeDefaults) {
      contentType = contentTypeDefaults[folder];
    } else if (folder) {
      const parts = folder.split(path.sep);
      for (let i = parts.length; i > 0; i--) {
        const parent = parts.slice(0, i).join(path.sep);
        if (parent in contentTypeDefaults) {
          contentType = contentTypeDefaults[parent];
          break;
        }
      }
    }

    fileInfo.file_id = filePath;
    fileInfo.folder = folder;
    fileInfo.content_type = fileInfo.content_type || contentType;
    fileInfo.granularity = fileInfo.granularity || "";
    fileInfo.owner = fileInfo.owner || "";
    fileInfo.reviewed_date = fileInfo.reviewed_date || null;
    fileInfo.rollup_summary = "";

    await this.db.upsertFile(fileInfo);

    // Chunk into header sections
    const sections = this.chunker.chunk(fileInfo);

    const dbSections: SectionWriteInput[] = sections.map((section) => ({
      nodeKey: section.nodeKey,
      fileId: filePath,
      headingPath: section.headingPath,
      headingText: section.headingText,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      text: section.text,
      contentHash: section.contentHash,
    }));

    // Embed all section texts in ONE batch HTTP round trip per file
    // (embedBatch — one request instead of one per section). On batch
    // failure, fall back to per-section embeds so a single bad call cannot
    // empty the whole file's embeddings (today's resilience, preserved).
    let embeddings: number[][];
    try {
      embeddings = await this.embedder.embedBatch(dbSections.map((s) => s.text || ""));
    } catch {
      embeddings = [];
      for (const section of dbSections) {
        try {
          embeddings.push(await this.embedder.embed(section.text || ""));
        } catch {
          embeddings.push([]);
        }
      }
    }

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const embedding = embeddings[i] ?? [];
      // Attach to BOTH the db row and the returned section object (matches
      // Python: section["embedding"] = embedding)
      section.embedding = embedding;
      dbSections[i].embedding = embedding;

      // Extract entities
      const entities = this.graph.extract(section.text);

      await this.db.upsertSection(dbSections[i]);

      if (entities.length > 0) {
        await this.db.insertEntities(entities);
        await this.db.insertSectionEntities(section.nodeKey, entities);
      }
    }

    // Compute file rollup
    try {
      const rollup = await this.db.computeFileRollup(filePath);
      if (rollup !== null) {
        await this.db.updateFileRollup(filePath, rollup);
      }
    } catch {
      // ignore
    }

    return sections.map(s => ({
      ...s,
      fileId: filePath,
    }));
  }

  readFileInfo(filePath: string): (FileInfo & Partial<FileWriteInput>) | null {
    const rel = filePath.replace(/\\/g, "/");
    if (!this.io.exists(rel)) return null;
    try {
      const stat = this.io.stat(rel);
      if (!stat) return null;
      const content = this.io.readBinary(rel);
      return {
        path: rel,
        file_id: rel,
        title: path.basename(rel, ".md"),
        folder: path.dirname(rel),
        created_date: null,
        modified_date: stat.mtimeMs,
        version: 1,
        content_hash: crypto.createHash("sha1").update(content).digest("hex"),
        content: content.toString("utf-8"),
        granularity: "",
        content_type: "",
        owner: "",
        reviewed_date: null,
      };
    } catch {
      return null;
    }
  }
}
