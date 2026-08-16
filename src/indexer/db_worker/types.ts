// Shared DB row/write shapes for the sql.js database layer.
//
// These types cross the worker message channel (structured-clone-safe: only
// strings, numbers, null, and Uint8Array) and are used by the sync engine
// (sqljs_database.ts), the typed protocol (protocol.ts), and the main-thread
// facade (db.ts). Embedding blobs are Uint8Array here — Buffer does not exist
// inside a Web Worker, and the worker never touches the Node API.
//
// Row interfaces for typed queries — sql.js's getAsObject() returns
// Record<string, SqlValue>, so every statement declares the shape it reads.

export interface FileRow {
  file_id: string;
  path: string;
  title: string;
  folder: string;
  created_date: string | null;
  modified_date: string | null;
  reviewed_date: string | null;
  owner: string;
  content_type: string;
  granularity: string;
  version: number;
  content_hash: string | null;
  rollup_summary: string;
}

export interface SectionRow {
  node_key: string;
  file_id: string;
  heading_path: string | null;
  heading_text: string | null;
  line_start: number | null;
  line_end: number | null;
  text: string | null;
  embedding: Uint8Array | null;
  content_hash: string | null;
}

export interface EdgeRow {
  src_key: string;
  dst_key: string;
  kind: string;
  weight: number;
}

export interface CommunityRow {
  community_id: string;
  seed_source: string | null;
  label: string | null;
}

/** A COMMUNITY_REPORTS row — an LLM-written summary of a community (Phase 4). */
export interface CommunityReportRow {
  community_id: string;
  report: string | null;
  model: string | null;
  tokens: number | null;
  built_at: string | null;
}

export interface MetaRow {
  snapshot_id: number;
  built_at: string;
  vault_version: string;
  manifest_hash: string | null;
}

// Write-input shapes — all-optional so Record<string, any> callers still
// compile while the DB reads are fully typed.
export interface FileWriteInput {
  file_id?: string;
  path?: string;
  title?: string;
  folder?: string;
  created_date?: string | null;
  // Scanner reports mtime as a number; the FILES column stores it as TEXT.
  modified_date?: string | number | null;
  reviewed_date?: string | null;
  owner?: string;
  content_type?: string;
  granularity?: string;
  version?: number;
  content_hash?: string | null;
  rollup_summary?: string;
}

export interface SectionWriteInput {
  nodeKey?: string;
  fileId?: string;
  headingPath?: string;
  heading_path?: string;
  headingText?: string;
  heading_text?: string;
  lineStart?: number;
  line_start?: number;
  lineEnd?: number;
  line_end?: number;
  text?: string;
  contentHash?: string;
  content_hash?: string;
  embedding?: number[];
}

export interface CommunityWriteInput {
  communityId?: string;
  community_id?: string;
  seedSource?: string;
  seed_source?: string;
  label?: string;
}

export interface CommunityReportWriteInput {
  communityId?: string;
  community_id?: string;
  report?: string;
  model?: string;
  tokens?: number;
  builtAt?: string;
  built_at?: string;
}

export interface EntityWriteInput {
  entityId: string;
  name: string;
  type?: string;
}

export interface SectionEntityInput {
  entityId: string;
}

export interface SectionSummary {
  nodeKey: string;
  fileId: string;
  headingPath: string | null;
  text: string | null;
  embedding: number[] | null;
}

export interface UnlinkedSection {
  nodeKey: string;
  fileId: string;
  embedding: number[] | null;
}

export interface Edge {
  srcKey: string;
  dstKey: string;
  kind: string;
  weight: number;
}

export interface SearchResult {
  nodeKey: string;
  fileId: string;
  filePath: string;
  headingPath: string;
  headingText: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  contentHash: string;
  fileContentHash: string;
  contentType: string;
  rollupSummary: string;
  title: string;
  score: number;
}

/** A SECTIONS row joined with its FILES row, WITHOUT the embedding blob — the
 * light read shape for text/heading-based lookups (resolver + graph hits). */
export interface SectionSearchRow {
  node_key: string;
  file_id: string;
  heading_path: string | null;
  heading_text: string | null;
  line_start: number | null;
  line_end: number | null;
  text: string | null;
  content_hash: string | null;
  path: string;
  title: string;
  content_type: string;
  rollup_summary: string;
}

/** Heading-only section row — the resolver's input; never loads text/blobs. */
export interface SectionKeyRow {
  node_key: string;
  file_id: string;
  heading_path: string | null;
  heading_text: string | null;
}

/** A row from ENTITIES (entity_id, name) — resolver's entity-name tier. */
export interface EntityRow {
  entity_id: string;
  name: string;
}

/** A SECTION_ENTITIES row — maps an entity to the sections that mention it. */
export interface SectionEntityRow {
  section_key: string;
  entity_id: string;
}

// generateManifest's raw-connection queries, sealed behind facade methods.
export interface FolderFileRow {
  folder: string;
  path: string;
}

export interface WikilinkCountRow {
  name: string;
  cnt: number;
}

export interface FolderHeadingRow {
  heading_path: string;
  text: string;
}
