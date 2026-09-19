import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — plain .mjs script with no type declarations
import { infrastructureFailureReason } from "../eval-roster/run-roster.mjs";

const REASON =
  "provider_failure/judge [minimax rate_limit, retryable]: judge provider failed on 1 of 3 judged criteria; the evaluation is incomplete: HTTP 429";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function statements(rows: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "jrig-roster-"));
  dirs.push(dir);
  const file = join(dir, "skill.statements.json");
  writeFileSync(file, typeof rows === "string" ? rows : JSON.stringify(rows), "utf8");
  return file;
}

const row = (gate_decision: string, reason: unknown) => ({
  predicate: { gate_decision, gate_reasons: [reason] },
});

describe("nightly roster — evaluator infrastructure failure (exit 2)", () => {
  it("carries the CLI's class-first reason from an `error` row", () => {
    expect(infrastructureFailureReason(statements([row("error", REASON)]))).toBe(REASON);
  });

  it("caps the carried reason so an oversized message cannot bloat signed evidence", () => {
    const long = `${REASON} ${"x".repeat(2_000)}`;
    expect(infrastructureFailureReason(statements([row("error", long)]))).toHaveLength(400);
  });

  it("refuses anything that is not an all-`error`, provider_failure-classed bundle", () => {
    expect(infrastructureFailureReason(statements([row("pass", REASON)]))).toBeNull();
    expect(infrastructureFailureReason(statements([row("error", "some other text")]))).toBeNull();
    expect(
      infrastructureFailureReason(statements([row("error", REASON), row("advisory", REASON)])),
    ).toBeNull();
    expect(infrastructureFailureReason(statements([row("error", 42)]))).toBeNull();
    expect(infrastructureFailureReason(statements([]))).toBeNull();
    expect(infrastructureFailureReason(statements({ not: "an array" }))).toBeNull();
    expect(infrastructureFailureReason(statements("{ not json"))).toBeNull();
    expect(infrastructureFailureReason(join(tmpdir(), "jrig-roster-absent.json"))).toBeNull();
  });
});
