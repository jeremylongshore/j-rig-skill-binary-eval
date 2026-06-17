import { describe, it, expect } from "vitest";
import { uuidv7 } from "./uuid.js";

describe("uuidv7 (RFC 9562 § 5.7)", () => {
  it("produces canonical 8-4-4-4-12 hyphenated lowercase form", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("sets the version nibble to 7", () => {
    const id = uuidv7();
    // Version is the first nibble of the 3rd group (index 14 in the string).
    expect(id[14]).toBe("7");
  });

  it("sets the variant bits to 0b10 (8, 9, a, or b)", () => {
    const id = uuidv7();
    // Variant is the first nibble of the 4th group (index 19 in the string).
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("encodes the timestamp big-endian in the first 48 bits", () => {
    const nowMs = 0x0123456789ab;
    const id = uuidv7(nowMs);
    const tsHex = id.replace(/-/g, "").slice(0, 12);
    expect(tsHex).toBe("0123456789ab");
  });

  it("is time-ordered: a later timestamp sorts lexicographically after an earlier one", () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(2_000_000_000_000);
    expect(early < late).toBe(true);
  });

  it("generates distinct ids on repeated calls (random component)", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7()));
    expect(ids.size).toBe(100);
  });

  it("clamps a negative timestamp to zero rather than producing garbage bytes", () => {
    const id = uuidv7(-5);
    expect(id.replace(/-/g, "").slice(0, 12)).toBe("000000000000");
  });
});
