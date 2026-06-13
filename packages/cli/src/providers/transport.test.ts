import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTransport } from "./transport.js";

/**
 * The default `fetch` transport is the single network-touching code path in the
 * provider adapters. These tests exercise it against a mocked global `fetch`
 * (no real network) so its request shaping + response parsing are covered
 * without coupling the suite to a live endpoint.
 */
describe("createFetchTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues a POST with JSON body + headers and parses the JSON response", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const transport = createFetchTransport();
    const res = await transport({
      url: "https://example.test/v1/chat/completions",
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: { model: "x", messages: [] },
    });

    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify({ model: "x", messages: [] }),
      }),
    );
  });

  it("returns json:null when the response body is not valid JSON", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const transport = createFetchTransport();
    const res = await transport({
      url: "https://example.test",
      method: "POST",
      headers: {},
      body: {},
    });

    expect(res).toEqual({ status: 500, json: null });
  });

  it("threads the abort signal through to fetch", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    const transport = createFetchTransport();
    await transport({
      url: "https://example.test",
      method: "POST",
      headers: {},
      body: {},
      signal: ac.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test",
      expect.objectContaining({ signal: ac.signal }),
    );
  });
});
