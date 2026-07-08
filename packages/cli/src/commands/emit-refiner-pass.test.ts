import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  registerEmitRefinerPassCommand,
  composeRefinerPassStatement,
} from "./emit-refiner-pass.js";
import { SKILL_REFINER_PASS_V1_URI } from "@intentsolutions/core/validators/v1/skill-refiner-pass-v1";

/**
 * These tests exercise the commander-registered handler by spawning the built
 * CLI as a subprocess — the only way to assert over stdout/stderr separation
 * and exit codes (mirrors emit-evidence.test.ts). A few pure helpers are tested
 * directly against the imported module.
 *
 * The command is the structural parallel of `emit-evidence`, for the Skill
 * Refiner's ACCEPT decision (skill-refiner-pass/v1) instead of eval verdicts.
 */

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

/** 64-hex sha256 body + the prefixed form. */
const HEX = "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc";
const SHA_PREFIXED = `sha256:${HEX}`;

/** Valid UUIDv7 fixtures (version nibble 7, variant nibble [89ab]). */
const UUID_SKILL = "0189d4e0-1111-7abc-89ab-0123456789ab";
const UUID_PARENT = "0189d4e0-2222-7abc-89ab-0123456789ab";
const UUID_LINEAGE = "0189d4e0-3333-7abc-89ab-0123456789ab";

function runCli(
  args: string[],
  opts?: { cwd?: string; input?: string },
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    cwd: opts?.cwd,
    input: opts?.input,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

/** Direct-mode args for a valid ACCEPT verdict (all determinants present). */
const acceptDirectArgs = [
  "emit-refiner-pass",
  "--verdict",
  "accept",
  "--reason",
  "significant-behavioral-improvement",
  "--refiner-strategy-id",
  "naive-in-context",
  "--skill-version-id",
  UUID_SKILL,
  "--parent-version-id",
  UUID_PARENT,
  "--source-snapshot-hash",
  SHA_PREFIXED,
  "--result-snapshot-hash",
  SHA_PREFIXED,
  "--edit-proposal-hash",
  SHA_PREFIXED,
  "--eval-set-hash",
  SHA_PREFIXED,
  "--eval-set-version",
  "1.0.0",
  "--eval-set-lineage-id",
  UUID_LINEAGE,
  "--behavioral-delta",
  "0.12",
  "--alpha",
  "0.05",
  "--named-dimension",
  "readability:0.01:true",
];

/** A fully-shaped, kernel-valid accept-record (pipeline-mode JSON, snake_case). */
function validAcceptRecord(): Record<string, unknown> {
  return {
    verdict: "accept",
    reason: ["significant-behavioral-improvement"],
    refiner_strategy_id: "naive-in-context",
    skill_version_id: UUID_SKILL,
    parent_version_id: UUID_PARENT,
    source_snapshot_hash: SHA_PREFIXED,
    result_snapshot_hash: SHA_PREFIXED,
    eval_set_ref: { hash: SHA_PREFIXED, version: "1.0.0", lineage_id: UUID_LINEAGE },
    edit_proposal_hash: SHA_PREFIXED,
    behavioral_delta: 0.12,
    named_dimension_deltas: [{ id: "readability", delta: 0.01, non_regressed: true }],
    alpha: 0.05,
    test_statistic_kind: "one-sided-z",
  };
}

describe("registerEmitRefinerPassCommand — registration", () => {
  it("registers the emit-refiner-pass subcommand on a Commander program", () => {
    const program = new Command();
    registerEmitRefinerPassCommand(program);
    const cmd = program.commands.find((c) => c.name() === "emit-refiner-pass");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/skill-refiner-pass\/v1/);
  });
});

describe("emit-refiner-pass — happy path (direct mode)", () => {
  it("emits a full in-toto Statement carrying a kernel-valid skill-refiner-pass/v1 row", () => {
    const r = runCli(acceptDirectArgs);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt._type).toBe("https://in-toto.io/Statement/v1");
    // Predicate URI correctness — MUST be the kernel constant.
    expect(stmt.predicateType).toBe(SKILL_REFINER_PASS_V1_URI);
    expect(stmt.predicateType).toBe("https://evals.intentsolutions.io/skill-refiner-pass/v1");
    // Body determinants flow through.
    expect(stmt.predicate.verdict).toBe("accept");
    expect(stmt.predicate.refiner_strategy_id).toBe("naive-in-context");
    expect(stmt.predicate.skill_version_id).toBe(UUID_SKILL);
    expect(stmt.predicate.behavioral_delta).toBe(0.12);
    expect(stmt.predicate.alpha).toBe(0.05);
    expect(stmt.predicate.test_statistic_kind).toBe("one-sided-z");
    expect(stmt.predicate.named_dimension_deltas).toEqual([
      { id: "readability", delta: 0.01, non_regressed: true },
    ]);
  });

  it("binds the in-toto subject digest to result_snapshot_hash (sans sha256: prefix) [DR-085 D4]", () => {
    const r = runCli(acceptDirectArgs);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.subject).toHaveLength(1);
    // Subject digest == result_snapshot_hash WITHOUT the sha256: prefix.
    expect(stmt.subject[0].digest.sha256).toBe(HEX);
    expect(stmt.predicate.result_snapshot_hash).toBe(SHA_PREFIXED);
  });

  it("emits ONLY the predicate body when --predicate-body-only is set", () => {
    const r = runCli([...acceptDirectArgs, "--predicate-body-only"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body._type).toBeUndefined(); // not a full Statement
    expect(body.predicateType).toBeUndefined();
    expect(body.verdict).toBe("accept");
    expect(body.skill_version_id).toBe(UUID_SKILL);
  });

  it("accepts a root SkillVersion with --parent-version-id null [DR-085 D3]", () => {
    const args = [...acceptDirectArgs];
    args[args.indexOf("--parent-version-id") + 1] = "null";
    const r = runCli(args);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.predicate.parent_version_id).toBeNull();
  });

  it("--output writes to file and emits an info line on stderr", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-refiner-test-"));
    try {
      const outFile = join(tmpDir, "row.json");
      const r = runCli([...acceptDirectArgs, "--output", outFile]);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/wrote .*row.json/);
      const written = JSON.parse(readFileSync(outFile, "utf-8"));
      expect(written.predicateType).toBe(SKILL_REFINER_PASS_V1_URI);
      expect(written.predicate.verdict).toBe("accept");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("emit-refiner-pass — happy path (pipeline mode)", () => {
  it("emits a kernel-valid row from a JSON accept-record on stdin", () => {
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(validAcceptRecord()) });
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.predicateType).toBe(SKILL_REFINER_PASS_V1_URI);
    expect(stmt.predicate.verdict).toBe("accept");
    expect(stmt.predicate.eval_set_ref.version).toBe("1.0.0");
  });

  it("reads the accept-record from --input <path>", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "j-rig-emit-refiner-test-"));
    try {
      const inputFile = join(tmpDir, "record.json");
      writeFileSync(inputFile, JSON.stringify(validAcceptRecord()));
      const r = runCli(["emit-refiner-pass", "--input", inputFile]);
      expect(r.code).toBe(0);
      const stmt = JSON.parse(r.stdout);
      expect(stmt.predicate.verdict).toBe("accept");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts the refiner-core camelCase surface (convenience normalization)", () => {
    const camel = {
      verdict: "accept",
      reason: ["significant-behavioral-improvement"],
      refinerStrategyId: "naive-in-context",
      skillVersionId: UUID_SKILL,
      parentVersionId: null,
      sourceSnapshotHash: SHA_PREFIXED,
      resultSnapshotHash: SHA_PREFIXED,
      evalSetRef: { hash: SHA_PREFIXED, version: "1.0.0", lineage_id: UUID_LINEAGE },
      editProposalHash: SHA_PREFIXED,
      behavioralDelta: 0.2,
      namedDimensionDeltas: [],
      alpha: 0.05,
      testStatisticKind: "one-sided-z",
    };
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(camel) });
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.predicate.refiner_strategy_id).toBe("naive-in-context");
    expect(stmt.predicate.parent_version_id).toBeNull();
    expect(stmt.predicate.behavioral_delta).toBe(0.2);
  });

  it("emits a reject verdict (non-regression invariant does NOT apply to reject)", () => {
    const rec = validAcceptRecord();
    rec.verdict = "reject";
    rec.reason = ["no-behavioral-improvement"];
    // A reject MAY carry a regressed named dimension — kernel allows it.
    rec.named_dimension_deltas = [{ id: "readability", delta: -0.5, non_regressed: false }];
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(rec) });
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.predicate.verdict).toBe("reject");
    expect(stmt.predicate.named_dimension_deltas[0].non_regressed).toBe(false);
  });
});

describe("emit-refiner-pass — fail-closed (never emit an invalid row)", () => {
  it("rejects malformed JSON on stdin", () => {
    const r = runCli(["emit-refiner-pass"], { input: "{not valid json" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not valid JSON/);
  });

  it("rejects a JSON array (not an object)", () => {
    const r = runCli(["emit-refiner-pass"], { input: "[]" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/must be a JSON object/);
  });

  it("rejects a record missing required determinants (kernel validation)", () => {
    const partial = { verdict: "accept", reason: ["x"] };
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(partial) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed kernel validation/);
  });

  it("rejects an accept whose named dimension regressed [DR-085 D5 invariant]", () => {
    // accept + non_regressed:false must be refused by the kernel .superRefine —
    // a signed accept that claims a regression is a forgeable falsehood.
    const rec = validAcceptRecord();
    rec.named_dimension_deltas = [{ id: "readability", delta: -0.3, non_regressed: false }];
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(rec) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed kernel validation/);
    expect(r.stderr).toMatch(/non_regressed/);
  });

  it("rejects alpha outside (0, 1)", () => {
    const rec = validAcceptRecord();
    rec.alpha = 1.5;
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(rec) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed kernel validation/);
  });

  it("rejects a malformed skill_version_id (not a UUIDv7)", () => {
    const rec = validAcceptRecord();
    rec.skill_version_id = "not-a-uuid";
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(rec) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed kernel validation/);
  });

  it("refuses an unknown extra field rather than silently dropping it", () => {
    // A typo'd/injected key must NOT be silently stripped — that could mask a
    // mistyped required field. The command refuses it before kernel validation.
    const rec = validAcceptRecord();
    (rec as Record<string, unknown>).evil = "injected";
    const r = runCli(["emit-refiner-pass"], { input: JSON.stringify(rec) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unrecognized field/);
    expect(r.stderr).toMatch(/evil/);
  });

  it("rejects a bad --named-dimension direct-mode format", () => {
    const args = [...acceptDirectArgs];
    args[args.indexOf("--named-dimension") + 1] = "readability-only-one-field";
    const r = runCli(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--named-dimension must be/);
  });

  it("errors clearly on empty input (no stdin, no flags)", () => {
    const r = runCli(["emit-refiner-pass"], { input: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no input received/);
  });
});

describe("emit-refiner-pass — predicate-URI correctness (never labs.*)", () => {
  it("emits the URI ONLY from the kernel constant, host evals.intentsolutions.io", () => {
    const r = runCli(acceptDirectArgs);
    expect(r.code).toBe(0);
    const stmt = JSON.parse(r.stdout);
    expect(stmt.predicateType).toBe(SKILL_REFINER_PASS_V1_URI);
    // Host must be exactly evals.intentsolutions.io, never labs.* (ISEDC CISO
    // binding DR-004 / DR-010). Parse the URL and assert on the exact host
    // property — a substring/regex check on the whole URL string could be
    // bypassed by a crafted path segment (js/regex/missing-regexp-anchor).
    const host = new URL(stmt.predicateType).host;
    expect(host).toBe("evals.intentsolutions.io");
    expect(host).not.toBe("labs.intentsolutions.io");
  });
});

describe("composeRefinerPassStatement (pure helper)", () => {
  it("uses the kernel URI constant and binds the subject to result_snapshot_hash", () => {
    const body = {
      verdict: "accept" as const,
      reason: ["x"],
      refiner_strategy_id: "s",
      skill_version_id: UUID_SKILL,
      parent_version_id: null,
      source_snapshot_hash: SHA_PREFIXED,
      result_snapshot_hash: SHA_PREFIXED,
      eval_set_ref: { hash: SHA_PREFIXED, version: "1.0.0", lineage_id: UUID_LINEAGE },
      edit_proposal_hash: SHA_PREFIXED,
      behavioral_delta: 0.1,
      named_dimension_deltas: [],
      alpha: 0.05,
      test_statistic_kind: "one-sided-z" as const,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the pure composer over a plain body
    const stmt = composeRefinerPassStatement(body as any, "my-skill");
    expect(stmt.predicateType).toBe(SKILL_REFINER_PASS_V1_URI);
    expect(stmt._type).toBe("https://in-toto.io/Statement/v1");
    expect(stmt.subject[0].name).toBe("my-skill");
    expect(stmt.subject[0].digest.sha256).toBe(HEX);
  });
});
