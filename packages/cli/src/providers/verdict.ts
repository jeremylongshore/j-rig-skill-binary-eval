/**
 * Robust judge-verdict extraction.
 *
 * The binary-judge model is asked to reply with a JSON object
 * `{"verdict": "yes"|"no"|"unsure", "confidence": <0..1>, "reasoning": "..."}`.
 * The real providers parse that with `parseJsonObject` and read `parsed.verdict`.
 *
 * The failure this guards against: when the model's `reasoning` runs long the
 * response is truncated at the judge token ceiling, leaving the JSON object
 * UNTERMINATED. `parseJsonObject` (first `{` … last `}` + `JSON.parse`) then
 * returns `null`, the verdict is lost, and a clear "yes"/"no" answer is silently
 * downgraded to "unsure". Because the rollout score treats "unsure" as a
 * non-pass, that truncation inflated NO-SHIP rates on otherwise-decisive
 * answers — a measured artifact, not a property of the skill under test.
 *
 * `extractVerdict` prefers the structured value when the JSON parsed cleanly,
 * and otherwise falls back to a narrow regex over the RAW text. The verdict
 * token sits at the very start of the object (`{"verdict": "yes", ...`), so it
 * survives truncation of the trailing `reasoning` and is still recoverable when
 * the object never closes or is wrapped in a markdown fence.
 */
import type { JudgmentVerdict } from "@j-rig/core";

/** Matches the verdict token inside a (possibly truncated / fenced) JSON object. */
const VERDICT_RE = /["']?verdict["']?\s*:\s*["']?(yes|no|unsure)\b/i;

/** Narrow an arbitrary value to a valid `JudgmentVerdict`, or `null`. */
export function coerceVerdict(value: unknown): JudgmentVerdict | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase();
  return v === "yes" || v === "no" || v === "unsure" ? v : null;
}

/**
 * Recover the judge verdict from a structured parse when available, else from a
 * regex over the raw model text. Returns "unsure" only when no recognizable
 * verdict token is present at all — never merely because the JSON was truncated.
 *
 * @param rawText       The raw judge-model completion text.
 * @param parsedVerdict The `verdict` field from a successful `parseJsonObject`
 *                      (pass `parsed?.verdict`); ignored when not a valid token.
 */
export function extractVerdict(rawText: string, parsedVerdict?: unknown): JudgmentVerdict {
  const fromParsed = coerceVerdict(parsedVerdict);
  if (fromParsed) return fromParsed;
  const match = rawText.match(VERDICT_RE);
  return coerceVerdict(match?.[1]) ?? "unsure";
}
