// Network transport seam — two explicit transports, no global mode switch.
//
// Inside the plugin, postJsonViaRequestUrl uses Obsidian's requestUrl
// (CORS-safe, proxy-aware; the correct transport there). Plain-Node dev,
// scripts, and vitest use postJsonViaFetch with a caller-supplied fetch
// implementation (the obsidian module has no runtime exports outside the
// plugin). The fetch implementation is injected as a parameter — its value
// reference stays at the call site (tests/scripts), never in plugin code.

import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";

export interface HttpJsonResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export type FetchLike = typeof fetch;

// Plugin transport. requestUrl has no timeout option, so the signature is
// intentionally without one.
export async function postJsonViaRequestUrl(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<HttpJsonResponse> {
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

// Plain-Node transport. Tests and dev scripts inject globalThis.fetch (the
// global is not restricted outside the Obsidian renderer).
export async function postJsonViaFetch(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): Promise<HttpJsonResponse> {
  const response = await fetchImpl(url, {
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
