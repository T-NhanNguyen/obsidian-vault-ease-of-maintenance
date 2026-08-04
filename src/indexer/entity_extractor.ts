// Entity extractor — regex-based extraction of key entities from markdown.
// Ported from src/indexer/entity_extractor.py

import * as crypto from "crypto";

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

export interface SectionForEdge {
  nodeKey?: string;
  text?: string;
  embedding?: number[];
}

export class EntityExtractor {
  private static readonly WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  private static readonly TAG_PATTERN = /(?:^|\s)(#[a-zA-Z][a-zA-Z0-9_-]*)/g;
  private static readonly CAPITALIZED_PATTERN = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/g;

  extract(text: string): Entity[] {
    const seen = new Set<string>();
    const entities: Entity[] = [];

    // Wikilinks
    for (const match of text.matchAll(EntityExtractor.WIKILINK_PATTERN)) {
      const name = match[1].trim();
      const eid = EntityExtractor.entityId(name);
      if (!seen.has(eid)) {
        seen.add(eid);
        entities.push({ entityId: eid, name, type: "wikilink" });
      }
    }

    // Tags
    for (const match of text.matchAll(EntityExtractor.TAG_PATTERN)) {
      const name = match[1].trim();
      const eid = EntityExtractor.entityId(name);
      if (!seen.has(eid)) {
        seen.add(eid);
        entities.push({ entityId: eid, name, type: "tag" });
      }
    }

    // Capitalized phrases
    for (const match of text.matchAll(EntityExtractor.CAPITALIZED_PATTERN)) {
      const name = match[0].trim();
      if (name.length < 4) continue;
      const eid = EntityExtractor.entityId(name);
      if (!seen.has(eid)) {
        seen.add(eid);
        entities.push({ entityId: eid, name, type: "phrase" });
      }
    }

    return entities;
  }

  computeWikilinkEdges(
    sections: SectionForEdge[],
    fileId: string,
    fileExistsFn?: (key: string) => boolean,
  ): Edge[] {
    const edges: Edge[] = [];
    const seen = new Set<string>();

    for (const section of sections) {
      const srcKey = section.nodeKey || "";
      const text = section.text || "";

      for (const match of text.matchAll(EntityExtractor.WIKILINK_PATTERN)) {
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
    sections: SectionForEdge[],
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
        const sim = EntityExtractor.cosineSimilarity(srcEmb, dstEmb);
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

  static entityId(name: string): string {
    return crypto.createHash("md5").update(name.toLowerCase()).digest("hex").slice(0, 16);
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0.0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
