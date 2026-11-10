import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeSkillDoc, bootstrap, hashValue } from "@intentsolutions/refiner-core";
import {
  score,
  createSubprocessEvalRunner,
  ScoreAdapterError,
  type EvalRunner,
  type EvalInvocation,
  type EvalRunnerResult,
} from "./score.js";

const doc = makeSkillDoc("demo", "# Demo\n\nA procedural instruction line of real length.\n");
const baseSet = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
function withItems(items: typeof baseSet.items): typeof baseSet {
  const { skillId, source, evalSetVersion, lineageParent, refreshDueAt } = baseSet;
  return {
    ...baseSet,
    items,
    hash: hashValue({ skillId, source, items, evalSetVersion, lineageParent, refreshDueAt }),
  };
}
const evalSet = withItems(
  Array.from({ length: 4 }, (_, i) => ({
    id: `case-${i}`,
    prompt: `Return the number ${i}.`,
    expectation: `The response contains only the number ${i}.`,
  })),
);

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
      ground_truth: true,
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
  it("passes the frozen document and eval-set content to the evaluator", async () => {
    const seen: EvalInvocation[] = [];
    await score(
      doc,
      evalSet,
      fakeRunner({ stdout: jrigJson("sonnet", 1, 4) }, (i) => seen.push(i)),
      {
        skillDir: "/unrelated/directory",
      },
    );
    expect(seen[0]).toMatchObject({ doc, evalSet });
  });

  it("rejects a document whose claimed hash does not match its content before evaluation", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 1, 4) });
    const runSpy = vi.spyOn(runner, "run");
    await expect(
      score({ ...doc, text: "different content" }, evalSet, runner, {
        skillDir: "/d",
      }),
    ).rejects.toThrow(/hash/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("refuses an empty scorecard instead of fabricating one observation", async () => {
    await expect(
      score(doc, evalSet, fakeRunner({ stdout: jrigJson("sonnet", 0, 0) }), {
        skillDir: "/d",
      }),
    ).rejects.toThrow(ScoreAdapterError);
  });

  it("DELEGATES: invokes the runner with skillDir + --json + the tier model", async () => {
    const seen: EvalInvocation[] = [];
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 4, 4) }, (i) => seen.push(i));
    await score(doc, evalSet, runner, { skillDir: "/skills/demo", modelTier: "sonnet" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ skillDir: "/skills/demo", modelTier: "sonnet", doc, evalSet });
  });

  it("defaults the tier to sonnet when unspecified", async () => {
    const seen: EvalInvocation[] = [];
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 4, 4) }, (i) => seen.push(i));
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
      sonnet: { ground_truth: true, scoreCard: { total_criteria: 4, passed: 1 } },
    });
    const record = await score(doc, evalSet, fakeRunner({ stdout }), {
      skillDir: "/d",
      modelTier: "sonnet",
    });
    expect(record.behavioral.value).toBeCloseTo(0.25, 6);
  });

  it("picks the sole entry when the model key differs (OpenAI-compat vendor id)", async () => {
    const stdout = jrigJson("deepseek-chat", 4, 4);
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
    const stdout = JSON.stringify({ sonnet: { ground_truth: true, provider: "stub" } });
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

  it("rejects a malformed pass_rate instead of clamping it into a trusted score", async () => {
    const stdout = JSON.stringify({
      sonnet: { ground_truth: true, scoreCard: { total_criteria: 2, passed: 2, pass_rate: 5 } },
    });
    await expect(
      score(doc, evalSet, fakeRunner({ stdout }), {
        skillDir: "/d",
        modelTier: "sonnet",
      }),
    ).rejects.toThrow(ScoreAdapterError);
  });

  it("does NOT spawn a real process (the seam is fully injected)", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 1, 4) });
    const runSpy = vi.spyOn(runner, "run");
    await score(doc, evalSet, runner, { skillDir: "/d", modelTier: "sonnet" });
    expect(runSpy).toHaveBeenCalledOnce();
  });
});

describe("frozen scoring integrity", () => {
  it("rejects changed eval-set content before calling the runner", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 4, 4) });
    const spy = vi.spyOn(runner, "run");
    const changed = { ...evalSet, items: [{ ...evalSet.items[0], prompt: "Tampered" }] };
    await expect(score(doc, changed, runner, { skillDir: "/d" })).rejects.toThrow(/hash/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects expectation-free bootstrap and duplicate item ids before evaluation", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 4, 4) });
    const spy = vi.spyOn(runner, "run");
    await expect(score(doc, baseSet, runner, { skillDir: "/d" })).rejects.toThrow(
      /expected-behavior/,
    );
    await expect(
      score(doc, withItems([evalSet.items[0], evalSet.items[0]]), runner, {
        skillDir: "/d",
      }),
    ).rejects.toThrow(/unique ids/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a foreign skill identity and malformed set before evaluation", async () => {
    const runner = fakeRunner({ stdout: jrigJson("sonnet", 4, 4) });
    const spy = vi.spyOn(runner, "run");
    await expect(
      score({ ...doc, skillId: "other-skill" }, evalSet, runner, { skillDir: "/d" }),
    ).rejects.toThrow(/identity mismatch/);
    await expect(score(doc, { ...evalSet, items: [] }, runner, { skillDir: "/d" })).rejects.toThrow(
      /invalid frozen/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    { total_criteria: 3, passed: 3, pass_rate: 1 },
    { total_criteria: 4, passed: -1, pass_rate: 0 },
    { total_criteria: 4, passed: 5, pass_rate: 1 },
    { total_criteria: 4, passed: 1.5, pass_rate: 0.375 },
    { total_criteria: 4, passed: 2, pass_rate: 1 },
    { total_criteria: 4, passed: 2, pass_rate: "0.5" },
  ])("rejects malformed or incomplete scorecard %j", async (scoreCard) => {
    const stdout = JSON.stringify({ sonnet: { ground_truth: true, scoreCard } });
    await expect(score(doc, evalSet, fakeRunner({ stdout }), { skillDir: "/d" })).rejects.toThrow(
      ScoreAdapterError,
    );
  });

  it("rejects stub evidence even when every criterion passed", async () => {
    const stdout = jrigJson("sonnet", 4, 4).replace('"ground_truth":true', '"ground_truth":false');
    await expect(score(doc, evalSet, fakeRunner({ stdout }), { skillDir: "/d" })).rejects.toThrow(
      /real-provider evidence/,
    );
  });

  it("materializes exact frozen inputs for an actual subprocess and removes private scratch", async () => {
    const child = `
      const fs = require('node:fs');
      const path = require('node:path');
      const args = process.argv.slice(1);
      const skillDir = args[0];
      const specPath = args[args.indexOf('--spec') + 1];
      const root = path.dirname(specPath);
      const doc = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const proof = { doc, spec, args, root, mode: fs.statSync(root).mode & 511 };
      console.log(JSON.stringify({ sonnet: { ground_truth: true,
        scoreCard: { total_criteria: spec.test_cases.length, passed: 3, pass_rate: 0.75 }, proof } }));
    `;
    const runner = createSubprocessEvalRunner({
      command: process.execPath,
      args: ["-e", child, "--"],
    });
    const result = await runner.run({
      doc,
      evalSet,
      skillDir: "/does-not-exist",
      modelTier: "sonnet",
      provider: "openai",
    });
    expect(result.exitCode).toBe(0);
    const { proof } = JSON.parse(result.stdout).sonnet;
    expect(proof.doc).toBe(doc.text);
    const parsed = proof.spec as {
      test_cases: { prompt: string; criteria_ids: string[] }[];
      criteria: { judge_prompt: string; id: string }[];
    };
    expect(parsed.test_cases.map((item) => item.prompt)).toEqual(
      evalSet.items.map((item) => item.prompt),
    );
    expect(parsed.criteria.map((item) => item.judge_prompt)).toEqual(
      evalSet.items.map((item) => item.expectation),
    );
    expect(parsed.test_cases.map((item) => item.criteria_ids)).toEqual(
      parsed.criteria.map((item) => [item.id]),
    );
    expect(proof.args).toContain("--no-trigger");
    expect(proof.args).toContain("openai");
    expect(proof.mode).toBe(0o700);
    expect(existsSync(proof.root)).toBe(false);
    const record = await score(doc, evalSet, runner, { skillDir: "/does-not-exist" });
    expect(record).toMatchObject({
      skill: doc.hash,
      evalSet: evalSet.hash,
      behavioral: { value: 0.75, n: 4 },
    });
  });

  it("cleans scratch after an evaluator failure", async () => {
    const child = `const path=require('node:path'); const a=process.argv.slice(1);
      console.error(path.dirname(a[a.indexOf('--spec')+1])); process.exit(9);`;
    const runner = createSubprocessEvalRunner({
      command: process.execPath,
      args: ["-e", child, "--"],
    });
    const result = await runner.run({ doc, evalSet, skillDir: "/d", modelTier: "sonnet" });
    expect(result.exitCode).toBe(9);
    expect(existsSync(result.stderr.trim())).toBe(false);
  });

  it("runs the generated contract through the real CLI while refusing its stub score", async () => {
    const validDoc = makeSkillDoc(
      "demo",
      "---\nname: demo\ndescription: Return the requested number.\n---\n\nReturn the number requested by the user.\n",
    );
    const runner = createSubprocessEvalRunner({
      command: process.execPath,
      args: [resolve("packages/cli/dist/index.js"), "eval"],
      env: { PATH: process.env.PATH, J_RIG_ALLOW_STUB: "1" },
    });
    const raw = await runner.run({
      doc: validDoc,
      evalSet,
      skillDir: "/does-not-exist",
      modelTier: "sonnet",
      provider: "stub",
    });
    expect(raw.exitCode, raw.stderr + raw.stdout).toBe(0);
    const result = JSON.parse(raw.stdout).sonnet;
    expect(result.ground_truth).toBe(false);
    expect(result.scoreCard.total_criteria).toBe(evalSet.items.length);
    await expect(score(validDoc, evalSet, fakeRunner(raw), { skillDir: "/d" })).rejects.toThrow(
      /real-provider evidence/,
    );
  }, 15000);
});
