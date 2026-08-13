// Transport tests for the two explicit http.ts transports.
//
// postJsonViaFetch is the plain-Node path: the caller injects the fetch
// implementation, so these tests stub globalThis.fetch and exercise the
// shared parsing logic. postJsonViaRequestUrl is plugin-only — under vitest
// the obsidian stub throws loudly, proving the function routes into the
// requestUrl branch (and that plugin code cannot silently fall back to
// plain fetch under tests).

import { describe, it, expect, afterEach } from "vitest";
import { postJsonViaFetch, postJsonViaRequestUrl } from "../../src/http";

type FetchMock = (input: string, init?: { method?: string; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}>;

function stubFetch(handler: (input: string, init?: { method?: string; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}>): void {
  (globalThis as unknown as { fetch: FetchMock }).fetch = handler;
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchMock }).fetch;
});

describe("postJsonViaFetch", () => {
  it("posts JSON and returns the parsed body on 2xx", async () => {
    let capturedInit: { method?: string; body?: string } | undefined;
    stubFetch(async (input, init) => {
      capturedInit = init;
      expect(input).toBe("http://example.test/v1");
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    });

    const result = await postJsonViaFetch(
      globalThis.fetch,
      "http://example.test/v1",
      { "X-Test": "1" },
      { hello: "world" },
      5000,
    );

    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(capturedInit?.body || "{}")).toEqual({ hello: "world" });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ ok: true });
  });

  it("marks non-2xx responses as not ok and keeps the status", async () => {
    stubFetch(async () => ({ status: 503, ok: false, json: async () => ({ error: "loading" }) }));

    const result = await postJsonViaFetch(globalThis.fetch, "http://example.test/v1", {}, {}, 5000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("returns a null body when the response is not JSON", async () => {
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new Error("invalid json"); },
    }));

    const result = await postJsonViaFetch(globalThis.fetch, "http://example.test/v1", {}, {}, 5000);

    expect(result.ok).toBe(true);
    expect(result.body).toBeNull();
  });
});

describe("postJsonViaRequestUrl (plugin-only)", () => {
  it("routes into requestUrl, which is unavailable under vitest (loud stub)", async () => {
    // The obsidian stub's requestUrl throws; a silent fallback to plain fetch
    // would fail this assertion instead — the transport boundary is real.
    await expect(postJsonViaRequestUrl("http://example.test/v1", {}, {})).rejects.toThrow(
      /requestUrl branch is plugin-only/
    );
  });
});
