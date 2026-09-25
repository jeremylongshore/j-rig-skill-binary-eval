import { describe, it, expect } from "vitest";
import { redactProviderError, MAX_PROVIDER_ERROR_CHARS } from "./redact.js";

describe("redactProviderError — credential boundary for judge errors", () => {
  it("keeps a plain provider status message intact (NEGATIVE: no over-redaction of the useful part)", () => {
    expect(redactProviderError("HTTP 401 authentication")).toBe("HTTP 401 authentication");
    expect(redactProviderError("HTTP 429 rate limited: retry after 30s")).toBe(
      "HTTP 429 rate limited: retry after 30s",
    );
  });

  it("strips Authorization / Bearer headers echoed by a transport", () => {
    const out = redactProviderError(
      "request failed: Authorization: Bearer sk-ant-api03-VERYSECRETVALUE1234567890abcdef (401)",
    );
    expect(out).not.toMatch(/VERYSECRET/);
    expect(out).toMatch(/401/);
  });

  it("strips key= / api_key= / token= values in query strings and JSON bodies", () => {
    const out = redactProviderError(
      'POST https://api.example.com/v1?key=AIzaSyA-FAKE-KEY-VALUE-0123456789abcd failed; body {"api_key":"gsk_abcdefghijklmnopqrstuvwxyz0123","token":"xoxb-1234567890-abcdefghij"}',
    );
    expect(out).not.toMatch(/AIzaSy/);
    expect(out).not.toMatch(/gsk_/);
    expect(out).not.toMatch(/xoxb-/);
    expect(out).toMatch(/failed/);
  });

  it("strips well-known key prefixes and JWTs even without a key= label", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactProviderError(
      `invalid token ${jwt}; also ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`,
    );
    expect(out).not.toMatch(/eyJ/);
    expect(out).not.toMatch(/ghp_/);
    expect(out).not.toMatch(/npm_/);
  });

  it("strips any 32+ char opaque run (unknown provider formats)", () => {
    const out = redactProviderError(
      "upstream said: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa99887766554433221100",
    );
    expect(out).toBe("upstream said: [redacted]");
  });

  it("truncates to the signed-reason budget", () => {
    const out = redactProviderError("x ".repeat(1000));
    expect(out.length).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_CHARS);
  });

  it("never throws on non-string input", () => {
    expect(redactProviderError(undefined)).toBe("undefined");
    expect(redactProviderError({ toString: () => "obj" })).toBe("obj");
  });
});
