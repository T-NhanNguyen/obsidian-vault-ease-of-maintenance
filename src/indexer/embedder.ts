// Embedder — generates embeddings via an OpenAI-compatible HTTP API.
// Ported from src/indexer/embedder.py

import { settings, resolveApiKey } from "../config";
import { postJson } from "../http";

// Interface for pluggable embedders (real API + deterministic test fake)
export interface IEmbedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const EMBED_REQUEST_TIMEOUT = 120_000; // ms

export class Embedder implements IEmbedder {
  private model: string;
  private apiBase: string;
  private dimensions: number;
  private apiKeyCache: string | null = null;

  constructor(customSettings?: { embedding?: { model?: string; dimensions?: number }; api?: { baseUrl?: string; apiKey?: string } }) {
    const s = customSettings || settings;
    this.model = s.embedding?.model || settings.embedding.model;
    this.apiBase = (s.api?.baseUrl || settings.api.baseUrl).replace(/\/$/, "");
    this.dimensions = s.embedding?.dimensions || settings.embedding.dimensions;
  }

  private getApiKey(): string {
    const key = resolveApiKey();
    if (!key) {
      throw new Error(
        "OPENAI_API_KEY (or OPENROUTER_API_KEY) environment variable is required"
      );
    }
    return key;
  }

  private async postEmbeddings(texts: string[]): Promise<number[][]> {
    const result = await postJson(
      `${this.apiBase}/embeddings`,
      {
        "Authorization": `Bearer ${this.getApiKey()}`,
        "Content-Type": "application/json",
      },
      { model: this.model, input: texts },
      EMBED_REQUEST_TIMEOUT,
    );

    if (!result.ok) {
      throw new Error(`Embeddings API error: ${result.status}`);
    }

    const body = (result.body ?? {}) as { data?: Array<{ index?: number; embedding: number[] }> };
    const raw = body.data || [];
    raw.sort((a, b) => (a.index || 0) - (b.index || 0));
    return raw.map((item) => item.embedding);
  }

  async embed(text: string): Promise<number[]> {
    const textClean = text.replace(/\n/g, " ").trim();
    if (!textClean) {
      return new Array(this.dimensions).fill(0.0);
    }
    return (await this.postEmbeddings([textClean]))[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const cleaned = texts.map(t => t.replace(/\n/g, " ").trim() || " ");
    return await this.postEmbeddings(cleaned);
  }
}
