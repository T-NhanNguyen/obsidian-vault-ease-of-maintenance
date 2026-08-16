// Top-level indexer orchestrator for v2 GraphRAG.
// Ported from src/indexer/indexer.py

import * as crypto from "crypto";
import * as path from "path";
import { settings, Settings } from "../config";
import { VaultIO } from "../io/vault_io";
import { parseIgnorePatterns } from "../agent/engine";
import { Chunker, SectionInfo } from "./chunker";
import { DatabaseManager, FileWriteInput, SearchResult, SectionWriteInput } from "./db";
import { assignCommunities, computeSeedEmbeddings } from "./communities";
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

  constructor(customSettings?: Settings, embedder?: IEmbedder) {
    this.settings = customSettings || settings;
    this.io = new VaultIO(this.settings.vaultPath);
    this.db = new DatabaseManager(this.settings.dbPath);
    this.scanner = new Scanner(this.settings.vaultPath, parseIgnorePatterns(this.settings.ignorePatterns));
    this.chunker = new Chunker();
    this.graph = new GraphBuilder(this.db);
    this.embedder = embedder || new Embedder(this.settings);
    this.manifestParser = new ManifestParser(this.settings.vaultPath);
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

      // Assign sections to communities
      await assignCommunities(this.db, allSections, seeds, seedEmbeddings);

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

      if (manifestChanged) {
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

  async query(text: string, topK: number = 5): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embed(text);
    try {
      return await this.db.searchSimilar(queryEmbedding, topK);
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

    for (const section of sections) {
      // Map to DB format
      const dbSection: SectionWriteInput = {
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
      const entities = this.graph.extract(section.text);

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

      await this.db.upsertSection(dbSection);

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
