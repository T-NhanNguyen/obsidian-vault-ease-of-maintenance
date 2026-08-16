// Typed message protocol for the disposable sql.js Web Worker.
//
// Message shapes (documented contract — keep in sync with worker.ts and the
// channels in db_host.ts):
//
//   open  → { kind: "open", wasmBinary, dbBytes }        (transferable bytes)
//   open  ← { kind: "open-result", needsRebuild }        (true → legacy file)
//   op    → { kind: "op", id, method, args }             (id-correlated)
//   op    ← { kind: "op-result", id, ok, value | error }
//   close → { kind: "close" }
//   close ← { kind: "close-result", ok, bytes | error }  (bytes when dirty)
//
// The method surface mirrors the old better-sqlite3 DatabaseManager 1:1 so
// the engine, the protocol, and the facade cannot drift.

import type {
  CommunityReportRow,
  CommunityReportWriteInput,
  CommunityRow,
  CommunityWriteInput,
  Edge,
  EdgeRow,
  EntityRow,
  EntityWriteInput,
  FileRow,
  FileWriteInput,
  FolderFileRow,
  FolderHeadingRow,
  MetaRow,
  SearchResult,
  SectionEntityInput,
  SectionEntityRow,
  SectionKeyRow,
  SectionRow,
  SectionSearchRow,
  SectionSummary,
  SectionWriteInput,
  UnlinkedSection,
  WikilinkCountRow,
} from "./types";

export interface DbMethodMap {
  initialize: { args: []; result: void };
  clearAll: { args: []; result: void };
  upsertFile: { args: [FileWriteInput]; result: void };
  updateFileRollup: { args: [string, string]; result: void };
  hasFileChanged: { args: [FileWriteInput]; result: boolean };
  getFileInfo: { args: [string]; result: FileRow | null };
  removeFile: { args: [string]; result: void };
  upsertSection: { args: [SectionWriteInput]; result: string };
  retireSections: { args: [string]; result: number };
  getSectionsForFile: { args: [string]; result: SectionRow[] };
  getAllSections: { args: []; result: SectionSummary[] };
  searchSimilar: { args: [number[], number]; result: SearchResult[] };
  getSectionKeys: { args: []; result: SectionKeyRow[] };
  getAllEntities: { args: []; result: EntityRow[] };
  getSectionsForEntities: { args: [string[]]; result: SectionEntityRow[] };
  getSectionsByKeys: { args: [string[]]; result: SectionSearchRow[] };
  insertEntities: { args: [EntityWriteInput[]]; result: void };
  insertSectionEntities: { args: [string, SectionEntityInput[]]; result: void };
  insertEdges: { args: [Edge[]]; result: void };
  getWikilinkEdges: { args: [string]; result: EdgeRow[] };
  getSemanticEdges: { args: [string]; result: EdgeRow[] };
  deleteEdgesForFile: { args: [string]; result: void };
  deleteStructuralEdgesForFile: { args: [string]; result: void };
  getUnlinkedSections: { args: []; result: UnlinkedSection[] };
  insertCommunity: { args: [CommunityWriteInput]; result: string };
  getAllCommunities: { args: []; result: CommunityRow[] };
  assignSectionToCommunity: { args: [string, string]; result: void };
  getCommunityForSection: { args: [string]; result: string | null };
  clearCommunityAssignments: { args: []; result: void };
  pruneEmptyAutoCommunities: { args: []; result: void };
  upsertCommunityReport: { args: [CommunityReportWriteInput]; result: void };
  getCommunityReport: { args: [string]; result: CommunityReportRow | null };
  getAllCommunityReports: { args: []; result: CommunityReportRow[] };
  getSectionsForCommunity: { args: [string]; result: SectionSearchRow[] };
  insertMeta: { args: [string, string]; result: number };
  getLatestMeta: { args: []; result: MetaRow | null };
  getAllFileIds: { args: []; result: string[] };
  computeFileRollup: { args: [string]; result: string | null };
  getFolderedFiles: { args: []; result: FolderFileRow[] };
  getWikilinksForFolder: { args: [string]; result: WikilinkCountRow[] };
  getFolderHeadings: { args: [string]; result: FolderHeadingRow[] };
}

export type DbMethodName = keyof DbMethodMap;

export interface WorkerOpenMessage {
  kind: "open";
  wasmBinary: Uint8Array | null;
  dbBytes: Uint8Array | null;
}

export interface WorkerOpenResult {
  kind: "open-result";
  needsRebuild: boolean;
}

export interface WorkerOpMessage {
  kind: "op";
  id: number;
  method: DbMethodName;
  args: unknown[];
}

export interface WorkerOpResult {
  kind: "op-result";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface WorkerCloseMessage {
  kind: "close";
}

export interface WorkerCloseResult {
  kind: "close-result";
  ok: boolean;
  bytes?: Uint8Array | null;
  error?: string;
}

export type WorkerRequest = WorkerOpenMessage | WorkerOpMessage | WorkerCloseMessage;
export type WorkerResponse = WorkerOpenResult | WorkerOpResult | WorkerCloseResult;
