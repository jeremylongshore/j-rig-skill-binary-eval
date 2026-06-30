import { describe, it, expect } from "vitest";
import { coerceVerdict, extractVerdict } from "./verdict.js";

describe("coerceVerdict", () => {
  it("accepts the three valid verdicts case-insensitively", () => {
    expect(coerceVerdict("yes")).toBe("yes");
    expect(coerceVerdict("NO")).toBe("no");
    expect(coerceVerdict("Unsure")).toBe("unsure");
  });

  it("rejects anything else", () => {
    expect(coerceVerdict("maybe")).toBeNull();
    expect(coerceVerdict("")).toBeNull();
    expect(coerceVerdict(undefined)).toBeNull();
    expect(coerceVerdict(null)).toBeNull();
    expect(coerceVerdict(1)).toBeNull();
  });
});

describe("extractVerdict", () => {
  it("prefers a valid structured verdict", () => {
    expect(extractVerdict("ignored raw text", "yes")).toBe("yes");
    expect(extractVerdict('{"verdict":"no"}', "no")).toBe("no");
  });

  it("recovers the verdict from a JSON object truncated before it closes", () => {
    // The exact shape parseJsonObject() rejects (no closing brace): a verbose
    // reasoning truncated at the token ceiling. parsedVerdict is undefined
    // because the structured parse failed upstream.
    const truncated =
      '{"verdict": "yes", "confidence": 1.0, "reasoning": "satisfies the criterion because the output';
    expect(extractVerdict(truncated, undefined)).toBe("yes");
  });

  it("recovers the verdict from a markdown-fenced object", () => {
    const fenced = '```json\n{"verdict": "no", "reasoning": "fails"}\n```';
    expect(extractVerdict(fenced, undefined)).toBe("no");
  });

  it("tolerates single quotes and extra whitespace around the token", () => {
    expect(extractVerdict("{ 'verdict' :  'unsure' , ...", undefined)).toBe("unsure");
  });

  it("falls back to unsure when the parsed verdict is unrecognized", () => {
    // "maybe" is not a valid verdict and no recoverable token exists in raw text.
    expect(extractVerdict('{"verdict":"maybe"}', "maybe")).toBe("unsure");
  });

  it("returns unsure when no verdict token is present at all", () => {
    expect(extractVerdict("the answer is clearly yes, it satisfies", undefined)).toBe("unsure");
    expect(extractVerdict("", undefined)).toBe("unsure");
  });

  it("does not false-match the word 'yes' in prose without a verdict key", () => {
    expect(extractVerdict("yes the output is fine", undefined)).toBe("unsure");
  });
});
