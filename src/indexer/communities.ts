// Community report concern — community seeds, assignment, and the future
// summaries/report layer (the multi-pass step-3 enrichment).
//
// Seeds are PARSED from the manifest by ManifestParser (src/indexer/manifest.ts
// stays the manifest-file reader); this module owns the CommunitySeed contract
// and the assignment algorithm. The future report-generation layer (reasoning
// model with tools summarizing each community) will live here too. The DB
// layer only persists rows — no assignment logic.

import * as crypto from "crypto";
import { cosineSimilarity } from "./embedding";
import type { IEmbedder } from "./embedder";
import type { IndexableSection } from "./graph";
import type { CommunityWriteInput } from "./db_worker/types";

/** One community seed, derived from a manifest folder entry. */
export interface CommunitySeed {
  communityId: string;
  seedSource: string;
  label: string;
  seedText: string;
  folderPath: string;
}

/** The DB surface community assignment needs — row read/write only. */
export interface CommunityStore {
  assignSectionToCommunity(sectionKey: string, communityId: string): Promise<void>;
}

/** The DB surface the community BUILD path needs (insert + assign). */
export interface CommunityBuildStore extends CommunityStore {
  insertCommunity(community: CommunityWriteInput): Promise<string>;
}

/**
 * Assigns sections to the community whose seed embedding is most similar
 * (by cosine), best match wins. No-op when there are no seeds or no seed
 * embeddings. Replaces the old Indexer.assignCommunities method.
 */
export async function assignCommunities(
  db: CommunityStore,
  sections: IndexableSection[],
  seeds: CommunitySeed[],
  seedEmbeddings: Map<string, number[]>,
): Promise<void> {
  if (seeds.length === 0 || seedEmbeddings.size === 0) return;

  for (const section of sections) {
    const sectionEmb = section.embedding || [];
    if (sectionEmb.length === 0) continue;

    let bestCommunity = "";
    let bestScore = -1.0;
    for (const seed of seeds) {
      const seedEmb = seedEmbeddings.get(seed.communityId) || [];
      if (seedEmb.length === 0) continue;
      const score = cosineSimilarity(sectionEmb, seedEmb);
      if (score > bestScore) {
        bestScore = score;
        bestCommunity = seed.communityId;
      }
    }

    if (bestCommunity) {
      await db.assignSectionToCommunity(
        section.nodeKey || "", bestCommunity
      );
    }
  }
}

/**
 * Embed every seed's text (seedText, falling back to the label). Embedding
 * failures yield an empty vector — that seed then never wins an assignment.
 * Replaces the old Indexer.computeSeedEmbeddings method.
 */
export async function computeSeedEmbeddings(
  embedder: IEmbedder,
  seeds: CommunitySeed[],
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  for (const seed of seeds) {
    const seedText = seed.seedText || seed.label;
    try {
      result.set(seed.communityId, await embedder.embed(seedText));
    } catch {
      result.set(seed.communityId, []);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Auto-clustering (unseeded vaults — Phase 3 of the GraphRAG buildout)
// ---------------------------------------------------------------------------

/** A community derived by content clustering (no manifest seeds). */
export interface AutoCommunity {
  communityId: string;
  seedSource: "auto";
  label: string;
  /** Member section node_keys, sorted ascending. */
  sectionKeys: string[];
}

/** One in-progress cluster during the greedy pass. */
interface ClusterBuilder {
  anchorKey: string;
  label: string;
  centroid: number[];
  memberCount: number;
  sectionKeys: string[];
}

const AUTO_SEED_SOURCE = "auto" as const;
/** Cosine threshold below which a section starts a new cluster. */
const DEFAULT_CLUSTER_SIMILARITY = 0.5;
/** Prefix that keeps auto IDs disjoint from manifest IDs (16-hex md5). */
const AUTO_COMMUNITY_PREFIX = "auto-";

function sectionKey(section: IndexableSection): string {
  return section.nodeKey || section.fileId || "";
}

/**
 * Greedy threshold clustering over section embeddings — the simple,
 * deterministic clustering the handoff mandates FIRST (NOT Leiden; swap in
 * Phase 5 only if report quality demands it).
 *
 * Sections process in node_key order (never input order), each joining the
 * existing cluster whose centroid is most cosine-similar, or starting a new
 * cluster when every centroid is below the threshold. The community id is
 * CONTENT-derived from the anchor section (the smallest node_key in the
 * cluster), so ids are stable across rebuilds and across edits that do not
 * change membership. Sections without an embedding are excluded (the caller
 * still assigns them — see assignAutoCommunities).
 */
export function clusterSections(
  sections: IndexableSection[],
  similarityThreshold: number = DEFAULT_CLUSTER_SIMILARITY,
): AutoCommunity[] {
  const clusterable = sections
    .filter((s) => Array.isArray(s.embedding) && s.embedding.length > 0)
    .sort((a, b) => sectionKey(a).localeCompare(sectionKey(b)));

  const clusters: ClusterBuilder[] = [];
  for (const section of clusterable) {
    const emb = section.embedding!;
    const key = sectionKey(section);

    let bestIndex = -1;
    let bestScore = -1.0;
    for (let i = 0; i < clusters.length; i++) {
      const score = cosineSimilarity(emb, clusters[i].centroid);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestScore >= similarityThreshold && bestIndex >= 0) {
      const cluster = clusters[bestIndex];
      cluster.sectionKeys.push(key);
      cluster.memberCount += 1;
      // Incremental mean — deterministic given the fixed (sorted) order.
      const previousCount = cluster.memberCount - 1;
      cluster.centroid = cluster.centroid.map(
        (value, i) => (value * previousCount + (emb[i] || 0)) / cluster.memberCount,
      );
    } else {
      clusters.push({
        anchorKey: key,
        label: section.headingPath || section.nodeKey || key,
        centroid: [...emb],
        memberCount: 1,
        sectionKeys: [key],
      });
    }
  }

  return clusters.map((c) => ({
    communityId: autoCommunityId(c.anchorKey),
    seedSource: AUTO_SEED_SOURCE,
    label: c.label,
    sectionKeys: c.sectionKeys,
  }));
}

function autoCommunityId(anchorKey: string): string {
  return (
    AUTO_COMMUNITY_PREFIX +
    crypto.createHash("md5").update(anchorKey).digest("hex").slice(0, 16)
  );
}

/**
 * Assign every section to a community: cluster members to their own cluster;
 * sections without an embedding go to the LARGEST cluster (ties broken by
 * lexicographically smallest community_id) so "every section assigned" holds
 * even when an embed fails. Deterministic; no-op with no communities.
 */
export async function assignAutoCommunities(
  db: CommunityStore,
  sections: IndexableSection[],
  communities: AutoCommunity[],
): Promise<void> {
  if (communities.length === 0) return;

  const communityForSection = new Map<string, string>();
  for (const community of communities) {
    for (const key of community.sectionKeys) {
      communityForSection.set(key, community.communityId);
    }
  }

  let fallback = communities[0].communityId;
  let fallbackSize = -1;
  for (const community of communities) {
    if (community.sectionKeys.length > fallbackSize) {
      fallbackSize = community.sectionKeys.length;
      fallback = community.communityId;
    } else if (
      community.sectionKeys.length === fallbackSize &&
      community.communityId < fallback
    ) {
      fallback = community.communityId;
    }
  }

  for (const section of sections) {
    const key = sectionKey(section);
    if (!key) continue;
    await db.assignSectionToCommunity(key, communityForSection.get(key) ?? fallback);
  }
}

/**
 * Build-time entry for unseeded vaults: cluster every section and persist
 * the auto communities + assignments. The caller is expected to have cleared
 * the index first (build calls clearAll).
 */
export async function ensureAutoCommunities(
  db: CommunityBuildStore,
  sections: IndexableSection[],
): Promise<void> {
  const communities = clusterSections(sections);
  for (const community of communities) {
    await db.insertCommunity({
      communityId: community.communityId,
      seedSource: community.seedSource,
      label: community.label,
    });
  }
  await assignAutoCommunities(db, sections, communities);
}
