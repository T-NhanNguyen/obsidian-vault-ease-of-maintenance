// Transport seam tests — exercises the fetch branch, the plain-Node default.
// The requestUrl branch only runs inside Obsidian; the switch test below
// proves the mode switch actually routes into it (via the stub, which throws).

import { describe, it, expect, afterEach } from "vitest";
import { postJson, setHttpTransport } from "../../src/http";

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
  setHttpTransport("fetch");
  delete (globalThis as unknown as { fetch?: FetchMock }).fetch;
});

describe("postJson (fetch transport)", () => {
  it("posts JSON and returns the parsed body on 2xx", async () => {
    let capturedInit: { method?: string; body?: string } | undefined;
    stubFetch(async (input, init) => {
      capturedInit = init;
      expect(input).toBe("http://example.test/v1");
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    });

    const result = await postJson("http://example.test/v1", { "X-Test": "1" }, { hello: "world" }, 5000);

    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(capturedInit?.body || "{}")).toEqual({ hello: "world" });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ ok: true });
  });

  it("marks non-2xx responses as not ok and keeps the status", async () => {
    stubFetch(async () => ({ status: 503, ok: false, json: async () => ({ error: "loading" }) }));

    const result = await postJson("http://example.test/v1", {}, {}, 5000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("returns a null body when the response is not JSON", async () => {
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new Error("invalid json"); },
    }));

    const result = await postJson("http://example.test/v1", {}, {}, 5000);

    expect(result.ok).toBe(true);
    expect(result.body).toBeNull();
  });
});

describe("postJson transport switching", () => {
  it("defaults to fetch and routes to requestUrl only when switched", async () => {
    // Default mode: fetch branch is live.
    stubFetch(async () => ({ status: 200, ok: true, json: async () => ({ via: "fetch" }) }));
    const viaFetch = await postJson("http://example.test/v1", {}, {}, 5000);
    expect(viaFetch.body).toEqual({ via: "fetch" });

    // Switched mode: the plugin path is reached (stub throws a loud error).
    setHttpTransport("requestUrl");
    await expect(postJson("http://example.test/v1", {}, {}, 5000)).rejects.toThrow(
      /requestUrl branch is plugin-only/
    );
  });
});
