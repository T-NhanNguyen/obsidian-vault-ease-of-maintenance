// Deterministic local embedder for offline tests.
// Ported verbatim from tests/fixtures/fake_embedder.py
// Three-gram feature hashing — algorithm must stay byte-identical.

import * as crypto from "crypto";

const WORD_RE = /[a-z0-9]+/g;

export class FakeEmbedder {
  dimensions: number;

  constructor(dimensions: number = 64) {
    this.dimensions = dimensions;
  }

  private static grams(text: string): Set<string> {
    const grams = new Set<string>();
    const words = text.toLowerCase().match(WORD_RE) || [];
    for (const word of words) {
      if (word.length <= 3) {
        grams.add(word);
      } else {
        for (let i = 0; i < word.length - 2; i++) {
          grams.add(word.slice(i, i + 3));
        }
      }
    }
    return grams;
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array(this.dimensions).fill(0.0);
    for (const gram of FakeEmbedder.grams(text)) {
      const digest = crypto.createHash("md5").update(gram).digest();
      const index = digest[0] % this.dimensions;
      const sign = (digest[1] & 1) ? -1.0 : 1.0;
      vector[index] += sign;
    }
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm) || 1.0;
    return vector.map(v => v / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}
