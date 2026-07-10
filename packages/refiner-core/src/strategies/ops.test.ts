import { describe, it, expect } from "vitest";
import {
  parseProposalResponse,
  extractJsonObject,
  OpParseError,
  MAX_OPS_PER_PROPOSAL,
} from "./ops.js";

describe("extractJsonObject", () => {
  it("extracts a JSON object wrapped in prose and fences", () => {
    const text = 'Sure! Here you go:\n```json\n{"rationale":"x","ops":[]}\n```\nDone.';
    expect(extractJsonObject(text)).toBe('{"rationale":"x","ops":[]}');
  });

  it("handles braces inside string literals", () => {
    const text = '{"rationale":"contains a } brace","ops":[]}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("throws when no object is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow(OpParseError);
  });

  it("throws on an unterminated object", () => {
    expect(() => extractJsonObject('{"rationale":"x"')).toThrow(/unterminated/);
  });
});

describe("parseProposalResponse", () => {
  it("parses a valid response with mixed op kinds", () => {
    const completion = JSON.stringify({
      rationale: "tighten the trigger phrasing",
      ops: [
        { kind: "replace", target: "do the thing", content: "do X" },
        { kind: "add", after: "## Usage", content: "\nExample." },
        { kind: "delete", target: "obsolete line" },
      ],
    });
    const parsed = parseProposalResponse(completion);
    expect(parsed.rationale).toBe("tighten the trigger phrasing");
    expect(parsed.ops).toHaveLength(3);
  });

  it("truncates ops beyond the bound (robust to over-eager models)", () => {
    const ops = Array.from({ length: MAX_OPS_PER_PROPOSAL + 5 }, (_, i) => ({
      kind: "delete" as const,
      target: `line-${i}`,
    }));
    const parsed = parseProposalResponse(JSON.stringify({ rationale: "r", ops }));
    expect(parsed.ops).toHaveLength(MAX_OPS_PER_PROPOSAL);
  });

  it("drops an unknown op kind but keeps the valid ops (one bad op is not fatal)", () => {
    // Over-eager / imperfect models (esp. non-Anthropic ones) occasionally emit a
    // malformed op alongside good ones. Dropping the bad op — instead of discarding
    // the whole proposal — preserves the model's valid edits.
    const completion = JSON.stringify({
      rationale: "r",
      ops: [
        { kind: "rewrite", target: "x", content: "y" }, // invalid kind → dropped
        { kind: "delete", target: "obsolete line" }, // valid → kept
      ],
    });
    const parsed = parseProposalResponse(completion);
    expect(parsed.ops).toHaveLength(1);
    expect(parsed.ops[0]).toEqual({ kind: "delete", target: "obsolete line" });
  });

  it("drops an op with an empty anchor (field-incomplete op is not fatal)", () => {
    const completion = JSON.stringify({
      rationale: "r",
      ops: [
        { kind: "delete", target: "" }, // empty anchor → dropped
        { kind: "add", after: "## Usage", content: "\nExample." }, // valid → kept
      ],
    });
    const parsed = parseProposalResponse(completion);
    expect(parsed.ops).toHaveLength(1);
    expect(parsed.ops[0]).toEqual({ kind: "add", after: "## Usage", content: "\nExample." });
  });

  it("returns an empty (no-op) proposal when EVERY op is malformed", () => {
    // Zero surviving valid ops is a legitimate outcome, not an error.
    const completion = JSON.stringify({
      rationale: "nothing salvageable",
      ops: [{ kind: "rewrite" }, { kind: "delete", target: "" }],
    });
    const parsed = parseProposalResponse(completion);
    expect(parsed.rationale).toBe("nothing salvageable");
    expect(parsed.ops).toHaveLength(0);
  });

  it("throws when the JSON is malformed", () => {
    expect(() => parseProposalResponse("{not valid")).toThrow(OpParseError);
  });

  it("throws when the envelope is not a { rationale, ops[] } shape", () => {
    // The envelope is the ONE hard requirement — a bare array or a non-object is fatal.
    expect(() => parseProposalResponse(JSON.stringify({ ops: "not an array" }))).toThrow(
      OpParseError,
    );
  });
});
