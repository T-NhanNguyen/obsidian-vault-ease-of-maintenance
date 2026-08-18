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
import { DbHost, getDefaultDbHost } from "./db_host";
import { EmbeddingCache } from "./embedding_cache";
import { hybridQuery, HybridQueryOptions } from "./graph_search";
import { assignCommunities, computeSeedEmbeddings, ensureAutoCommunities } from "./communities";
import { generateCommunityReports, ReportLlm } from "./community_reports";
import { regenerateChangedCommunityReports, snapshotCommunityMembership } from "./community_reports";
import { generateSemanticGraph, groupSectionsByFile, refreshEntityMentions } from "./entity_extraction";
import type { ExtractableSection } from "./entity_extraction";
import { Embedder, IEmbedder } from "./embedder";
import { GraphBuilder } from "./graph";
import { ManifestParser } from "./manifest";
import { FileInfo, Scanner } from "./scanner";

/** Sidecar checkpoint filename — a sibling of index.db that survives both
 * clearAll() and retireLegacyIndex() (see embedding_cache.ts). */
const EMBEDDING_CACHE_FILENAME = "embedding-cache.json";

// Journal replay entry — journal rows written by the sort pipeline.
interface JournalEntryRecord {
  verdict?: string;
  file_path?: string;
  old_path?: string;
}

/** SectionInfo → the extraction module's minimal section shape. */
function toExtractableSection(section: SectionInfo): ExtractableSection {
  return {
    node_key: section.nodeKey,
    text: section.text,
    heading_path: section.headingPath ?? null,
  };
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
  private readonly embeddingCache: EmbeddingCache;
  private readonly reportLlm?: ReportLlm;
  private readonly extractionLlm?: ReportLlm;

  constructor(customSettings?: Settings, embedder?: IEmbedder, reportLlm?: ReportLlm, extractionLlm?: ReportLlm, host?: DbHost) {
    this.settings = customSettings || settings;
    this.io = new VaultIO(this.settings.vaultPath);
    // The embedding cache uses the SAME host I/O as the DB (the Obsidian
    // adapter in production, VaultIO/fs in Node) — a raw-fs cache would
    // re-introduce the store-review "Direct Filesystem Access" trigger.
    const dbHost = host ?? getDefaultDbHost();
    this.db = new DatabaseManager(this.settings.dbPath, dbHost);
    this.embeddingCache = new EmbeddingCache(
      dbHost.io,
      path.join(path.dirname(this.settings.dbPath), EMBEDDING_CACHE_FILENAME),
    );
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
    this.extractionLlm = extractionLlm;
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

      // Load the embedding cache once, before the file loop — an interrupted
      // build that already flushed files 1..N re-embeds only the rest
      // (drop-and-return; see embedding_cache.ts).
      await this.embeddingCache.load({
        model: this.settings.embedding.model,
        dimensions: this.settings.embedding.dimensions,
      });

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

      // LLM entity extraction — typed entities + relationships → semantic
      // EDGES (Phase 5 of the GraphRAG buildout). Optional like the report
      // pass: wired only when an LLM was given (production passes
      // ChatReportLlm; the test harness passes none → regex-only graph,
      // zero HTTP). Failure is non-fatal: the regex tier stays the baseline
      // and the index remains usable — semantic edges simply stay absent.
      if (this.extractionLlm) {
        try {
          await generateSemanticGraph(this.db, this.extractionLlm, groupSectionsByFile(allSections), {
            // `?.` guard: partial Settings in tests degrade to the module
            // default (DEFAULT_EXTRACTION_CONTEXT_CAP_TOKENS).
            contextCapTokens: this.settings.extraction?.contextCapTokens,
          });
        } catch (e) {
          console.warn(
            `[build] LLM entity extraction failed (${errorMessage(e)}) — graph stays regex-only.`,
          );
        }
      }

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
      const scanPaths = new Set(files.map((f) => f.path));
      const changed: FileInfo[] = [];
      for (const f of files) {
        if (await this.db.hasFileChanged(f)) changed.push(f);
      }

      // Deleted-file gap (roadmap item): a file in the index but absent from
      // the scan was deleted from the vault. The cold build hid this via
      // clearAll; the incremental leg must remove it explicitly (the same
      // retire → delete-edges → remove trio the move path uses).
      const dbFileIds = await this.db.getAllFileIds();
      const deleted = dbFileIds.filter((id) => !scanPaths.has(id)).sort();
      for (const fileId of deleted) {
        await this.db.retireSections(fileId);
        await this.db.deleteEdgesForFile(fileId);
        await this.db.removeFile(fileId);
      }

      if (changed.length === 0 && deleted.length === 0) return;

      // Embedding-cache checkpoint — unchanged sections are served from the
      // sidecar; only the changed sections hit the embedder.
      await this.embeddingCache.load({
        model: this.settings.embedding.model,
        dimensions: this.settings.embedding.dimensions,
      });

      const filePaths = new Set(files.map((f) => f.path));
      const manifestPath = this.manifestParser.findManifest();
      const seeds = this.manifestParser.getCommunitySeeds(manifestPath);
      const contentTypeDefaults = this.manifestParser.getContentTypeDefaults(manifestPath);
      const manifestHash = this.manifestParser.hashManifest(manifestPath);

      // Check if manifest changed
      const meta = await this.db.getLatestMeta();
      const oldManifestHash = meta ? (meta.manifest_hash || "") : "";
      const manifestChanged = oldManifestHash !== manifestHash;

      // Membership snapshot BEFORE any assignment mutation — the report-
      // regeneration diff compares the after-state against it (Phase-5
      // item 4: regenerate only changed communities, never all).
      const membershipBefore = await snapshotCommunityMembership(this.db);

      const changedSections: SectionInfo[] = [];
      for (const fileInfo of changed) {
        if (path.basename(fileInfo.path) === this.settings.manifest.filename) continue;
        await this.db.retireSections(fileInfo.path);
        // Structural edges only — the LLM semantic edges are PRESERVED:
        // re-extracting a changed file alone (without the files it relates
        // to) provably loses its cross-file relations; the weekly full
        // rebuild refreshes the semantic graph instead.
        await this.db.deleteStructuralEdgesForFile(fileInfo.path);
        const sections = await this.indexFile(fileInfo, filePaths, contentTypeDefaults);
        changedSections.push(...sections);
      }

      // Restore the LLM-entity mention rows the retire wiped (regex-tier
      // mentions were re-added by indexFile; the 'llm:*' multi-word entities
      // need a cheap name re-match against the changed sections).
      if (changedSections.length > 0) {
        try {
          await refreshEntityMentions(this.db, changedSections.map(toExtractableSection));
        } catch (e) {
          console.warn(
            `[incremental] LLM-entity mention refresh failed (${errorMessage(e)}) — resolver entity tier degrades for changed files.`,
          );
        }
      }

      // Recompute edges for affected files
      if (changedSections.length > 0) {
        const changedFileIds = new Set(changedSections.map((s) => s.fileId));
        const allSections = await this.db.getAllSections();
        await this.graph.computeEdgesForFiles(changedSections, changedFileIds, allSections, filePaths);
      }

      // Community assignment:
      if (seeds.length > 0) {
        if (manifestChanged) {
          // Seeds changed — re-seed + re-assign EVERY section (a seed
          // embedding shift would otherwise leave stale assignments for
          // untouched sections until the next full rebuild; roadmap item 4
          // flagged this as a decision — full re-assignment is correct).
          await this.db.clearCommunityAssignments();
          for (const seed of seeds) {
            await this.db.insertCommunity({
              communityId: seed.communityId,
              seedSource: seed.seedSource,
              label: seed.label,
            });
          }
          const seedEbs = await computeSeedEmbeddings(this.embedder, seeds);
          const allSections = await this.db.getAllSections();
          await assignCommunities(this.db, allSections, seeds, seedEbs);
        } else if (changedSections.length > 0) {
          // Seeds unchanged — re-assign ONLY the changed sections (their
          // old rows were retired); stable seed ids keep the untouched
          // sections' assignments valid.
          const seedEbs = await computeSeedEmbeddings(this.embedder, seeds);
          await assignCommunities(this.db, changedSections, seeds, seedEbs);
        }
      } else {
        // Unseeded vault — re-cluster ALL sections. Auto ids are content-
        // derived (anchor-based), so unchanged clusters keep their ids;
        // survivors also keep their reports, so the membership diff below
        // regenerates only the truly-changed communities (Phase-5 item 4 —
        // unseeded incremental previously never clustered at all). Auto
        // communities that lost every member are pruned (rows + reports).
        await this.db.clearCommunityAssignments();
        const allSections = await this.db.getAllSections();
        await ensureAutoCommunities(
          this.db,
          allSections,
          this.settings.graph?.clusterThreshold,
        );
        await this.db.pruneEmptyAutoCommunities();
      }

      // Community reports — regenerate ONLY communities whose membership
      // changed (or that have no report yet — a self-healing retry of a
      // previous LLM failure). Membership-unchanged communities keep their
      // reports untouched (Phase-5 item 4: report regen becomes a write leg
      // of the daily delta, not a full re-pass).
      if (this.reportLlm) {
        try {
          await regenerateChangedCommunityReports(this.db, this.reportLlm, membershipBefore, {
            contextCapTokens: this.settings.reports?.contextCapTokens,
          });
        } catch (e) {
          console.warn(
            `[incremental] Community report regeneration failed (${errorMessage(e)}) — reports stay stale.`,
          );
        }
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

      // Embedding-cache checkpoint — replayed files hit the sidecar when
      // their section text is already embedded.
      await this.embeddingCache.load({
        model: this.settings.embedding.model,
        dimensions: this.settings.embedding.dimensions,
      });

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

    // Embed ONLY the uncached sections — one batch HTTP round trip per file
    // for its misses (embedBatch — one request instead of one per section).
    // On batch failure, fall back to per-section embeds so a single bad call
    // cannot empty the whole file's embeddings (today's resilience,
    // preserved). A cache HIT is proof the section is already embedded — no
    // HTTP, no re-embed (drop-and-return on interrupted builds).
    const missIndexes: number[] = [];
    for (let i = 0; i < dbSections.length; i++) {
      const hash = dbSections[i].contentHash || "";
      const hit = hash ? this.embeddingCache.get(hash) : null;
      dbSections[i].embedding = hit ?? undefined; // hit → reuse, no HTTP
      if (!hit) missIndexes.push(i);
    }

    if (missIndexes.length > 0) {
      const missTexts = missIndexes.map((i) => dbSections[i].text || "");
      let fresh: number[][] = [];
      try {
        fresh = await this.embedder.embedBatch(missTexts);
      } catch {
        fresh = [];
        for (const i of missIndexes) {
          try {
            fresh.push(await this.embedder.embed(dbSections[i].text || ""));
          } catch {
            fresh.push([]);
          }
        }
      }
      for (let k = 0; k < missIndexes.length; k++) {
        const i = missIndexes[k];
        const vec = fresh[k] ?? [];
        dbSections[i].embedding = vec;
        const hash = dbSections[i].contentHash || "";
        if (hash) this.embeddingCache.put(hash, vec);
      }
      // Per-batch checkpoint write: a file that introduced new vectors is
      // durable from this point on. Hit-only files add nothing — no write.
      await this.embeddingCache.flush();
    }

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const embedding = dbSections[i].embedding ?? [];
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
