// Hybrid local search — query-time graph read (Phase 1 of the GraphRAG
// buildout, see .dev-vault/handoff.md).
//
// Retrieval stops being pure cosine: the question is resolved to candidate
// node_keys (heading paths + entity names — the regex tier; Phase 5 swaps in
// an LLM), those keys are expanded over the stored EDGES graph (wikilink +
// backlink hops, `inferred` edges excluded — they are a thresholded copy of
// the cosine signal retrieval already uses), and the merged result is cosine
// top-k first with graph-only hits inserted below.
//
// The module is PURE at the core: resolveQueryNodes / expandNeighbors /
// hybridRank take plain inputs and return plain values with hand-computable,
// deterministic behavior. hybridQuery is the async driver that wires them to
// an embedder + the DB facade (DatabaseManager satisfies HybridQueryDb).

import type { IEmbedder } from "./embedder";
import { rowToSearchResult } from "./embedding";
import type {
  EdgeRow,
  EntityRow,
  SearchResult,
  SectionEntityRow,
  SectionKeyRow,
  SectionSearchRow,
} from "./db_worker/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Question tokens that carry no retrieval signal (regex tier). */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "to", "with",
  "at", "by", "from", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "my", "your", "our", "their", "me", "us",
  "him", "her", "them", "you", "we", "they", "i", "what", "which", "who",
  "how", "why", "when", "where", "can", "could", "would", "should", "does",
  "do", "did", "tell", "about", "not", "no", "any", "all", "vault", "notes",
  "note",
]);

/** Extra score when the full question phrase appears verbatim in a heading. */
const PHRASE_BONUS = 0.5;

const DEFAULT_DEPTH = 1;
const DEFAULT_MAX_FAN_OUT = 8;
const DEFAULT_MAX_SEEDS = 8;

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** Significant (non-stopword, length > 1) lowercase tokens, deduped. */
export function significantTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Query-node resolution (regex tier)
// ---------------------------------------------------------------------------

export interface ResolvedNode {
  nodeKey: string;
  score: number;
}

/**
 * Map the question to candidate node_keys. Two tiers, merged per node_key by
 * max score:
 *   A. Heading-path token coverage: the fraction of significant question
 *      tokens appearing in the section's heading haystack (heading_path +
 *      heading_text), plus a phrase bonus when the whole question appears
 *      verbatim in it.
 *   B. Entity-name coverage: for each entity whose name shares tokens with
 *      the question, the fraction of shared name tokens; those scores attach
 *      to the sections that MENTION the entity (SECTION_ENTITIES mentions).
 *
 * `entities`/`mentions` are expected to be pre-filtered to question-matching
 * entities by the caller (the driver) so the DB read stays targeted; the
 * function still guards each entity independently.
 *
 * Deterministic: sorted by (score desc, node_key asc), capped at maxSeeds.
 */
export function resolveQueryNodes(
  question: string,
  sections: SectionKeyRow[],
  entities: EntityRow[],
  mentions: SectionEntityRow[],
  maxSeeds: number = DEFAULT_MAX_SEEDS,
): ResolvedNode[] {
  const tokens = significantTokens(question);
  if (tokens.length === 0) return [];

  const results = new Map<string, number>();
  const phrase = question.toLowerCase().trim();

  // Tier A — heading-path token coverage.
  for (const section of sections) {
    const haystack = [section.heading_path, section.heading_text]
      .filter((part): part is string => !!part)
      .join(" ")
      .toLowerCase();
    if (!haystack) continue;

    let covered = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) covered++;
    }
    if (covered === 0) continue;

    let score = covered / tokens.length;
    if (phrase && haystack.includes(phrase)) score += PHRASE_BONUS;
    const existing = results.get(section.node_key) ?? 0;
    results.set(section.node_key, Math.max(existing, score));
  }

  // Tier B — entity-name coverage, mapped through the mention rows.
  if (mentions.length > 0) {
    const sectionsByEntity = new Map<string, string[]>();
    for (const mention of mentions) {
      const list = sectionsByEntity.get(mention.entity_id) ?? [];
      list.push(mention.section_key);
      sectionsByEntity.set(mention.entity_id, list);
    }

    for (const entity of entities) {
      const nameTokens = significantTokens(entity.name);
      if (nameTokens.length === 0) continue;
      const shared = nameTokens.filter((token) => tokens.includes(token)).length;
      if (shared === 0) continue;

      const cover = shared / nameTokens.length;
      for (const sectionKey of sectionsByEntity.get(entity.entity_id) ?? []) {
        const existing = results.get(sectionKey) ?? 0;
        results.set(sectionKey, Math.max(existing, cover));
      }
    }
  }

  return [...results.entries()]
    .map(([nodeKey, score]) => ({ nodeKey, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0),
    )
    .slice(0, maxSeeds);
}

// ---------------------------------------------------------------------------
// Neighbor expansion over EDGES
// ---------------------------------------------------------------------------

export interface ExpandOptions {
  /** BFS levels past the seed keys (default 1). */
  depth?: number;
  /** Max outgoing edges followed per key per level (default 8). */
  maxFanOut?: number;
}

/**
 * BFS over the EDGES graph from seedKeys, cycle-safe (visited set) and
 * depth-/fan-out-capped. `inferred` edges are always excluded: they are a
 * thresholded copy of the cosine signal retrieval already uses directly, so
 * following them cannot add signal and would double-count.
 *
 * Returns the seeds (in input order, deduped) followed by every reachable
 * neighbor in deterministic BFS order (outgoing edges sorted by weight desc,
 * dst_key asc as the tiebreak).
 */
export function expandNeighbors(
  seedKeys: string[],
  edges: EdgeRow[],
  opts: ExpandOptions = {},
): string[] {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const maxFanOut = opts.maxFanOut ?? DEFAULT_MAX_FAN_OUT;

  const visited = new Set<string>();
  for (const key of seedKeys) {
    if (key) visited.add(key);
  }
  let frontier = [...visited];

  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const key of frontier) {
      const outgoing = edges
        .filter((edge) => edge.src_key === key && edge.kind !== "inferred")
        .sort(
          (a, b) =>
            b.weight - a.weight ||
            (a.dst_key < b.dst_key ? -1 : a.dst_key > b.dst_key ? 1 : 0),
        )
        .slice(0, maxFanOut);
      for (const edge of outgoing) {
        if (!visited.has(edge.dst_key)) {
          visited.add(edge.dst_key);
          next.push(edge.dst_key);
        }
      }
    }
    frontier = next;
  }

  return [...visited];
}

// ---------------------------------------------------------------------------
// Hybrid merge
// ---------------------------------------------------------------------------

/**
 * Merge cosine hits and graph hits into one deterministic result list:
 * cosine hits keep their positions (deduped), then graph-only hits (those
 * whose node_key is not already in the cosine list) append below in their
 * given order.
 */
export function hybridRank(
  cosineHits: SearchResult[],
  graphHits: SearchResult[],
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const hit of cosineHits) {
    if (seen.has(hit.nodeKey)) continue;
    seen.add(hit.nodeKey);
    merged.push(hit);
  }
  for (const hit of graphHits) {
    if (seen.has(hit.nodeKey)) continue;
    seen.add(hit.nodeKey);
    merged.push(hit);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Hybrid query driver
// ---------------------------------------------------------------------------

export interface HybridQueryOptions {
  /** BFS levels past the resolved seeds (default 1). */
  depth?: number;
  /** Max outgoing edges followed per key per level (default 8). */
  maxFanOut?: number;
  /** Max resolver seeds to expand from (default 8). */
  maxSeeds?: number;
  /** Max graph-only hits appended below the cosine top-k (default topK). */
  maxGraphHits?: number;
}

/** The DB surface the driver needs — DatabaseManager satisfies this. */
export interface HybridQueryDb {
  searchSimilar(queryEmbedding: number[], topK: number): Promise<SearchResult[]>;
  getSectionKeys(): Promise<SectionKeyRow[]>;
  getAllEntities(): Promise<EntityRow[]>;
  getSectionsForEntities(entityIds: string[]): Promise<SectionEntityRow[]>;
  getWikilinkEdges(fileId: string): Promise<EdgeRow[]>;
  getSectionsByKeys(keys: string[]): Promise<SectionSearchRow[]>;
}

/**
 * Full hybrid retrieval: cosine top-k, then resolve the question to seeds,
 * expand the seeds over the stored EDGES graph (edges fetched per file as
 * new files enter the frontier), resolve graph-only keys to full section
 * rows, and merge cosine-first.
 *
 * Any step that yields nothing short-circuits back to the pure-cosine
 * result, so a question with no heading/entity matches or an index without
 * edges behaves exactly like the pre-Phase-1 query (regression pin).
 */
export async function hybridQuery(
  embedder: IEmbedder,
  db: HybridQueryDb,
  question: string,
  topK: number = 5,
  opts: HybridQueryOptions = {},
): Promise<SearchResult[]> {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const maxFanOut = opts.maxFanOut ?? DEFAULT_MAX_FAN_OUT;
  const maxSeeds = opts.maxSeeds ?? DEFAULT_MAX_SEEDS;
  const maxGraphHits = opts.maxGraphHits ?? topK;

  const queryEmbedding = await embedder.embed(question);
  const cosineHits = await db.searchSimilar(queryEmbedding, topK);

  const tokens = significantTokens(question);
  if (tokens.length === 0) return cosineHits;

  const sections = await db.getSectionKeys();
  const entities = await db.getAllEntities();
  const tokenSet = new Set(tokens);
  const matchedEntities = entities.filter((entity) =>
    significantTokens(entity.name).some((token) => tokenSet.has(token)),
  );
  let mentions: SectionEntityRow[] = [];
  if (matchedEntities.length > 0) {
    mentions = await db.getSectionsForEntities(
      matchedEntities.map((entity) => entity.entity_id),
    );
  }

  const resolved = resolveQueryNodes(
    question,
    sections,
    matchedEntities,
    mentions,
    maxSeeds,
  );
  const seedKeys = resolved.map((node) => node.nodeKey);
  if (seedKeys.length === 0) return cosineHits;

  const expanded = await expandGraph(db, seedKeys, depth, maxFanOut);

  const cosineKeys = new Set(cosineHits.map((hit) => hit.nodeKey));
  const graphOnlyKeys = expanded
    .filter((key) => !cosineKeys.has(key))
    .slice(0, maxGraphHits);
  if (graphOnlyKeys.length === 0) return cosineHits;

  const rows = await db.getSectionsByKeys(graphOnlyKeys);
  const scoreByKey = new Map(resolved.map((node) => [node.nodeKey, node.score]));
  const graphHits: SearchResult[] = rows
    .map((row) => rowToSearchResult(row, scoreByKey.get(row.node_key) ?? 0))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0),
    );

  return hybridRank(cosineHits, graphHits);
}

/**
 * Level-by-level expansion. Edges are fetched per file (getWikilinkEdges)
 * only when a file first enters the frontier — the pure BFS runs per level
 * over the edges accumulated so far, so depth > 1 never needs the full edge
 * set up front.
 */
async function expandGraph(
  db: HybridQueryDb,
  seedKeys: string[],
  depth: number,
  maxFanOut: number,
): Promise<string[]> {
  const visited = new Set<string>(seedKeys);
  let frontier = [...visited];
  const edges: EdgeRow[] = [];
  const fetchedFiles = new Set<string>();

  for (let level = 0; level < depth && frontier.length > 0; level++) {
    for (const fileId of fileIdsOf(frontier)) {
      if (fetchedFiles.has(fileId)) continue;
      fetchedFiles.add(fileId);
      edges.push(...(await db.getWikilinkEdges(fileId)));
    }

    const expanded = expandNeighbors(frontier, edges, { depth: 1, maxFanOut });
    const next = expanded.filter((key) => !visited.has(key));
    for (const key of next) visited.add(key);
    frontier = next;
  }

  return [...visited];
}

/**
 * The file id a node key belongs to. Section keys are "file.md::Heading";
 * the EDGES graph also stores bare file-level nodes ("file.md", or bare
 * wikilink targets without any .md) — those are their own file id.
 */
function fileIdsOf(keys: string[]): string[] {
  const seen = new Set<string>();
  const fileIds: string[] = [];
  for (const key of keys) {
    const fileId = key.includes("::") ? key.split("::")[0] : key;
    if (!seen.has(fileId)) {
      seen.add(fileId);
      fileIds.push(fileId);
    }
  }
  return fileIds;
}
