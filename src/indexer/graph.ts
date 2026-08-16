// Graph concern — entity extraction and edge construction.
//
// One module for everything graph-shaped: regex entity extraction
// (wikilinks / tags / capitalized phrases), edge construction (wikilink /
// backlink / inferred-cosine), and the schema-independent inputs for future
// graph structure/traversal. Persistence stays in the DB layer — this module
// only computes; it never touches SQL.

import * as crypto from "crypto";
import { cosineSimilarity } from "./embedding";

export interface Entity {
  entityId: string;
  name: string;
  type: string;
}

export interface Edge {
  srcKey: string;
  dstKey: string;
  kind: string;
  weight: number;
}

/** A section as consumed by edge computation (a subset of the DB row). */
export interface IndexableSection {
  nodeKey?: string;
  fileId?: string;
  headingPath?: string | null;
  text?: string | null;
  embedding?: number[] | null;
}

/** The DB surface edge computation needs — row read/write only. */
export interface EdgeStore {
  insertEdges(edges: Edge[]): Promise<void>;
}

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TAG_PATTERN = /(?:^|\s)(#[a-zA-Z][a-zA-Z0-9_-]*)/g;
const CAPITALIZED_PATTERN = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/g;

// Inferred-edge build knobs — config.yaml `graph:` section overrides these
// (single source of truth: src/config.ts GraphSettings).
const DEFAULT_INFERRED_THRESHOLD = 0.7;
const DEFAULT_INFERRED_MAX_EDGES_PER_SECTION = 3;

/** Graph-build tuning options — wired from settings.graph by the indexer. */
export interface GraphBuildOptions {
  inferredThreshold?: number;
  inferredMaxEdgesPerSection?: number;
}

export class EntityExtractor {
  extract(text: string): Entity[] {
    const seen = new Set<string>();
    const entities: Entity[] = [];

    // Wikilinks
    for (const match of text.matchAll(WIKILINK_PATTERN)) {
      const name = match[1].trim();
      const eid = entityId(name);
      if (!seen.has(eid)) {
        seen.add(eid);
        entities.push({ entityId: eid, name, type: "wikilink" });
      }
    }

    // Tags
    for (const match of text.matchAll(TAG_PATTERN)) {
      const name = match[1].trim();
      const eid = entityId(name);
      if (!seen.has(eid)) {
        seen.add(eid);
        entities.push({ entityId: eid, name, type: "tag" });
      }
    }

    // Capitalized phrases
    for (const match of text.matchAll(CAPITALIZED_PATTERN)) {
      const name = match[0].trim();
      if (name.length < 4) continue;
      const eid = entityId(name);
      if (!seen.has(eid)) {
        seen.add(eid);
        entities.push({ entityId: eid, name, type: "phrase" });
      }
    }

    return entities;
  }

  computeWikilinkEdges(
    sections: IndexableSection[],
    fileId: string,
    fileExistsFn?: (key: string) => boolean,
  ): Edge[] {
    const edges: Edge[] = [];
    const seen = new Set<string>();

    for (const section of sections) {
      const srcKey = section.nodeKey || "";
      const text = section.text || "";

      for (const match of text.matchAll(WIKILINK_PATTERN)) {
        let target = match[1].trim();

        // Check if target includes a heading anchor [[Note#Heading]]
        let dstKey = target;
        if (target.includes("#")) {
          const [targetFile, targetHeading] = target.split("#", 2);
          dstKey = `${targetFile.trim()}::${targetHeading.trim()}`;
        }

        // Skip self-references
        if (dstKey === srcKey) continue;

        const edgeKey = `${srcKey}|${dstKey}|wikilink`;
        if (!seen.has(edgeKey)) {
          seen.add(edgeKey);
          if (fileExistsFn && !fileExistsFn(dstKey) && !fileExistsFn(target)) {
            edges.push({ srcKey, dstKey, kind: "wikilink", weight: 0.5 });
          } else {
            edges.push({ srcKey, dstKey, kind: "wikilink", weight: 1.0 });
          }
        }
      }
    }

    return edges;
  }

  computeBacklinks(wikilinkEdges: Edge[]): Edge[] {
    const backlinks: Edge[] = [];
    const seen = new Set<string>();

    for (const edge of wikilinkEdges) {
      const src = edge.srcKey;
      const dst = edge.dstKey;

      // Backlink: dst_key -> src_key (reverse direction)
      const revKey = `${dst}|${src}|backlink`;
      if (!seen.has(revKey)) {
        seen.add(revKey);
        backlinks.push({ srcKey: dst, dstKey: src, kind: "backlink", weight: 0.8 });
      }

      // File-level backlink for section-level wikilinks
      if (src.includes("::")) {
        const srcFile = src.split("::")[0];
        const fileRevKey = `${dst}|${srcFile}|backlink`;
        if (!seen.has(fileRevKey)) {
          seen.add(fileRevKey);
          backlinks.push({ srcKey: dst, dstKey: srcFile, kind: "backlink", weight: 0.7 });
        }
      }
    }

    return backlinks;
  }

  computeInferredEdges(
    sections: IndexableSection[],
    existingWikilinkKeys: Set<string>,
    similarityThreshold: number = 0.7,
    maxEdgesPerSection: number = 3,
  ): Edge[] {
    const edges: Edge[] = [];
    const seen = new Set(existingWikilinkKeys);

    // Index sections by node_key
    const sectionMap = new Map<string, number[]>();
    const sectionKeys: string[] = [];
    for (const s of sections) {
      const nodeKey = s.nodeKey || "";
      const emb = s.embedding;
      if (emb && emb.length > 0) {
        sectionMap.set(nodeKey, emb);
        sectionKeys.push(nodeKey);
      }
    }

    for (let i = 0; i < sectionKeys.length; i++) {
      const srcKey = sectionKeys[i];
      const srcEmb = sectionMap.get(srcKey)!;
      const scored: [number, string][] = [];

      for (let j = 0; j < sectionKeys.length; j++) {
        if (i === j) continue;
        const dstKey = sectionKeys[j];
        const edgeKeyFwd = `${srcKey}|${dstKey}`;
        const edgeKeyRev = `${dstKey}|${srcKey}`;
        if (seen.has(edgeKeyFwd) || seen.has(edgeKeyRev)) continue;

        const dstEmb = sectionMap.get(dstKey)!;
        const sim = cosineSimilarity(srcEmb, dstEmb);
        if (sim >= similarityThreshold) {
          scored.push([sim, dstKey]);
        }
      }

      scored.sort((a, b) => b[0] - a[0]);
      for (const [sim, dstKey] of scored.slice(0, maxEdgesPerSection)) {
        const edgeKey = `${srcKey}|${dstKey}|inferred`;
        if (!seen.has(edgeKey)) {
          seen.add(edgeKey);
          edges.push({ srcKey, dstKey, kind: "inferred", weight: Math.round(sim * 10000) / 10000 });
        }
      }
    }

    return edges;
  }
}

/**
 * Orchestrates the three edge phases (wikilink → backlink → inferred) against
 * one DB write, and exposes entity extraction for section indexing. Replaces
 * the old Indexer.computeAllEdges/computeEdgesForFiles methods.
 */
export class GraphBuilder {
  private readonly extractor = new EntityExtractor();

  constructor(
    private readonly db: EdgeStore,
    private readonly options: GraphBuildOptions = {},
  ) {}

  extract(text: string): Entity[] {
    return this.extractor.extract(text);
  }

  async computeAllEdges(
    allSections: IndexableSection[],
    filePaths: Set<string>,
  ): Promise<void> {
    const allEdges: Edge[] = [];
    const wikilinkEdgeKeys = new Set<string>();

    const fileExists = (key: string): boolean => {
      const base = key.includes("::") ? key.split("::")[0] : key;
      return filePaths.has(base);
    };

    // Group sections by file
    const fileSections = new Map<string, IndexableSection[]>();
    for (const s of allSections) {
      const fid = s.fileId || "";
      if (!fileSections.has(fid)) fileSections.set(fid, []);
      fileSections.get(fid)!.push(s);
    }

    // Phase 1: Wikilink edges
    for (const [fileId, sections] of fileSections) {
      const wikilinkEdges = this.extractor.computeWikilinkEdges(
        sections, fileId, fileExists
      );
      allEdges.push(...wikilinkEdges);
      for (const e of wikilinkEdges) {
        wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
      }
    }

    // Phase 2: Backlink edges
    const backlinks = this.extractor.computeBacklinks(allEdges);
    allEdges.push(...backlinks);
    for (const e of backlinks) {
      wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
    }

    // Phase 3: Inferred edges
    if (allSections.length > 0) {
      const sectionsWithEmb = allSections.map(s => ({
        nodeKey: s.nodeKey || "",
        embedding: s.embedding,
      }));
      const inferred = this.extractor.computeInferredEdges(
        sectionsWithEmb,
        wikilinkEdgeKeys,
        this.options.inferredThreshold ?? DEFAULT_INFERRED_THRESHOLD,
        this.options.inferredMaxEdgesPerSection ?? DEFAULT_INFERRED_MAX_EDGES_PER_SECTION,
      );
      allEdges.push(...inferred);
    }

    if (allEdges.length > 0) {
      await this.db.insertEdges(allEdges);
    }
  }

  async computeEdgesForFiles(
    changedSections: IndexableSection[],
    changedFileIds: Set<string>,
    allSections: IndexableSection[],
    filePaths: Set<string>,
  ): Promise<void> {
    const allEdges: Edge[] = [];
    const wikilinkEdgeKeys = new Set<string>();

    const fileExists = (key: string): boolean => {
      const base = key.includes("::") ? key.split("::")[0] : key;
      return filePaths.has(base);
    };

    const fileSections = new Map<string, IndexableSection[]>();
    for (const s of allSections) {
      const fid = s.fileId || "";
      if (changedFileIds.has(fid)) {
        if (!fileSections.has(fid)) fileSections.set(fid, []);
        fileSections.get(fid)!.push(s);
      }
    }

    for (const [fileId, sections] of fileSections) {
      const edges = this.extractor.computeWikilinkEdges(sections, fileId, fileExists);
      allEdges.push(...edges);
      for (const e of edges) {
        wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
      }
    }

    const backlinks = this.extractor.computeBacklinks(allEdges);
    allEdges.push(...backlinks);
    for (const e of backlinks) {
      wikilinkEdgeKeys.add(`${e.srcKey}|${e.dstKey}`);
    }

    if (allEdges.length > 0) {
      await this.db.insertEdges(allEdges);
    }
  }
}

/** Stable entity id for a name (md5, lowercased, first 16 hex chars). */
export function entityId(name: string): string {
  return crypto.createHash("md5").update(name.toLowerCase()).digest("hex").slice(0, 16);
}
