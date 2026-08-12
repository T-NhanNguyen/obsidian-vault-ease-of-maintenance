// Network transport seam.
//
// Obsidian's requestUrl is the correct transport inside the plugin (no CORS
// restrictions, respects proxy settings). Plain-Node dev and vitest keep
// using global fetch because the obsidian module has no runtime exports
// there. The plugin switches the mode once at load (main.ts onload); tests
// and plain-Node scripts stay on the default "fetch".

import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";

export type HttpTransport = "fetch" | "requestUrl";

export interface HttpJsonResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

let transport: HttpTransport = "fetch";

export function setHttpTransport(mode: HttpTransport): void {
  transport = mode;
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): Promise<HttpJsonResponse> {
  if (transport === "requestUrl") {
    // Static import, like every renderer module: esbuild externalizes
    // "obsidian" to require("obsidian") in the plugin, and vitest resolves it
    // to tests/fixtures/obsidian_stub.ts (a dynamic import() would fail inside
    // Obsidian's renderer: "Failed to resolve module specifier 'obsidian'").
    const response: RequestUrlResponse = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      contentType: "application/json",
      throw: false,
    });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      body: response.json,
    };
  }

  // Kept for plain-Node dev/tests; requestUrl is the plugin transport (global fetch is not restricted inside plain Node).
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await response.json().catch(() => null),
  };
}
