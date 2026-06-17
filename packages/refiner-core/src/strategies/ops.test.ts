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

  it("throws on an unknown op kind", () => {
    const completion = JSON.stringify({
      rationale: "r",
      ops: [{ kind: "rewrite", target: "x", content: "y" }],
    });
    expect(() => parseProposalResponse(completion)).toThrow(OpParseError);
  });

  it("throws on an empty anchor", () => {
    const completion = JSON.stringify({
      rationale: "r",
      ops: [{ kind: "delete", target: "" }],
    });
    expect(() => parseProposalResponse(completion)).toThrow(OpParseError);
  });

  it("throws when the JSON is malformed", () => {
    expect(() => parseProposalResponse("{not valid")).toThrow(OpParseError);
  });
});
