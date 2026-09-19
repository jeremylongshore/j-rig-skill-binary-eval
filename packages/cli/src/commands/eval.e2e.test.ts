import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EvidenceStatementSchema, PREDICATE_URI } from "@j-rig/core";
import { createDatabase } from "@j-rig/db";

/**
 * End-to-end self-eval: the tool that evaluates skills, tested evaluating a
 * skill (071 P1 #6). This spawns the BUILT CLI (`dist/index.js`) against
 * j-rig's own `skill/SKILL.md` + `skill/eval.yaml` and asserts that:
 *   1. the eval runs to a real verdict (exit 0, not a crash);
 *   2. `--emit-bundle` writes a real Evidence Bundle;
 *   3. every emitted row is a KERNEL-VALID `gate-result/v1` in-toto Statement
 *      (validated against the canonical `@j-rig/core` schema, not a hand-rolled
 *      shape check) — closing the seam the platform was missing: an eval that
 *      produced a verdict but never emitted a consumable bundle.
 *
 * Runs under the STUB provider (deterministic, no network, no API key) so the
 * verdict is reproducible in CI; the row honestly carries `ground_truth: false`.
 * Real-provider (DeepSeek) ground-truth grading is exercised separately in the
 * dogfood path, not in this committed unit gate.
 *
 * Depends on a built `dist/` (same contract as emit-evidence.test.ts); CI runs
 * `build` before `test`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "../../dist/index.js");
const SKILL_DIR = join(HERE, "../../../../skill");
const SPEC_PATH = join(SKILL_DIR, "eval.yaml");

const PLACEHOLDER_HASH = /^sha256:(0{64}|1{64}|a{64})$/;

/** Minimal read-side view of an emitted row for assertions (no `any`). */
interface GateRow {
  _type: string;
  predicateType: string;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicate: {
    gate_id: string;
    gate_decision: string;
    input_hash: string;
    policy_hash: string;
    metadata?: {
      schema?: string;
      rollout_decision?: string;
      ground_truth?: boolean;
      eval_run_id?: string;
      run_ids?: string[];
      skill?: { snapshot_sha256?: string };
      eval_spec?: { profile_sha256?: string };
      selected_grader?: {
        grader_id?: string;
        grader_version?: string;
        grader_snapshot_sha256?: string;
      };
      thresholds?: { status?: string; required_pass_rate?: number };
      regression?: {
        required?: boolean;
        enabled?: boolean;
        result?: string;
        baseline_sha256?: string | null;
      };
      promotion_eligible?: boolean;
    };
  };
}

describe("j-rig eval — end-to-end self-eval (the tool evaluates a skill)", () => {
  it("signs `error`, not `advisory`, when the judge provider fails on every criterion (dead judge)", () => {
    const work = mkdtempSync(join(tmpdir(), "jrig-eval-dead-judge-"));
    const bundlePath = join(work, "bundle.json");
    try {
      const r = spawnSync(
        "node",
        [
          CLI_PATH,
          "eval",
          SKILL_DIR,
          "--spec",
          SPEC_PATH,
          "--provider",
          "stub",
          "--models",
          "sonnet",
          "--db",
          join(work, "dead.db"),
          "--emit-bundle",
          bundlePath,
          "--json",
        ],
        {
          encoding: "utf-8",
          env: { ...process.env, J_RIG_ALLOW_STUB: "1", J_RIG_STUB_JUDGE_FAIL: "1" },
        },
      );
      expect(existsSync(bundlePath), `no bundle emitted:\n${r.stderr}`).toBe(true);
      // Exit contract: a dead judge is a non-evaluation -> exit 2 (bundle still
      // written). A CI step trusting the status must not see 0 here.
      expect(r.status, `dead-judge run must exit 2:\n${r.stderr}`).toBe(2);
      const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as GateRow[];
      expect(bundle.length).toBeGreaterThanOrEqual(1);
      for (const row of bundle) {
        expect(EvidenceStatementSchema.safeParse(row).success).toBe(true);
        expect(row.predicate.gate_decision).toBe("error");
        const reasons = (row.predicate as { gate_reasons?: string[] }).gate_reasons ?? [];
        expect(reasons[0]).toMatch(/judge provider failed on every judged criterion/);
        expect(reasons[0]).toMatch(/401/);
        // Credential boundary: the signed reason carries a status, never a key.
        expect(reasons[0]).not.toMatch(/sk-|Bearer\s+\S{8,}|api[_-]?key=/i);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("NEGATIVE: a healthy stub judge still signs `pass` (the override only fires on a provider failure)", () => {
    const work = mkdtempSync(join(tmpdir(), "jrig-eval-live-judge-"));
    const bundlePath = join(work, "bundle.json");
    try {
      const r = spawnSync(
        "node",
        [
          CLI_PATH,
          "eval",
          SKILL_DIR,
          "--spec",
          SPEC_PATH,
          "--provider",
          "stub",
          "--models",
          "sonnet",
          "--db",
          join(work, "ok.db"),
          "--emit-bundle",
          bundlePath,
          "--json",
        ],
        { encoding: "utf-8", env: { ...process.env, J_RIG_ALLOW_STUB: "1" } },
      );
      const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as GateRow[];
      expect(bundle[0]!.predicate.gate_decision).not.toBe("error");
      expect(r.status, `healthy stub run must exit 0:\n${r.stderr}`).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  /** Run the built CLI under the stub provider with extra failure switches. */
  function evalWithFailure(env: Record<string, string>) {
    const work = mkdtempSync(join(tmpdir(), "jrig-eval-infra-"));
    const bundlePath = join(work, "bundle.json");
    const dbPath = join(work, "infra.db");
    const r = spawnSync(
      "node",
      [
        CLI_PATH,
        "eval",
        SKILL_DIR,
        "--spec",
        SPEC_PATH,
        "--provider",
        "stub",
        "--models",
        "sonnet",
        "--db",
        dbPath,
        "--emit-bundle",
        bundlePath,
        "--json",
      ],
      { encoding: "utf-8", env: { ...process.env, J_RIG_ALLOW_STUB: "1", ...env } },
    );
    return { r, work, bundlePath, dbPath };
  }

  interface ErrorDetail {
    type: string;
    phase: string;
    category: string;
    retryable: boolean;
    affected: number;
    total: number;
    message: string;
  }

  function errorRow(bundlePath: string) {
    const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as GateRow[];
    expect(bundle).toHaveLength(1);
    const row = bundle[0]!;
    expect(EvidenceStatementSchema.safeParse(row).success).toBe(true);
    const predicate = row.predicate as GateRow["predicate"] & {
      gate_reasons: string[];
      metadata: { error_detail?: ErrorDetail };
    };
    return predicate;
  }

  it("signs `error` for a PARTIAL judge outage: one dead criterion makes the evaluation incomplete", () => {
    // Only `mentions-ship-decision` matches; the other judge criteria stay healthy.
    const { r, work, bundlePath, dbPath } = evalWithFailure({
      J_RIG_STUB_JUDGE_FAIL: "ship or no-ship rollout decision",
    });
    try {
      expect(r.status, `partial judge outage must exit 2:\n${r.stderr}`).toBe(2);
      const predicate = errorRow(bundlePath);
      expect(predicate.gate_decision).toBe("error");
      expect(predicate.gate_reasons[0]).toMatch(/^provider_failure\/judge /);
      expect(predicate.gate_reasons[0]).toMatch(
        /judge provider failed on \d+ of \d+ judged criteria/,
      );
      expect(predicate.gate_reasons[0]).not.toMatch(/every judged criterion/);

      const detail = predicate.metadata.error_detail;
      expect(detail).toMatchObject({ type: "provider_failure", phase: "judge" });

      // Mutually exclusive with promotion evidence (000-docs/042): an `error`
      // row must not also carry a promotion verdict of its own.
      const metadata = predicate.metadata as Record<string, unknown>;
      expect(metadata.gate_decision).toBeUndefined();
      expect(metadata.promotion_reasons).toBeUndefined();
      expect(predicate.gate_reasons.join("\n")).not.toMatch(/promotion/i);
      expect(detail!.affected).toBeGreaterThan(0);
      expect(detail!.affected).toBeLessThan(detail!.total);

      // stdout stays a results object, flagged so a consumer cannot mistake
      // the diagnostic scorecard for a verdict.
      const results = JSON.parse(r.stdout) as Record<
        string,
        { gate_decision?: string; evaluation_error?: ErrorDetail }
      >;
      expect(results.sonnet!.gate_decision).toBe("error");
      expect(results.sonnet!.evaluation_error?.phase).toBe("judge");
      expect((results.sonnet as Record<string, unknown>).promotion).toBeUndefined();

      // The ledger records a failed run with the same credential-free detail.
      const database = createDatabase(dbPath);
      try {
        const row = database.sqlite
          .prepare("SELECT status, error_message FROM runs ORDER BY id DESC LIMIT 1")
          .get() as { status: string; error_message: string };
        expect(row.status).toBe("failed");
        expect(JSON.parse(row.error_message)).toMatchObject({
          type: "provider_failure",
          phase: "judge",
        });
      } finally {
        database.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("signs `error` when an execution call fails, and never judges the failed test case", () => {
    const { r, work, bundlePath } = evalWithFailure({
      J_RIG_STUB_EXECUTION_FAIL: "Gate this SKILL.md",
    });
    try {
      expect(r.status, `execution outage must exit 2:\n${r.stderr}`).toBe(2);
      const predicate = errorRow(bundlePath);
      expect(predicate.gate_decision).toBe("error");
      expect(predicate.gate_reasons[0]).toMatch(/^provider_failure\/execution /);
      expect(predicate.gate_reasons[0]).toMatch(/execution provider failed on 1 of \d+ test case/);
      expect(predicate.gate_reasons[0]).toMatch(/402/);
      expect(predicate.metadata.error_detail).toMatchObject({
        type: "provider_failure",
        phase: "execution",
        affected: 1,
      });

      // The failed test case produced no judgment rows at all.
      const criteria = (
        predicate.metadata as unknown as { criteria: Array<{ test_case_id?: string }> }
      ).criteria;
      expect(criteria.length).toBeGreaterThan(0);
      expect(criteria.some((c) => c.test_case_id === "gate-in-ci")).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("emits a kernel-valid gate-result/v1 Evidence Bundle for a real eval decision", () => {
    const work = mkdtempSync(join(tmpdir(), "jrig-eval-e2e-"));
    const dbPath = join(work, "e2e.db");
    const bundlePath = join(work, "bundle.json");
    try {
      const r = spawnSync(
        "node",
        [
          CLI_PATH,
          "eval",
          SKILL_DIR,
          "--spec",
          SPEC_PATH,
          "--provider",
          "stub",
          "--models",
          "sonnet",
          "--db",
          dbPath,
          "--emit-bundle",
          bundlePath,
        ],
        { encoding: "utf-8", env: { ...process.env, J_RIG_ALLOW_STUB: "1" } },
      );

      // 1. The eval produced a verdict rather than crashing.
      expect(r.status, `eval exited non-zero:\n${r.stderr}`).toBe(0);

      // 2. A bundle file was written.
      expect(existsSync(bundlePath), "no Evidence Bundle was emitted").toBe(true);
      const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as GateRow[];
      expect(Array.isArray(bundle)).toBe(true);
      expect(bundle.length).toBeGreaterThanOrEqual(1);

      // 3. Every row is a kernel-valid gate-result/v1 in-toto Statement.
      for (const row of bundle) {
        const parsed = EvidenceStatementSchema.safeParse(row);
        expect(
          parsed.success,
          `row failed kernel validation: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);

        expect(row.predicateType).toBe(PREDICATE_URI);
        // Subject-name === gate_id invariant (composeStatement derives it).
        expect(row.subject[0].name).toBe(row.predicate.gate_id);
        expect(["pass", "fail", "advisory", "error"]).toContain(row.predicate.gate_decision);

        // Real, content-addressed hashes — not the 0000…/1111…/aaaa… placeholders
        // a static fixture would carry.
        expect(row.predicate.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(row.predicate.policy_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(row.predicate.input_hash).not.toMatch(PLACEHOLDER_HASH);

        // A real rollout verdict rode along in metadata; stub provenance is honest.
        expect(["ship", "warn", "block", "obsolete_review"]).toContain(
          row.predicate.metadata?.rollout_decision,
        );
        expect(row.predicate.metadata?.ground_truth).toBe(false);

        // Promotion metadata is a separate, content-addressed contract. The
        // default self-eval intentionally skips regression coverage, so its
        // evidence must not claim a clean promotion pass.
        expect(row.predicate.metadata?.schema).toBe("j-rig/skill-promotion/v1");
        expect(row.predicate.metadata?.eval_run_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(row.predicate.metadata?.run_ids).toContain(row.predicate.metadata?.eval_run_id);
        expect(row.predicate.metadata?.skill?.snapshot_sha256).toBe(row.predicate.input_hash);
        expect(row.predicate.metadata?.eval_spec?.profile_sha256).toBe(row.predicate.policy_hash);
        expect(row.predicate.metadata?.selected_grader).toMatchObject({
          grader_id: "j-rig-binary-criteria",
          grader_version: expect.any(String),
        });
        expect(row.predicate.metadata?.selected_grader?.grader_snapshot_sha256).toMatch(
          /^sha256:[a-f0-9]{64}$/,
        );
        expect(row.predicate.metadata?.thresholds).toMatchObject({
          required_pass_rate: 1,
        });
        expect(row.predicate.metadata?.regression).toMatchObject({
          required: true,
          enabled: false,
          result: "not-run",
          baseline_sha256: null,
        });
        expect(row.predicate.metadata?.promotion_eligible).toBe(false);
        expect(["advisory", "fail"]).toContain(row.predicate.gate_decision);
      }

      // 4. The DB→bundle link is integrity-checked: every evidence-bundle
      // artifact row stores the sha256 of the exact bytes on disk
      // (sha256:-prefixed per the platform digest convention) — not just a
      // mutable path+size pointer.
      const expectedDigest =
        "sha256:" + createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
      const database = createDatabase(dbPath);
      try {
        const artifactRows = database.sqlite
          .prepare("SELECT sha256 FROM artifacts WHERE artifact_type = 'evidence-bundle'")
          .all() as Array<{ sha256: string | null }>;
        expect(artifactRows.length).toBeGreaterThanOrEqual(1);
        for (const artifactRow of artifactRows) {
          expect(artifactRow.sha256).toBe(expectedDigest);
        }
      } finally {
        database.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("promotes a deterministic skill row only after a regression baseline runs", () => {
    const work = mkdtempSync(join(tmpdir(), "jrig-eval-promotion-e2e-"));
    const specPath = join(work, "spec.yaml");
    const baselinePath = join(work, "baseline.json");
    const bundlePath = join(work, "bundle.json");
    writeFileSync(
      specPath,
      [
        'spec_version: "1.0"',
        "skill_name: j-rig-eval",
        "description: deterministic promotion fixture",
        "criteria:",
        "  - id: output-not-empty",
        "    description: response is non-empty",
        "    method: deterministic",
        "    deterministic_check: not_empty",
        "test_cases:",
        "  - id: basic",
        "    description: basic response",
        "    tier: core",
        "    prompt: evaluate a skill",
        "    trigger_expectation: should_trigger",
        "    criteria_ids:",
        "      - output-not-empty",
        "",
      ].join("\n"),
    );
    // An empty baseline is valid evidence for this fixture: it proves the
    // comparison executed and found no prior passing criterion to regress.
    writeFileSync(baselinePath, "[]\n");

    try {
      const r = spawnSync(
        "node",
        [
          CLI_PATH,
          "eval",
          SKILL_DIR,
          "--spec",
          specPath,
          "--provider",
          "stub",
          "--models",
          "sonnet",
          "--no-trigger",
          "--db",
          join(work, "promotion.db"),
          "--regression-baseline",
          baselinePath,
          "--emit-bundle",
          bundlePath,
        ],
        { encoding: "utf-8", env: { ...process.env, J_RIG_ALLOW_STUB: "1" } },
      );

      expect(r.status, `promotion fixture failed:\n${r.stderr}`).toBe(0);
      const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as GateRow[];
      expect(bundle).toHaveLength(1);
      const metadata = bundle[0]?.predicate.metadata;
      expect(bundle[0]?.predicate.gate_decision).toBe("pass");
      expect(metadata?.promotion_eligible).toBe(true);
      expect(metadata?.regression).toMatchObject({
        required: true,
        enabled: true,
        result: "no-regressions",
      });
      expect(metadata?.regression?.baseline_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(metadata?.thresholds?.status).toBe("pass");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  // A spec author declares which model the skill targets (e.g. deepseek-v4-flash);
  // j-rig used to ignore `spec.models` and default `--models` to sonnet, which on
  // the OpenAI-compatible path 400s to empty output and blocks the run for a reason
  // unrelated to skill quality. The spec's models must be the default; `--models`
  // must still override.
  it("uses the spec's models by default and lets --models override", () => {
    const work = mkdtempSync(join(tmpdir(), "jrig-models-e2e-"));
    const specPath = join(work, "spec.yaml");
    writeFileSync(
      specPath,
      [
        'spec_version: "1.0"',
        "skill_name: j-rig-eval",
        "description: model-resolution e2e",
        "models:",
        "  - spec-model-alpha",
        "criteria:",
        "  - id: c1",
        "    description: produces a non-empty response",
        "    method: deterministic",
        "    deterministic_check: not_empty",
        "test_cases:",
        "  - id: t1",
        "    description: basic",
        "    tier: core",
        "    prompt: evaluate a skill",
        "    trigger_expectation: should_trigger",
        "    criteria_ids:",
        "      - c1",
        "",
      ].join("\n"),
    );
    const run = (extraArgs: string[], db: string) =>
      spawnSync(
        "node",
        [
          CLI_PATH,
          "eval",
          SKILL_DIR,
          "--spec",
          specPath,
          "--provider",
          "stub",
          "--db",
          db,
          ...extraArgs,
        ],
        { encoding: "utf-8", env: { ...process.env, J_RIG_ALLOW_STUB: "1" } },
      );
    try {
      // No --models → the spec's model is used, not the sonnet default.
      const r1 = run([], join(work, "a.db"));
      expect(r1.status, `default-models run failed:\n${r1.stderr}`).toBe(0);
      expect(r1.stdout).toContain("spec-model-alpha");
      expect(r1.stdout).not.toContain("Model: sonnet");

      // --models still overrides the spec.
      const r2 = run(["--models", "flag-model-beta"], join(work, "b.db"));
      expect(r2.status, `override run failed:\n${r2.stderr}`).toBe(0);
      expect(r2.stdout).toContain("flag-model-beta");
      expect(r2.stdout).not.toContain("spec-model-alpha");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("returns a machine-readable run row when functional evaluation is skipped", () => {
    const work = mkdtempSync(join(tmpdir(), "jrig-trigger-only-e2e-"));
    try {
      const r = spawnSync(
        "node",
        [
          CLI_PATH,
          "eval",
          SKILL_DIR,
          "--spec",
          SPEC_PATH,
          "--provider",
          "stub",
          "--models",
          "sonnet",
          "--db",
          join(work, "trigger-only.db"),
          "--no-functional",
          "--json",
        ],
        { encoding: "utf-8", env: { ...process.env, J_RIG_ALLOW_STUB: "1" } },
      );

      expect(r.status, `trigger-only eval failed:\n${r.stderr}`).toBe(0);
      const output = JSON.parse(r.stdout) as Record<
        string,
        { functional_skipped?: boolean; cost?: unknown; provider?: string }
      >;
      expect(output.sonnet).toMatchObject({
        functional_skipped: true,
        provider: "stub",
        cost: null,
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
