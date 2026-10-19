import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — plain .mjs script with no type declarations
import * as rosterRunner from "../eval-roster/run-roster.mjs";
const {
  EVIDENCE_RESERVE_MINUTES,
  SKILL_TIMEOUT_MS,
  executionEnvironment,
  headroomStatuses,
  infrastructureFailureReason,
} = rosterRunner;

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

describe("nightly roster — headroom reporting (000-docs/043)", () => {
  const withHeadroom = (status: string) => ({
    predicate: { gate_decision: "pass", metadata: { headroom: { status } } },
  });

  it("reports one headroom status per model row", () => {
    expect(headroomStatuses([withHeadroom("saturated"), withHeadroom("headroom")])).toEqual([
      "saturated",
      "headroom",
    ]);
  });

  it("reports null for a row with no headroom claim, such as an `error` row", () => {
    expect(headroomStatuses([row("error", REASON), withHeadroom("near_ceiling")])).toEqual([
      null,
      "near_ceiling",
    ]);
  });

  it("returns an empty list for a malformed bundle", () => {
    expect(headroomStatuses({ not: "an array" })).toEqual([]);
  });
});

describe("nightly roster — completion budget", () => {
  it("reserves the full serial roster duration plus evidence processing time", () => {
    const roster = JSON.parse(
      readFileSync(new URL("../eval-roster/roster.json", import.meta.url), "utf8"),
    ) as { skills: unknown[] };
    const workflow = readFileSync(
      new URL("../.github/workflows/nightly-skill-evals.yml", import.meta.url),
      "utf8",
    );
    const minutes = Number(/timeout-minutes: (\d+)/.exec(workflow)?.[1]);
    expect(Number.isFinite(minutes)).toBe(true);
    expect(minutes).toBeGreaterThanOrEqual(
      (roster.skills.length * SKILL_TIMEOUT_MS) / 60_000 + EVIDENCE_RESERVE_MINUTES,
    );
    expect(minutes).toBeLessThanOrEqual(360);
  });

  it("gives nightly MiniMax-M3 an initial 16384-token budget without changing other settings", () => {
    const env = { EXISTING_SETTING: "kept" };
    expect(executionEnvironment("minimax", "MiniMax-M3", env)).toEqual({
      ...env,
      JRIG_MAX_OUTPUT_TOKENS: "16384",
    });
    expect(env).toEqual({ EXISTING_SETTING: "kept" });
  });

  it("preserves explicit budgets and leaves other providers/models alone", () => {
    const env = { JRIG_MAX_OUTPUT_TOKENS: "4096" };
    expect(executionEnvironment("minimax", "MiniMax-M3", env)).toEqual(env);
    expect(executionEnvironment("openai", "gpt-4o-mini", {})).toEqual({});
    expect(executionEnvironment("minimax", "different-model", {})).toEqual({});
    const modelOverride = { LLM_MODEL: "different-model" };
    expect(executionEnvironment("minimax", "MiniMax-M3", modelOverride)).toEqual(modelOverride);
    const gateway = { LLM_BASE_URL: "https://gateway.example/v1" };
    expect(executionEnvironment("minimax", "MiniMax-M3", gateway)).toEqual(gateway);
  });
});
