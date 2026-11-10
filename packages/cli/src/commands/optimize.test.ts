import { registerOptimizeCommand } from "./optimize.js";
import {
  createDatabase,
  createRun,
  getOrCreateSkillVersion,
  transitionRun,
  storeCriterionResults,
} from "@j-rig/db";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { RefinerStore, type FileSystem } from "@intentsolutions/refiner";
import { registerRefineCommand } from "@intentsolutions/refiner";
import { makeSkillDoc, bootstrap, hashValue } from "@intentsolutions/refiner-core";
import type { EvalInvocation } from "@intentsolutions/refiner";

/** Shared in-memory FileSystem so every command in a test sees the same store. */
class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, string>();
  readFile(path: string): string | null {
    return this.files.has(path) ? this.files.get(path)! : null;
  }
  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }
  appendFile(path: string, data: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  mkdirp(): void {}
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

/**
 * Build a program with the refine group registered against ONE shared
 * memory-fs store, plus a real on-disk skill dir for SKILL.md reads.
 */
function setup(assessmentRuntime: Parameters<typeof registerRefineCommand>[2] = {}): {
  program: Command;
  store: RefinerStore;
  skillDir: string;
  cleanup: () => void;
} {
  const fs = new MemoryFileSystem();
  const store = new RefinerStore({ fs, root: "/proj", clock: () => "2026-06-17T00:00:00.000Z" });
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerRefineCommand(program, () => store, assessmentRuntime);

  const dir = mkdtempSync(join(tmpdir(), "refiner-cli-"));
  const skillDir = join(dir, "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Does something useful for evaluating skills.\nallowed-tools: Read\nversion: 1.0.0\nauthor: Intent Solutions\nlicense: Apache-2.0\ncompatibility: Claude Code >=1.0.0\ntags: [eval, refiner]\n---\n\n# Demo\n\nDo the procedural thing carefully and report the outcome.\n",
    "utf8",
  );
  return { program, store, skillDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(program: Command, argv: string[]): Promise<void> {
  await program.parseAsync(["node", "j-rig", ...argv]);
}

describe("optimizer CLI to Refiner assessment", () => {
  it.each([
    "reviewed",
    "dot",
    "unreviewed",
    "failed",
    "foreign",
    "stale",
    "bad-target",
    "bad-hash",
  ])("runs the real orchestration for %s", async (scenario) => {
    const reviewed = scenario !== "unreviewed";
    const now = "2026-11-10T12:00:00Z";
    const runner = {
      run: vi.fn(async (input: EvalInvocation) => {
        const improved = input.doc.text.includes("precisely");
        const rows = input.evalSet.items.map((item, i) => ({
          criterion_id: `refiner-item-${i}`,
          test_case_id: item.id,
          verdict: (i < 10 ? i < 5 : i < (improved ? 40 : 15)) ? "yes" : "no",
        }));
        const passed = rows.filter((r) => r.verdict === "yes").length;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            model: {
              ground_truth: true,
              judge_provider: "test-judge",
              judge_model: "judge-v1",
              criterion_results: rows,
              scoreCard: { total_criteria: rows.length, passed, pass_rate: passed / rows.length },
            },
          }),
        };
      }),
    };
    const { program, store, skillDir, cleanup } = setup({ runner, now: () => now });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousCwd = process.cwd();
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Unexpected exit ${code}`);
    });
    if (scenario === "dot") process.chdir(skillDir);
    const commandSkillDir = scenario === "dot" ? "." : skillDir;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used");
    try {
      const doc = makeSkillDoc("demo-skill", readFileSync(join(skillDir, "SKILL.md"), "utf8"));
      const best = store.putSkillDoc(doc);
      store.setBest(doc.skillId, best);
      const proposal = store.putEditProposal({
        parent: doc.hash,
        ops: [{ kind: "replace", target: "carefully", content: "precisely" }],
        refinerModel: "test",
        refinerStrategyId: "test",
        rationale: "Test",
      });
      const base = bootstrap(doc, { now });
      const items = Array.from({ length: 40 }, (_, i) => ({
        id: `case-${i}`,
        prompt: `Prompt ${i}`,
        expectation: `Expected ${i}`,
        adversarial: i < 10,
      }));
      const { skillId, source, evalSetVersion, lineageParent, refreshDueAt } = base;
      const evalSet = {
        ...base,
        items,
        hash: hashValue({ skillId, source, items, evalSetVersion, lineageParent, refreshDueAt }),
      };
      const evidence = {
        evalSetHash: evalSet.hash,
        verifiedEvalSet: true,
        reviewedAt: "2026-11-09T00:00:00Z",
        expiresAt: "2026-11-11T00:00:00Z",
        judge: { provider: "test-judge", model: "judge-v1" },
        referenceItems: [{ id: "ref", prompt: "Training reference" }],
        predictions: Array.from({ length: 10 }, () => ({ confidence: 1, correct: true })),
        manifest: {
          skillId,
          evalSetHash: evalSet.hash,
          capabilities: [{ id: "task", minimumItems: 40 }],
          assignments: items.map((item) => ({ itemId: item.id, capabilityIds: ["task"] })),
        },
      };
      writeFileSync(join(skillDir, "eval.json"), JSON.stringify(evalSet));
      writeFileSync(
        join(skillDir, "quality.json"),
        JSON.stringify({
          evidence: reviewed ? evidence : undefined,
          policy: {
            maxLeakage: 0,
            maxDuplicateRatio: 0,
            maxBrierScore: 0.1,
            maxEce: 0.1,
            minCalibrationSamples: 10,
            minAdversarialItems: 10,
          },
        }),
      );
      const dbPath = join(skillDir, "source.db");
      const database = createDatabase(dbPath);
      const version = getOrCreateSkillVersion(
        database,
        scenario === "foreign" ? "other" : "demo-skill",
        "1",
        scenario === "stale" ? "old text" : doc.text,
      );
      const runId = createRun(database, version);
      transitionRun(database, runId, "running");
      transitionRun(database, runId, scenario === "failed" ? "failed" : "completed");
      storeCriterionResults(database, runId, [
        {
          criterion_id: "legacy-failure",
          passed: false,
          severity: "error",
          message: "Observed failure",
          method: "deterministic",
        },
      ]);
      database.close();
      registerOptimizeCommand(program, { storeFactory: () => store, now: () => now });
      await run(program, [
        "optimize",
        "--skill",
        "demo-skill",
        "--db",
        dbPath,
        "--run-id",
        String(runId),
        "--refiner-proposal",
        scenario === "bad-hash" ? "../invalid" : proposal,
        "--skill-dir",
        commandSkillDir,
        "--eval-set-file",
        join(skillDir, "eval.json"),
        "--target-item",
        scenario === "bad-target" ? "absent" : "case-20",
        "--change-type",
        "instruction",
        "--expected-impact",
        "Target passes",
        "--json",
      ]);
      if (!["reviewed", "dot", "unreviewed"].includes(scenario)) {
        expect(process.exitCode).toBe(1);
        expect(error).toHaveBeenCalled();
        expect(
          store
            .readLog()
            .some((event) => event.type === "stored" && event.kind === "optimizer-experiment"),
        ).toBe(false);
        expect(runner.run).not.toHaveBeenCalled();
        return;
      }
      const proposed = JSON.parse(String(log.mock.calls.at(-1)?.[0])).optimizer;
      expect(proposed.experiment.experiment.status).toBe("proposed");
      expect(store.get(proposed.experiment.source.evidenceHash)).toMatchObject({
        run: { id: runId },
        doc,
      });
      const before = store.readLog().length;
      await run(program, [
        "refine",
        "assess",
        commandSkillDir,
        "--experiment",
        proposed.stored,
        "--eval-set-file",
        join(skillDir, "eval.json"),
        "--quality-file",
        join(skillDir, "quality.json"),
        "--provider",
        "openai",
        "--json",
      ]);
      const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(store.getBest(doc.skillId)).toBe(best);
      if (reviewed) {
        expect(result.status).toBe("evaluated");
        expect(result.optimizer.experiment.experiment.status).toBe("accepted");
        expect(runner.run).toHaveBeenCalledTimes(2);
        expect(store.get(result.stored)).toMatchObject({
          baselineDoc: doc,
          evalSet,
          qualityEvidence: evidence,
        });
        expect(store.readLog().length).toBe(before + 2);
        expect(store.get(proposed.stored)).toEqual(proposed.experiment);
        expect(store.get(result.optimizer.stored)).toMatchObject({
          parent: proposed.stored,
          resolution: { assessmentHash: result.stored },
        });
      } else {
        expect(result).toMatchObject({
          status: "blocked",
          reasons: ["missing-quality-evidence"],
        });
        expect(result.optimizer.stored).toBeUndefined();
        expect(runner.run).not.toHaveBeenCalled();
        expect(store.readLog().length).toBe(before);
        expect(process.exitCode).toBe(2);
      }
    } finally {
      process.chdir(previousCwd);
      exit.mockRestore();
      process.exitCode = previousExitCode;
      vi.unstubAllEnvs();
      log.mockRestore();
      error.mockRestore();
      cleanup();
    }
  });
});
