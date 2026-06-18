import { describe, it, expect, vi } from "vitest";
import { makeSkillDoc, bootstrap } from "@j-rig/refiner-core";
import {
  score,
  ScoreAdapterError,
  type EvalRunner,
  type EvalInvocation,
  type EvalRunnerResult,
} from "./score.js";

const doc = makeSkillDoc("demo", "# Demo\n\nA procedural instruction line of real length.\n");
const evalSet = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });

/** Build a fake EvalRunner that returns canned `j-rig eval --json` output. */
function fakeRunner(
  result: Partial<EvalRunnerResult>,
  spy?: (i: EvalInvocation) => void,
): EvalRunner {
  return {
    async run(invocation: EvalInvocation): Promise<EvalRunnerResult> {
      spy?.(invocation);
      return { stdout: "", stderr: "", exitCode: 0, ...result };
    },
  };
}

/** Canonical `j-rig eval --json` shape, keyed by model with a scoreCard. */
function jrigJson(model: string, passed: number, total: number): string {
  return JSON.stringify({
    [model]: {
      provider: "stub",
      model,
      ground_truth: false,
      scoreCard: {
        total_criteria: total,
        passed,
        failed: total - passed,
        unsure: 0,
        blocker_failures: 0,
        sacred_regressions: 0,
        pass_rate: total > 0 ? passed / total : 0,
      },
      decision: "ship",
    },
  });
}

describe("score() adapter — delegates to `j-rig eval` (build-order step 5)", () => {
  it("DELEGATES: invokes the runner with skillDir + --json + the tier model", async () => {
    const seen: EvalInvocation[] = [];
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 4, 5) }, (i) => seen.push(i));
    await score(doc, evalSet, runner, { skillDir: "/skills/demo", modelTier: "sonnet" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ skillDir: "/skills/demo", modelTier: "sonnet" });
  });

  it("defaults the tier to sonnet when unspecified", async () => {
    const seen: EvalInvocation[] = [];
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 5, 5) }, (i) => seen.push(i));
    await score(doc, evalSet, runner, { skillDir: "/skills/demo" });
    expect(seen[0].modelTier).toBe("sonnet");
  });

  it("MAPS pass_rate → the behavioral dimension; anchors skill + evalSet hashes", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 3, 4) });
    const record = await score(doc, evalSet, runner, { skillDir: "/d", modelTier: "sonnet" });
    expect(record.skill).toBe(doc.hash);
    expect(record.evalSet).toBe(evalSet.hash);
    expect(record.behavioral.value).toBeCloseTo(0.75, 6);
    expect(record.behavioral.n).toBe(4);
    // Bernoulli-proportion variance p(1-p) for the significance test.
    expect(record.behavioral.variance).toBeCloseTo(0.75 * 0.25, 6);
    // Multi-dimensional (Goodhart-resistant): a deterministic companion dim.
    expect(record.dimensions.pass_count).toEqual({ value: 3, variance: 0, n: 4 });
    expect(record.dimensions.behavioral).toEqual(record.behavioral);
  });

  it("recomputes pass_rate when j-rig omits it", async () => {
    const stdout = JSON.stringify({
      sonnet: { scoreCard: { total_criteria: 4, passed: 1 } },
    });
    const record = await score(doc, evalSet, fakeRunner({ stdout }), {
      skillDir: "/d",
      modelTier: "sonnet",
    });
    expect(record.behavioral.value).toBeCloseTo(0.25, 6);
  });

  it("picks the sole entry when the model key differs (OpenAI-compat vendor id)", async () => {
    const stdout = jrigJson("deepseek-chat", 2, 2);
    const record = await score(doc, evalSet, fakeRunner({ stdout }), {
      skillDir: "/d",
      modelTier: "sonnet",
    });
    expect(record.behavioral.value).toBe(1);
  });

  it("throws ScoreAdapterError on a non-zero evaluator exit", async () => {
    const runner = fakeRunner({ exitCode: 1, stderr: "package integrity failed" });
    await expect(
      score(doc, evalSet, runner, { skillDir: "/d", modelTier: "sonnet" }),
    ).rejects.toThrow(ScoreAdapterError);
  });

  it("throws when stdout has no parseable JSON", async () => {
    const runner = fakeRunner({ stdout: "no json here" });
    await expect(
      score(doc, evalSet, runner, { skillDir: "/d", modelTier: "haiku" }),
    ).rejects.toThrow(/no parseable JSON/);
  });

  it("throws when the picked model result has no scoreCard", async () => {
    const stdout = JSON.stringify({ sonnet: { provider: "stub" } });
    await expect(
      score(doc, evalSet, fakeRunner({ stdout }), { skillDir: "/d", modelTier: "sonnet" }),
    ).rejects.toThrow(/no scoreCard/);
  });

  it("throws when the JSON has no per-model results", async () => {
    await expect(
      score(doc, evalSet, fakeRunner({ stdout: "{}" }), { skillDir: "/d", modelTier: "sonnet" }),
    ).rejects.toThrow(/no per-model results/);
  });

  it("throws when no entry matches the tier and there are multiple entries", async () => {
    const stdout = JSON.stringify({
      "vendor-a": { scoreCard: { total_criteria: 1, passed: 1, pass_rate: 1 } },
      "vendor-b": { scoreCard: { total_criteria: 1, passed: 0, pass_rate: 0 } },
    });
    await expect(
      score(doc, evalSet, fakeRunner({ stdout }), { skillDir: "/d", modelTier: "sonnet" }),
    ).rejects.toThrow(/no result for model 'sonnet'/);
  });

  it("clamps a malformed (out-of-range) pass_rate into [0,1]", async () => {
    const stdout = JSON.stringify({
      sonnet: { scoreCard: { total_criteria: 2, passed: 2, pass_rate: 5 } },
    });
    const record = await score(doc, evalSet, fakeRunner({ stdout }), {
      skillDir: "/d",
      modelTier: "sonnet",
    });
    expect(record.behavioral.value).toBe(1);
  });

  it("does NOT spawn a real process (the seam is fully injected)", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 1, 1) });
    const runSpy = vi.spyOn(runner, "run");
    await score(doc, evalSet, runner, { skillDir: "/d", modelTier: "sonnet" });
    expect(runSpy).toHaveBeenCalledOnce();
  });
});
