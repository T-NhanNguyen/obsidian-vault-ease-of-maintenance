// Transport timeout tests — the plugin path (Obsidian's requestUrl) has no
// native timeout, so postJsonViaRequestUrl races the request against a timer.
// A stalled provider used to hold the whole build phase open forever with no
// progress and no error, because the enrichment leg never resolved.
//
// The obsidian module is mocked here: the shared stub throws synchronously
// (proving the transport boundary), but these tests need a controllable
// requestUrl to simulate a stall.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The plugin transport uses window timers (Obsidian runs in a renderer). The
// vitest node environment has no window, so alias it to the node global — the
// transport reads window at CALL time, so this runs before any test body.
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));

vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  postJsonViaRequestUrl,
} from "../../src/http";

/** A request that is accepted and then never answers — the stalled-provider
 * shape that hung the build. */
function stallingRequestUrl(): Promise<never> {
  return new Promise<never>(() => undefined);
}

beforeEach(() => {
  requestUrlMock.mockReset();
});

describe("postJsonViaRequestUrl timeout", () => {
  it("rejects once the request outlives the ceiling", async () => {
    requestUrlMock.mockImplementation(stallingRequestUrl);

    await expect(postJsonViaRequestUrl("http://example.test/v1", {}, {}, 30)).rejects.toThrow(
      /request timed out after \d+s/,
    );
  });

  it("marks the timeout so the LLM retry loop can fail fast", async () => {
    requestUrlMock.mockImplementation(stallingRequestUrl);

    const error = await postJsonViaRequestUrl("http://example.test/v1", {}, {}, 30).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as { isRequestTimeout?: boolean }).isRequestTimeout).toBe(true);
  });

  it("returns the parsed body when the response beats the ceiling", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: { ok: true } });

    const result = await postJsonViaRequestUrl("http://example.test/v1", {}, {}, 1000);

    expect(result).toEqual({ status: 200, ok: true, body: { ok: true } });
  });

  it("marks non-2xx responses as not ok", async () => {
    requestUrlMock.mockResolvedValue({ status: 503, json: { error: "loading" } });

    const result = await postJsonViaRequestUrl("http://example.test/v1", {}, {}, 1000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("defaults to a bounded ceiling", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(600_000);
  });
});
