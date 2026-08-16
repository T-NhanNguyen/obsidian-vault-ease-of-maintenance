// Community report concern — community seeds, assignment, and the future
// summaries/report layer (the multi-pass step-3 enrichment).
//
// Seeds are PARSED from the manifest by ManifestParser (src/indexer/manifest.ts
// stays the manifest-file reader); this module owns the CommunitySeed contract
// and the assignment algorithm. The future report-generation layer (reasoning
// model with tools summarizing each community) will live here too. The DB
// layer only persists rows — no assignment logic.

import { cosineSimilarity } from "./embedding";
import type { IEmbedder } from "./embedder";
import type { IndexableSection } from "./graph";

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
