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
    metadata?: { rollout_decision?: string; ground_truth?: boolean };
  };
}

describe("j-rig eval — end-to-end self-eval (the tool evaluates a skill)", () => {
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
