// Top-level indexer orchestrator for v2 GraphRAG.
// Ported from src/indexer/indexer.py

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { settings, Settings } from "../config";
import { parseIgnorePatterns } from "../agent/engine";
import { Chunker, FileInfoForChunking } from "./chunker";
import { DatabaseManager, Edge, SearchResult } from "./db";
import { Embedder, IEmbedder } from "./embedder";
import { EntityExtractor } from "./entity_extractor";
import { CommunitySeed, ManifestParser } from "./manifest";
import { Scanner } from "./scanner";

export class Indexer {
  settings: Settings;
  db: DatabaseManager;
  scanner: Scanner;
  chunker: Chunker;
  entityExtractor: EntityExtractor;
  embedder: IEmbedder;
  manifestParser: ManifestParser;

  constructor(customSettings?: Settings, embedder?: IEmbedder) {
    this.settings = customSettings || settings;
    this.db = new DatabaseManager(this.settings.dbPath);
    this.db.initialize();
    this.scanner = new Scanner(this.settings.vaultPath, parseIgnorePatterns(this.settings.ignorePatterns));
    this.chunker = new Chunker();
    this.entityExtractor = new EntityExtractor();
    this.embedder = embedder || new Embedder(this.settings);
    this.manifestParser = new ManifestParser(this.settings.vaultPath);
  }

  // ------------------------------------------------------------------
  // Cold build
  // ------------------------------------------------------------------

  async build(): Promise<void> {
    this.db.initialize();
    this.db.clearAll();

    const manifestPath = this.manifestParser.findManifest();
    const seeds = this.manifestParser.getCommunitySeeds(manifestPath);
    const contentTypeDefaults = this.manifestParser.getContentTypeDefaults(manifestPath);
    const manifestHash = this.manifestParser.hashManifest(manifestPath);

    // Insert manifest-based communities
    for (const seed of seeds) {
      this.db.insertCommunity({
        communityId: seed.communityId,
        seedSource: seed.seedSource,
        label: seed.label,
      });
    }

    // Seed embedding for community assignment
    const seedEmbeddings: Map<string, number[]> = new Map();
    for (const seed of seeds) {
      const seedText = seed.seedText || seed.label;
      try {
        seedEmbeddings.set(seed.communityId, await this.embedder.embed(seedText));
      } catch {
        seedEmbeddings.set(seed.communityId, []);
      }
    }

    // Scan and index files
    const files = this.scanner.scan();
    const filePaths = new Set(files.map(f => f.path));
    const allSections: Record<string, any>[] = [];

    for (const fileInfo of files) {
      if (path.basename(fileInfo.path) === this.settings.manifest.filename) continue;
      const sections = await this.indexFile(fileInfo, filePaths, contentTypeDefaults);
      allSections.push(...sections);
    }

    // Compute edges
    await this.computeAllEdges(allSections, filePaths);

    // Assign sections to communities
    this.assignCommunities(allSections, seeds, seedEmbeddings);

    // Insert metadata
    this.db.insertMeta(`vault:${files.length}files`, manifestHash);
  }

  // ------------------------------------------------------------------
  // Incremental update
  // ------------------------------------------------------------------

  async incremental(): Promise<void> {
    this.db.initialize();
    const files = this.scanner.scan();
    const changed = files.filter(f => this.db.hasFileChanged(f));
    if (changed.length === 0) return;

    const filePaths = new Set(files.map(f => f.path));
    const manifestPath = this.manifestParser.findManifest();
    const seeds = this.manifestParser.getCommunitySeeds(manifestPath);
    const contentTypeDefaults = this.manifestParser.getContentTypeDefaults(manifestPath);
    const manifestHash = this.manifestParser.hashManifest(manifestPath);

    // Check if manifest changed
    const meta = this.db.getLatestMeta();
    const oldManifestHash = meta ? (meta.manifest_hash || "") : "";
    const manifestChanged = oldManifestHash !== manifestHash;

    if (manifestChanged) {
      this.db.clearCommunityAssignments();
      for (const seed of seeds) {
        this.db.insertCommunity({
          communityId: seed.communityId,
          seedSource: seed.seedSource,
          label: seed.label,
        });
      }
    }

    const changedSections: Record<string, any>[] = [];
    for (const fileInfo of changed) {
      if (path.basename(fileInfo.path) === this.settings.manifest.filename) continue;
      this.db.retireSections(fileInfo.path);
      this.db.deleteEdgesForFile(fileInfo.path);
      const sections = await this.indexFile(fileInfo, filePaths, contentTypeDefaults);
      changedSections.push(...sections);
    }

    // Recompute edges for affected files
    if (changedSections.length > 0) {
      const changedFileIds = new Set(changedSections.map(s => s.fileId));
      const allSections = this.db.getAllSections();
      await this.computeEdgesForFiles(changedSections, changedFileIds, allSections, filePaths);
    }

    // Re-assign communities if manifest changed
    if (manifestChanged) {
      const seedEbs = await this.computeSeedEmbeddings(seeds);
      this.assignCommunities(changedSections, seeds, seedEbs);
    }

    this.db.insertMeta(`vault:${files.length}files`, manifestHash);
  }

  // ------------------------------------------------------------------
  // Journal replay
  // ------------------------------------------------------------------

  async replayJournal(journalEntries: Array<Record<string, any>>): Promise<void> {
    this.db.initialize();
    const manifestPath = this.manifestParser.findManifest();
    const seeds = this.manifestParser.getCommunitySeeds(manifestPath);
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
        this.db.retireSections(filePath);
        this.db.deleteEdgesForFile(filePath);
        const fileInfo = this.readFileInfo(filePath);
        if (fileInfo) await this.indexFile(fileInfo, new Set(), contentTypeDefaults);
      } else if (verdict === "move") {
        const oldPath = entry.old_path || "";
        if (oldPath) {
          this.db.retireSections(oldPath);
          this.db.deleteEdgesForFile(oldPath);
          this.db.removeFile(oldPath);
        }
        const fileInfo = this.readFileInfo(filePath);
        if (fileInfo) await this.indexFile(fileInfo, new Set(), contentTypeDefaults);
      }
    }

    if (affectedFiles.size > 0) {
      const allSections = this.db.getAllSections();
      const filePaths = new Set(allSections.map(s => s.fileId));
      const affectedSections = allSections.filter(s => affectedFiles.has(s.fileId));
      await this.computeEdgesForFiles(affectedSections, affectedFiles, allSections, filePaths);
    }
  }

  // ------------------------------------------------------------------
  // Query
  // ------------------------------------------------------------------

  async query(text: string, topK: number = 5): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embed(text);
    return this.db.searchSimilar(queryEmbedding, topK);
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private async indexFile(
    fileInfo: Record<string, any>,
    filePaths: Set<string>,
    contentTypeDefaults: Record<string, string>,
  ): Promise<Record<string, any>[]> {
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

    this.db.upsertFile(fileInfo);

    // Chunk into header sections
    const sections = this.chunker.chunk(fileInfo as FileInfoForChunking);

    for (const section of sections) {
      // Map to DB format
      const dbSection: Record<string, any> = {
        nodeKey: section.nodeKey,
        fileId: filePath,
        headingPath: section.headingPath,
        headingText: section.headingText,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        text: section.text,
        contentHash: section.contentHash,
      };

      // Extract entities
      const entities = this.entityExtractor.extract(section.text);

      // Embed section text — attach to BOTH the db row and the returned
      // section object (matches Python: section["embedding"] = embedding)
      try {
        const embedding = await this.embedder.embed(section.text);
        section.embedding = embedding;
        dbSection.embedding = embedding;
      } catch {
        section.embedding = [];
        dbSection.embedding = [];
      }

      this.db.upsertSection(dbSection);

      if (entities.length > 0) {
        this.db.insertEntities(entities);
        this.db.insertSectionEntities(section.nodeKey, entities);
      }
    }

    // Compute file rollup
    try {
      const rollup = this.db.computeFileRollup(filePath);
      if (rollup !== null) {
        this.db.updateFileRollup(filePath, rollup);
      }
    } catch {
      // ignore
    }

    return sections.map(s => ({
      ...s,
      fileId: filePath,
    }));
  }

  private async computeAllEdges(
    allSections: Record<string, any>[],
    filePaths: Set<string>,
  ): Promise<void> {
    const allEdges: Edge[] = [];
    const wikilinkEdgeKeys = new Set<string>();

    const fileExists = (key: string): boolean => {
      const base = key.includes("::") ? key.split("::")[0] : key;
      return filePaths.has(base);
    };

    // Group sections by file
    const fileSections = new Map<string, Record<string, any>[]>();
    for (const s of allSections) {
      const fid = s.fileId || "";
      if (!fileSections.has(fid)) fileSections.set(fid, []);
      fileSections.get(fid)!.push(s);
    }

    // Phase 1: Wikilink edges
    for (const [fileId, sections] of fileSections) {
      const wikilinkEdges = this.entityExtractor.computeWikilinkEdges(
        sections, fileId, fileExists
      );
      allEdges.push(...wikilinkEdges);
      for (const e of wikilinkEdges) {
        wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
      }
    }

    // Phase 2: Backlink edges
    const backlinks = this.entityExtractor.computeBacklinks(allEdges);
    allEdges.push(...backlinks);
    for (const e of backlinks) {
      wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
    }

    // Phase 3: Inferred edges
    if (allSections.length > 0) {
      const sectionsWithEmb = allSections.map(s => ({
        nodeKey: s.nodeKey || s.node_key,
        embedding: s.embedding,
      }));
      const inferred = this.entityExtractor.computeInferredEdges(
        sectionsWithEmb, wikilinkEdgeKeys, 0.7, 3
      );
      allEdges.push(...inferred);
    }

    if (allEdges.length > 0) {
      this.db.insertEdges(allEdges);
    }
  }

  private async computeEdgesForFiles(
    changedSections: Record<string, any>[],
    changedFileIds: Set<string>,
    allSections: Record<string, any>[],
    filePaths: Set<string>,
  ): Promise<void> {
    const allEdges: Edge[] = [];
    const wikilinkEdgeKeys = new Set<string>();

    const fileExists = (key: string): boolean => {
      const base = key.includes("::") ? key.split("::")[0] : key;
      return filePaths.has(base);
    };

    const fileSections = new Map<string, Record<string, any>[]>();
    for (const s of allSections) {
      const fid = s.fileId || "";
      if (changedFileIds.has(fid)) {
        if (!fileSections.has(fid)) fileSections.set(fid, []);
        fileSections.get(fid)!.push(s);
      }
    }

    for (const [fileId, sections] of fileSections) {
      const edges = this.entityExtractor.computeWikilinkEdges(sections, fileId, fileExists);
      allEdges.push(...edges);
      for (const e of edges) {
        wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
      }
    }

    const backlinks = this.entityExtractor.computeBacklinks(allEdges);
    allEdges.push(...backlinks);
    for (const e of backlinks) {
      wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
    }

    if (allEdges.length > 0) {
      this.db.insertEdges(allEdges);
    }
  }

  private assignCommunities(
    sections: Record<string, any>[],
    seeds: CommunitySeed[],
    seedEmbeddings: Map<string, number[]>,
  ): void {
    if (seeds.length === 0 || seedEmbeddings.size === 0) return;

    for (const section of sections) {
      const sectionEmb = section.embedding || [];
      if (sectionEmb.length === 0) continue;

      let bestCommunity = "";
      let bestScore = -1.0;
      for (const seed of seeds) {
        const seedEmb = seedEmbeddings.get(seed.communityId) || [];
        if (seedEmb.length === 0) continue;
        const score = DatabaseManager.cosineSimilarity(sectionEmb, seedEmb);
        if (score > bestScore) {
          bestScore = score;
          bestCommunity = seed.communityId;
        }
      }

      if (bestCommunity) {
        this.db.assignSectionToCommunity(
          section.nodeKey || section.node_key, bestCommunity
        );
      }
    }
  }

  private async computeSeedEmbeddings(seeds: CommunitySeed[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    for (const seed of seeds) {
      const seedText = seed.seedText || seed.label;
      try {
        result.set(seed.communityId, await this.embedder.embed(seedText));
      } catch {
        result.set(seed.communityId, []);
      }
    }
    return result;
  }

  readFileInfo(filePath: string): Record<string, any> | null {
    const fullPath = path.join(this.settings.vaultPath, filePath);
    if (!fs.existsSync(fullPath)) return null;
    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath);
      return {
        path: filePath,
        file_id: filePath,
        title: path.basename(filePath, ".md"),
        folder: path.dirname(filePath),
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
