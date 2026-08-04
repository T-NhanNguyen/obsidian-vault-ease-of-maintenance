// Embedder — generates embeddings via an OpenAI-compatible HTTP API.
// Ported from src/indexer/embedder.py

import { settings, resolveApiKey } from "../config";

// Interface for pluggable embedders (real API + deterministic test fake)
export interface IEmbedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

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
    const response = await fetch(`${this.apiBase}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Embeddings API error: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    const raw = body.data || [];
    raw.sort((a: any, b: any) => (a.index || 0) - (b.index || 0));
    return raw.map((item: any) => item.embedding);
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
