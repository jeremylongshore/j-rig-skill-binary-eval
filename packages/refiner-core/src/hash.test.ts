import { describe, it, expect } from "vitest";
import { sha256, canonicalJson, hashSkillDoc, hashValue } from "./hash.js";

describe("sha256", () => {
  it("is deterministic and 64 lowercase-hex chars", () => {
    const a = sha256("hello");
    const b = sha256("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively so equal values hash identically", () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("makes hashValue order-insensitive for objects", () => {
    expect(hashValue({ x: 1, y: 2 })).toBe(hashValue({ y: 2, x: 1 }));
  });
});

describe("hashSkillDoc", () => {
  it("differs for different text", () => {
    expect(hashSkillDoc("a")).not.toBe(hashSkillDoc("b"));
  });
});
