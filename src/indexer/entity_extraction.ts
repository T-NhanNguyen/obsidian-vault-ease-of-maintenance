// LLM entity + relationship extraction (Phase 5 of the GraphRAG buildout,
// see .dev-vault/handoff.md).
//
// The regex tier (graph.ts EntityExtractor) stays as the deterministic
// baseline (offline-safe, feeds the manifest's wikilink read). This module
// adds the LLM tier on top when a ReportLlm is wired: one completion per
// BATCH of files (greedy packing under a context cap), returning typed
// entities + typed relationships.
//
//   - Entities are stored in ENTITIES with type 'llm:<type>' and mapped to
//     their mentioning sections (SECTION_ENTITIES) by VERBATIM name matching
//     against the sections the LLM actually saw — an entity with no mention
//     is never stored (the graph stays grounded in the text).
//   - Relationships become EDGES rows with kind 'semantic:<relation>'.
//     expandNeighbors excludes only 'inferred', so semantic edges flow
//     through the Phase-1 traversal untouched; only the driver's per-file
//     edge fetch (graph_search.ts expandGraph) needs the new read.
//
// The module is PURE at the core (parseExtractionResponse / mentionsInSections
// / semanticEdgesForRelations / buildExtractionBatches are hand-computable);
// the async drivers (generateSemanticGraph / storeExtraction) take a
// ReportLlm seam + a fake store so tests assert the INPUTS, never the
// network. No schema bump was needed: the extraction shape (name + type in
// ENTITIES, mention rows, kind-carrying EDGES) fits the v3 schema.

import { buildReportContext } from "./community_reports";
import type { ReportLlm } from "./community_reports";
import { entityId } from "./graph";
import type { Edge, EntityRow, EntityWriteInput, SectionEntityInput } from "./db_worker/types";
import { readPromptSection } from "../definitions";
import extractionDefinitionMd from "../../maintainer-definitions/entity-extraction.md";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = readPromptSection(extractionDefinitionMd, "Extraction");

/**
 * Token budget per extraction call — also the per-file cap: buildReportContext
 * drops sections beyond it, so a single oversized file is still processed
 * (alone) instead of blowing the batch. Same default as the report cap.
 */
export const DEFAULT_EXTRACTION_CONTEXT_CAP_TOKENS = 3000;

/** Parse caps per batch — applied AFTER the deterministic sort (first N). */
export const DEFAULT_MAX_ENTITIES_PER_BATCH = 30;
export const DEFAULT_MAX_RELATIONS_PER_BATCH = 30;

/** Max semantic EDGES emitted per relationship (deterministic pairing). */
export const DEFAULT_MAX_SEMANTIC_EDGES_PER_RELATION = 4;

/** Distinguishing prefix so LLM entities never collide with regex types
 * (wikilink/tag/phrase) — the manifest's type='wikilink' read stays clean. */
export const LLM_ENTITY_TYPE_PREFIX = "llm";

/** Entity names shorter than this are never mention-matched (noise guard —
 * short names like "AI" substring-match everywhere). */
export const MIN_MENTION_NAME_LENGTH = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entity the LLM named, with its claimed type (unvalidated). */
export interface SemanticEntity {
  name: string;
  type: string;
}

/** One typed relationship between two entity NAMES (unresolved to sections). */
export interface SemanticRelation {
  src: string;
  dst: string;
  relation: string;
}

/** The parsed output of one extraction completion. */
export interface FileExtraction {
  entities: SemanticEntity[];
  relations: SemanticRelation[];
}

/** A section as consumed by extraction — snake_case so it flows into
 * buildReportContext unchanged. */
export interface ExtractableSection {
  node_key: string;
  text: string;
  heading_path: string | null;
}

/** The indexer-side section shape (SectionInfo satisfies this). */
export interface SectionLike {
  nodeKey: string;
  fileId: string;
  text: string;
  headingPath: string | null;
}

/** One file's sections, ready for batching. */
export interface ExtractableFile {
  fileId: string;
  sections: ExtractableSection[];
}

/** One LLM call's input: the included sections of 1..N files. */
export interface ExtractionBatch {
  fileIds: string[];
  /** The user-prompt block ("File: <id>\n\n### heading\ntext" per file). */
  context: string;
  /** Union of the INCLUDED sections (the ones the LLM saw), node_key-sorted. */
  sections: ExtractableSection[];
  totalTokens: number;
}

/** The DB surface extraction needs — DatabaseManager satisfies this. */
export interface EntityExtractionStore {
  insertEntities(entities: EntityWriteInput[]): Promise<void>;
  insertSectionEntities(sectionKey: string, entities: SectionEntityInput[]): Promise<void>;
  insertEdges(edges: Edge[]): Promise<void>;
}

/** The DB surface the mention-refresh helper needs — DatabaseManager satisfies it. */
export interface MentionRefreshStore {
  getAllEntities(): Promise<EntityRow[]>;
  insertSectionEntities(sectionKey: string, entities: SectionEntityInput[]): Promise<void>;
}

/** One batch's outcome, for the caller's record. */
export interface ExtractionResult {
  fileIds: string[];
  entities: number;
  relations: number;
}

// ---------------------------------------------------------------------------
// Pure core — normalization
// ---------------------------------------------------------------------------

/** Lowercase, non-alphanumerics → '_', trimmed; empty → 'concept'. */
export function normalizeEntityType(type: string): string {
  const cleaned = type.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "concept";
}

/** Lowercase, non-alphanumerics → '_', trimmed; empty → 'related_to'.
 * The result is the EDGES kind — expandNeighbors excludes only 'inferred',
 * so every 'semantic:*' kind flows through traversal. */
export function normalizeRelationKind(relation: string): string {
  const cleaned = relation.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `semantic:${cleaned || "related_to"}`;
}

// ---------------------------------------------------------------------------
// Pure core — parsing
// ---------------------------------------------------------------------------

/**
 * Parse an extraction completion into entities + relations. Junk-tolerant:
 * any line that is not exactly ENTITY|<name>|<type> or REL|<a>|<b>|<rel> is
 * skipped. Dedupes (first occurrence wins), sorts deterministically
 * (entities by name asc; relations by src/dst/relation asc), then caps at
 * the per-batch maxima. Self-referential relations (src === dst) are
 * dropped — they cannot produce a traversal edge.
 */
export function parseExtractionResponse(
  text: string,
  opts: { maxEntities?: number; maxRelations?: number } = {},
): FileExtraction {
  const maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES_PER_BATCH;
  const maxRelations = opts.maxRelations ?? DEFAULT_MAX_RELATIONS_PER_BATCH;

  const entityByName = new Map<string, SemanticEntity>();
  const relationByKey = new Map<string, SemanticRelation>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [tag, ...rest] = line.split("|");

    if (tag === "ENTITY") {
      const name = (rest[0] || "").trim();
      const type = (rest[1] || "concept").trim();
      if (name && !entityByName.has(name)) {
        entityByName.set(name, { name, type });
      }
    } else if (tag === "REL") {
      const src = (rest[0] || "").trim();
      const dst = (rest[1] || "").trim();
      const relation = (rest[2] || "related_to").trim();
      if (!src || !dst || src === dst) continue;
      const key = `${src}|${dst}|${relation}`;
      if (!relationByKey.has(key)) {
        relationByKey.set(key, { src, dst, relation });
      }
    }
  }

  return {
    entities: [...entityByName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxEntities),
    relations: [...relationByKey.values()]
      .sort(
        (a, b) =>
          a.src.localeCompare(b.src) ||
          a.dst.localeCompare(b.dst) ||
          a.relation.localeCompare(b.relation),
      )
      .slice(0, maxRelations),
  };
}

// ---------------------------------------------------------------------------
// Pure core — mention mapping + semantic edges
// ---------------------------------------------------------------------------

/**
 * The sections whose heading haystack + body contain the entity name
 * VERBATIM (case-insensitive substring). Short names are excluded (noise
 * guard). Deterministic: sorted section keys, deduped.
 */
export function mentionsInSections(
  entityName: string,
  sections: ExtractableSection[],
): string[] {
  const needle = entityName.toLowerCase().trim();
  if (needle.length < MIN_MENTION_NAME_LENGTH) return [];

  const keys: string[] = [];
  for (const section of sections) {
    const haystack = `${section.heading_path || ""} ${section.text || ""}`.toLowerCase();
    if (haystack.includes(needle)) keys.push(section.node_key);
  }
  return [...new Set(keys)].sort();
}

/**
 * Map relationships to EDGES rows (kind 'semantic:<relation>', weight 1.0).
 * Each relationship emits its mention-section cross-product (src asc, dst
 * asc), skipping self-edges (srcKey === dstKey), capped per relationship.
 * A relationship whose entity has no mentions emits nothing.
 */
export function semanticEdgesForRelations(
  relations: SemanticRelation[],
  mentionsByEntity: Map<string, string[]>,
  maxEdgesPerRelation: number = DEFAULT_MAX_SEMANTIC_EDGES_PER_RELATION,
): Edge[] {
  const edges: Edge[] = [];
  for (const relation of relations) {
    const srcMentions = mentionsByEntity.get(relation.src) ?? [];
    const dstMentions = mentionsByEntity.get(relation.dst) ?? [];
    const kind = normalizeRelationKind(relation.relation);

    let count = 0;
    for (const srcKey of srcMentions) {
      for (const dstKey of dstMentions) {
        if (srcKey === dstKey) continue;
        edges.push({ srcKey, dstKey, kind, weight: 1.0 });
        count++;
        if (count >= maxEdgesPerRelation) break;
      }
      if (count >= maxEdgesPerRelation) break;
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Pure core — batching
// ---------------------------------------------------------------------------

/** Group indexer sections by file id, sorted by file id (deterministic). */
export function groupSectionsByFile(sections: SectionLike[]): ExtractableFile[] {
  const byFile = new Map<string, ExtractableSection[]>();
  for (const section of sections) {
    const list = byFile.get(section.fileId) ?? [];
    list.push({
      node_key: section.nodeKey,
      text: section.text,
      heading_path: section.headingPath ?? null,
    });
    byFile.set(section.fileId, list);
  }
  return [...byFile.entries()]
    .map(([fileId, fileSections]) => ({ fileId, sections: fileSections }))
    .sort((a, b) => a.fileId.localeCompare(b.fileId));
}

/**
 * Greedy batching under the token cap (the large-vault constraint): files
 * are processed in file-id order; each file's sections are capped per-file
 * (buildReportContext's deterministic drop-beyond), and files accumulate
 * into the current batch while the accumulated token total stays ≤ cap.
 * Files whose whole context exceeds the cap are processed ALONE. Files with
 * no fitting sections are skipped entirely (no extraction call for them).
 */
export function buildExtractionBatches(
  files: ExtractableFile[],
  capTokens: number = DEFAULT_EXTRACTION_CONTEXT_CAP_TOKENS,
): ExtractionBatch[] {
  const ordered = [...files].sort((a, b) => a.fileId.localeCompare(b.fileId));
  const batches: ExtractionBatch[] = [];
  let current: ExtractionBatch | null = null;

  for (const file of ordered) {
    const built = buildReportContext(file.sections, capTokens);
    if (built.includedSectionKeys.length === 0) continue;

    const byKey = new Map(file.sections.map((s) => [s.node_key, s]));
    const included = built.includedSectionKeys
      .map((key) => byKey.get(key)!)
      .sort((a, b) => a.node_key.localeCompare(b.node_key));
    const block = `File: ${file.fileId}\n\n${built.context}`;

    if (current && current.totalTokens + built.totalTokens <= capTokens) {
      current.fileIds.push(file.fileId);
      current.sections.push(...included);
      current.context += `\n\n${block}`;
      current.totalTokens += built.totalTokens;
    } else {
      current = {
        fileIds: [file.fileId],
        sections: [...included],
        context: block,
        totalTokens: built.totalTokens,
      };
      batches.push(current);
    }
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * Store an extraction: entities WITH ≥1 mention → ENTITIES ('llm:<type>') +
 * SECTION_ENTITIES; relationships → EDGES ('semantic:<relation>'). Entities
 * the LLM named but the text never contains are dropped (ungrounded).
 *
 * Relation endpoints are mention-matched even when the LLM referenced them
 * without a matching ENTITY line (small models do this): the edge is still
 * grounded when the name appears verbatim in the sections the LLM saw — the
 * edge connects sections directly, so traversal never needs the entity row.
 */
export async function storeExtraction(
  db: EntityExtractionStore,
  sections: ExtractableSection[],
  extraction: FileExtraction,
): Promise<void> {
  const entityRows: EntityWriteInput[] = [];
  const mentionRows: Array<{ name: string; keys: string[] }> = [];
  const edgeMentions = new Map<string, string[]>();

  for (const entity of extraction.entities) {
    const mentions = mentionsInSections(entity.name, sections);
    if (mentions.length === 0) continue;
    entityRows.push({
      entityId: entityId(entity.name),
      name: entity.name,
      type: `${LLM_ENTITY_TYPE_PREFIX}:${normalizeEntityType(entity.type)}`,
    });
    mentionRows.push({ name: entity.name, keys: mentions });
    edgeMentions.set(entity.name, mentions);
  }

  // Edge-only candidates: relation endpoints never defined as entities.
  for (const relation of extraction.relations) {
    if (!edgeMentions.has(relation.src)) {
      const mentions = mentionsInSections(relation.src, sections);
      if (mentions.length > 0) edgeMentions.set(relation.src, mentions);
    }
    if (!edgeMentions.has(relation.dst)) {
      const mentions = mentionsInSections(relation.dst, sections);
      if (mentions.length > 0) edgeMentions.set(relation.dst, mentions);
    }
  }

  if (entityRows.length > 0) {
    await db.insertEntities(entityRows);
  }
  for (const { name, keys } of mentionRows) {
    const id = entityId(name);
    for (const key of keys) {
      await db.insertSectionEntities(key, [{ entityId: id }]);
    }
  }

  const edges = semanticEdgesForRelations(extraction.relations, edgeMentions);
  if (edges.length > 0) {
    await db.insertEdges(edges);
  }
}

/**
 * Re-match every stored entity name against the given (changed) sections and
 * re-insert the SECTION_ENTITIES rows (INSERT OR IGNORE — regex-tier rows
 * already re-added by indexFile are no-ops). The incremental changed-file
 * leg calls this after re-indexing: retireSections wiped the sections'
 * mention rows, and the LLM-tier entities (type 'llm:*', multi-word
 * concepts the regex misses) would otherwise lose their mentions until the
 * next full rebuild. Deterministic and LLM-free.
 */
export async function refreshEntityMentions(
  db: MentionRefreshStore,
  sections: ExtractableSection[],
): Promise<void> {
  if (sections.length === 0) return;
  const entities = await db.getAllEntities();
  for (const entity of entities) {
    const mentions = mentionsInSections(entity.name, sections);
    if (mentions.length === 0) continue;
    for (const key of mentions) {
      await db.insertSectionEntities(key, [{ entityId: entity.entity_id }]);
    }
  }
}

/**
 * Build-side driver: batch the files, one LLM completion per batch, store
 * the extraction. Deterministic call order (batches in file-id order). An
 * LLM failure propagates — the caller (build/incremental) catches it and
 * warns, exactly like the report pass.
 */
export async function generateSemanticGraph(
  db: EntityExtractionStore,
  llm: ReportLlm,
  files: ExtractableFile[],
  opts: { contextCapTokens?: number } = {},
): Promise<ExtractionResult[]> {
  const capTokens = opts.contextCapTokens ?? DEFAULT_EXTRACTION_CONTEXT_CAP_TOKENS;
  const batches = buildExtractionBatches(files, capTokens);
  const results: ExtractionResult[] = [];

  for (const batch of batches) {
    const completion = await llm.complete(EXTRACTION_SYSTEM_PROMPT, batch.context);
    const extraction = parseExtractionResponse(completion.content);
    await storeExtraction(db, batch.sections, extraction);
    results.push({
      fileIds: batch.fileIds,
      entities: extraction.entities.length,
      relations: extraction.relations.length,
    });
  }

  return results;
}
