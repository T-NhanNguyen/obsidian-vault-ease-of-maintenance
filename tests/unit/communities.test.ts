// Unit tests for the community concern (src/indexer/communities.ts):
// seeded cosine assignment (regression pin) + Phase-3 auto-clustering.
//
// The clustering tests use EXPLICIT hand-built embeddings so every expected
// cluster membership is hand-computable (cosine of the vectors below), and
// the community ids are pinned by full hex (md5 of the anchor node_key,
// 16 hex chars, "auto-" prefix).

import { describe, it, expect } from "vitest";
import {
  assignAutoCommunities,
  assignCommunities,
  clusterSections,
  AutoCommunity,
} from "../../src/indexer/communities";
import type { IndexableSection } from "../../src/indexer/graph";

function section(nodeKey: string, embedding: number[]): IndexableSection {
  return { nodeKey, headingPath: nodeKey.replace("::", " › "), embedding };
}

function ids(communities: AutoCommunity[]): string[] {
  return communities.map((c) => c.communityId);
}

// ---------------------------------------------------------------------------
// clusterSections — greedy threshold clustering, hand-computable expectations
// ---------------------------------------------------------------------------

describe("clusterSections", () => {
  it("clusters identical vectors together and distinct vectors apart", () => {
    const clusters = clusterSections([
      section("d.md::D", [0, 1, 0]),
      section("a.md::A", [1, 0, 0]),
      section("b.md::B", [1, 0, 0]),
      section("c.md::C", [0, 1, 0]),
    ]);

    // Sorted by node_key: a, b, c, d. a starts a cluster ([1,0,0]); b joins
    // it (cos 1); c starts a new cluster ([0,1,0]); d joins it (cos 1).
    expect(ids(clusters)).toEqual([
      "auto-3e2d148e0a111b51", // md5("a.md::A")
      "auto-8f67213c9f469d73", // md5("c.md::C")
    ]);
    expect(clusters[0].sectionKeys).toEqual(["a.md::A", "b.md::B"]);
    expect(clusters[1].sectionKeys).toEqual(["c.md::C", "d.md::D"]);
    expect(clusters[0].seedSource).toBe("auto");
    expect(clusters[0].label).toBe("a.md › A");
  });

  it("joins at exactly the threshold and starts a new cluster below it", () => {
    const clusters = clusterSections([
      section("m.md::M", [1, 0, 0, 0]),
      // cos([1,0,0,0], [0.5,0.5,0.5,0.5]) = 0.5 / (1 * 1) = 0.5 — EXACTLY at
      // the threshold (normB = 4 * 0.25 = 1.0 exact in FP) → joins M.
      section("n.md::N", [0.5, 0.5, 0.5, 0.5]),
      // cos([1,0,0,0], [0,1,0,0]) = 0 < 0.5 → own cluster.
      section("o.md::O", [0, 1, 0, 0]),
    ]);

    expect(ids(clusters)).toEqual([
      "auto-d1d71db8274599b6", // md5("m.md::M")
      "auto-9bec2d2a416a778c", // md5("o.md::O")
    ]);
    expect(clusters[0].sectionKeys).toEqual(["m.md::M", "n.md::N"]);
    expect(clusters[1].sectionKeys).toEqual(["o.md::O"]);
  });

  it("is independent of the input order (node_key sort wins)", () => {
    const input = [
      section("x.md::X", [0, 1, 0]),
      section("a.md::A", [1, 0, 0]),
      section("b.md::B", [1, 0, 0]),
    ];
    const shuffled = [input[2], input[0], input[1]];
    const first = clusterSections(input);
    const second = clusterSections(shuffled);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is deterministic across calls", () => {
    const input = [
      section("a.md::A", [1, 0, 0]),
      section("b.md::B", [0, 1, 0]),
    ];
    expect(JSON.stringify(clusterSections(input))).toBe(
      JSON.stringify(clusterSections(input)),
    );
  });

  it("excludes sections without an embedding", () => {
    const clusters = clusterSections([
      section("a.md::A", [1, 0, 0]),
      section("b.md::B", []),
      section("c.md::C", [0, 1, 0]),
    ]);
    expect(ids(clusters)).toEqual([
      "auto-3e2d148e0a111b51",
      "auto-8f67213c9f469d73",
    ]);
    const allMembers = clusters.flatMap((c) => c.sectionKeys);
    expect(allMembers).not.toContain("b.md::B");
  });

  it("keeps unchanged sections in the same clusters after a one-file change", () => {
    // Before: a,b cluster together ([1,0,0]); c is its own cluster.
    const before = clusterSections([
      section("a.md::A", [1, 0, 0]),
      section("b.md::B", [1, 0, 0]),
      section("c.md::C", [0, 1, 0]),
    ]);

    // One-file change: b's content shifted slightly ([0.9,0.1,0]) — still
    // joins a (cos 0.9 ≥ 0.5); c is untouched.
    const after = clusterSections([
      section("a.md::A", [1, 0, 0]),
      section("b.md::B", [0.9, 0.1, 0]),
      section("c.md::C", [0, 1, 0]),
    ]);

    const cBefore = before.find((c) => c.sectionKeys.includes("c.md::C"))!;
    const cAfter = after.find((c) => c.sectionKeys.includes("c.md::C"))!;
    const aBefore = before.find((c) => c.sectionKeys.includes("a.md::A"))!;
    const aAfter = after.find((c) => c.sectionKeys.includes("a.md::A"))!;

    // Unchanged sections keep their cluster id and membership.
    expect(cAfter.communityId).toBe(cBefore.communityId);
    expect(cAfter.sectionKeys).toEqual(["c.md::C"]);
    expect(aAfter.communityId).toBe(aBefore.communityId);
    expect(aAfter.sectionKeys).toEqual(["a.md::A", "b.md::B"]);
  });
});

// ---------------------------------------------------------------------------
// assignAutoCommunities — coverage contract ("every section assigned")
// ---------------------------------------------------------------------------

class RecordingCommunityStore {
  assignments = new Map<string, string>();

  async assignSectionToCommunity(sectionKey: string, communityId: string): Promise<void> {
    this.assignments.set(sectionKey, communityId);
  }
}

describe("assignAutoCommunities", () => {
  it("assigns cluster members to their cluster and unclusterable sections to the largest", async () => {
    const store = new RecordingCommunityStore();
    const communities: AutoCommunity[] = [
      {
        communityId: "auto-bbb",
        seedSource: "auto",
        label: "L",
        sectionKeys: ["a.md::A", "b.md::B"],
      },
      {
        communityId: "auto-ccc",
        seedSource: "auto",
        label: "L",
        sectionKeys: ["c.md::C"],
      },
    ];
    const sections: IndexableSection[] = [
      section("a.md::A", [1, 0]),
      section("b.md::B", [1, 0]),
      section("c.md::C", [0, 1]),
      section("d.md::D", []), // no embedding → largest cluster (auto-bbb)
      section("e.md::E", []), // no embedding → largest cluster (auto-bbb)
      section("", [1, 0]), // no key → skipped entirely
    ];

    await assignAutoCommunities(store, sections, communities);

    expect(store.assignments.get("a.md::A")).toBe("auto-bbb");
    expect(store.assignments.get("b.md::B")).toBe("auto-bbb");
    expect(store.assignments.get("c.md::C")).toBe("auto-ccc");
    expect(store.assignments.get("d.md::D")).toBe("auto-bbb");
    expect(store.assignments.get("e.md::E")).toBe("auto-bbb");
    expect(store.assignments.has("")).toBe(false);
  });

  it("breaks largest-cluster ties by lexicographically smallest id", async () => {
    const store = new RecordingCommunityStore();
    const communities: AutoCommunity[] = [
      { communityId: "auto-zzz", seedSource: "auto", label: "L", sectionKeys: ["a.md::A"] },
      { communityId: "auto-aaa", seedSource: "auto", label: "L", sectionKeys: ["b.md::B"] },
    ];

    await assignAutoCommunities(store, [section("x.md::X", [])], communities);

    expect(store.assignments.get("x.md::X")).toBe("auto-aaa");
  });

  it("is a no-op with no communities", async () => {
    const store = new RecordingCommunityStore();
    await assignAutoCommunities(store, [section("a.md::A", [1, 0])], []);
    expect(store.assignments.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Seeded assignment — regression pin (byte-identical behavior to today)
// ---------------------------------------------------------------------------

describe("assignCommunities", () => {
  it("assigns each section to its best seed by cosine and skips empty embeddings", async () => {
    const store = new RecordingCommunityStore();
    const seeds = [
      {
        communityId: "seed-1",
        seedSource: "manifest",
        label: "One",
        seedText: "one",
        folderPath: "a",
      },
      {
        communityId: "seed-2",
        seedSource: "manifest",
        label: "Two",
        seedText: "two",
        folderPath: "b",
      },
    ];
    const seedEmbeddings = new Map([
      ["seed-1", [1, 0, 0]],
      ["seed-2", [0, 1, 0]],
    ]);
    const sections: IndexableSection[] = [
      section("a.md::A", [1, 0, 0]), // cos 1 vs seed-1, 0 vs seed-2
      section("b.md::B", [0.1, 0.9, 0]), // closer to seed-2
      section("c.md::C", []), // empty embedding → not assigned
    ];

    await assignCommunities(store, sections, seeds, seedEmbeddings);

    expect(store.assignments.get("a.md::A")).toBe("seed-1");
    expect(store.assignments.get("b.md::B")).toBe("seed-2");
    expect(store.assignments.has("c.md::C")).toBe(false);
  });

  it("is a no-op when there are no seeds or no seed embeddings", async () => {
    const store = new RecordingCommunityStore();
    const sections = [section("a.md::A", [1, 0])];
    await assignCommunities(store, sections, [], new Map());
    await assignCommunities(
      store,
      sections,
      [{ communityId: "s", seedSource: "manifest", label: "S", seedText: "s", folderPath: "f" }],
      new Map(),
    );
    expect(store.assignments.size).toBe(0);
  });
});
