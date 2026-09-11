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

/** Ceiling for ONE plugin HTTP request. Obsidian's requestUrl cannot be
 * aborted, so a timeout detaches from the in-flight request and discards its
 * eventual result — the goal is a BOUNDED failure, not cancellation. Without
 * this a stalled provider held the whole build phase open indefinitely with no
 * progress and no error (the enrichment leg never resolved, so neither its
 * completion nor its failure message could ever be emitted). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Timeout marker. The LLM retry loop fails fast on it instead of re-waiting
 * the full timeout on each attempt. Exposed as a duck-typed flag rather than
 * an instanceof check because tests replace this module wholesale. */
export class RequestTimeoutError extends Error {
  readonly isRequestTimeout = true;
}

// Plugin transport. requestUrl has no timeout option of its own, so the
// ceiling is enforced by racing the request against a timer.
export async function postJsonViaRequestUrl(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<HttpJsonResponse> {
  const request = requestUrl({
    url,
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    contentType: "application/json",
    throw: false,
  }).then((response: RequestUrlResponse): HttpJsonResponse => ({
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    body: response.json,
  }));
  // The loser of the race must never surface as an unhandled rejection.
  request.catch(() => undefined);

  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      reject(
        new RequestTimeoutError(`request timed out after ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
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
