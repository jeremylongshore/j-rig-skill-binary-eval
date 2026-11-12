import { describe, expect, it } from "vitest";
import {
  importScriptedEvals,
  assertScriptedRunAdmission,
  parseScriptedSource,
  SCRIPTED_RESULTS,
  type ScriptedSource,
} from "./scripted-evals.js";
import { scriptedGrader } from "./scripted-grader.js";
import { evaluateWithGrader } from "../grading/substrate.js";
const source: ScriptedSource = {
  skill_name: "whiteglove-pdf",
  evals: [
    {
      id: 1,
      scenario: "happy",
      prompt: "descriptive prompt",
      expected_output: "prose",
      files: [],
      expectations: ["not automatically graded"],
      assertions: [
        { cmd: "authored-command-one", expect_exit: 0, stdout_contains: "literal [a].*" },
        { cmd: "authored-command-two", expect_exit: 2 },
      ],
    },
    {
      id: 7,
      scenario: "edge",
      prompt: "another prompt",
      expected_output: "prose",
      files: [],
      expectations: [],
      assertions: [{ cmd: "authored-command-three", expect_exit: 1 }],
    },
  ],
};
function fixture() {
  const bytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  const imported = importScriptedEvals(bytes, {
    python: "/trusted/python",
    runner: "/authored/evals/run_evals.py",
    cwd: "/authored",
    runnerSha256: "a".repeat(64),
    fixtures: [],
    timeoutMs: 10000,
  });
  const request = {
    run_id: "raw_fixture",
    task: imported.task,
    config: imported.config,
    model: "authored-script",
    sample_index: 0,
  };
  const input = imported.task.input as { source_sha256: string; runner_sha256: string };
  const receipt = {
    format: SCRIPTED_RESULTS,
    complete: true,
    run_id: request.run_id,
    task_id: imported.task.id,
    task_version: imported.task.version,
    config_id: imported.config.id,
    config_version: imported.config.version,
    sample_index: 0,
    source_sha256: input.source_sha256,
    runner_sha256: input.runner_sha256,
    fixtures: [],
    cases: source.evals.map((item) => ({
      id: item.id,
      assertions: item.assertions.map((a, index) => ({
        ...a,
        index,
        exit_code: a.expect_exit,
        stdout: a.stdout_contains ?? "",
        duration_ms: 1,
        completed: true,
        passed: true,
      })),
    })),
  };
  const grade = (value: unknown) =>
    evaluateWithGrader(request.run_id, JSON.stringify(value), scriptedGrader(imported, request), {
      exit_code: 0,
      artifacts: [],
    });
  return { bytes, imported, request, receipt, grade };
}
describe("authored scripted import", () => {
  it("retains raw bytes, all descriptions and command order without execution", () => {
    const f = fixture();
    expect(Buffer.from(f.imported.source_base64, "base64")).toEqual(f.bytes);
    expect(f.imported.task.input).toMatchObject({ source });
    expect(f.imported.task.description).toContain("not graded");
    expect(f.imported.config.harness.args).toEqual([
      "/authored/evals/run_evals.py",
      "--structured",
    ]);
    expect(f.imported.config.harness.completed_exit_codes).toEqual([0, 1]);
    expect(f.grade(f.receipt).verdict).toBe("pass");
  });
  it("versions execution identity when timeout or interpreter changes", () => {
    const f = fixture();
    const base = {
      python: "/trusted/python",
      runner: "/authored/evals/run_evals.py",
      cwd: "/authored",
      runnerSha256: "a".repeat(64),
      fixtures: [],
      timeoutMs: 10000,
    };
    expect(importScriptedEvals(f.bytes, base).config.id).toBe(f.imported.config.id);
    const timeout = importScriptedEvals(f.bytes, { ...base, timeoutMs: 20000 });
    const interpreter = importScriptedEvals(f.bytes, { ...base, python: "/trusted/other-python" });
    expect(timeout.task.id).toBe(f.imported.task.id);
    expect(timeout.config.id).not.toBe(f.imported.config.id);
    expect(interpreter.config.id).not.toBe(f.imported.config.id);
  });
  it("refuses a source below the raw limit whose request envelope exceeds the producer limit", () => {
    const enlarged = structuredClone(source);
    enlarged.evals[0]!.prompt = "x".repeat(4 * 1024 * 1024 - 1100);
    const bytes = Buffer.from(JSON.stringify(enlarged));
    expect(bytes.length).toBeLessThan(4 * 1024 * 1024);
    expect(() =>
      importScriptedEvals(bytes, {
        python: "/trusted/python",
        runner: "/authored/evals/run_evals.py",
        cwd: "/authored",
        runnerSha256: "a".repeat(64),
        fixtures: [],
        timeoutMs: 10000,
      }),
    ).toThrow("request exceeds");
  });
  it("bounds samples and derived identity only for the imported lane", () => {
    const f = fixture();
    const request = { ...f.request, run_id: `raw_${"a".repeat(64)}` };
    expect(() => assertScriptedRunAdmission(request)).not.toThrow();
    expect(() =>
      assertScriptedRunAdmission({ ...request, sample_index: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow("safe integer");
    expect(() => assertScriptedRunAdmission({ ...request, run_id: "arbitrary" })).toThrow(
      "derived",
    );
  });
  it.each(["scenario", "prompt", "expected_output"] as const)(
    "rejects empty producer-required %s",
    (field) => {
      const candidate = structuredClone(source);
      candidate.evals[0]![field] = "";
      expect(() => parseScriptedSource(Buffer.from(JSON.stringify(candidate)))).toThrow();
    },
  );
  it("rejects unsupported signalled-child and out-of-range exit expectations", () => {
    const candidate = structuredClone(source);
    candidate.evals[0]!.assertions[0]!.expect_exit = -9;
    expect(() => parseScriptedSource(Buffer.from(JSON.stringify(candidate)))).toThrow();
    candidate.evals[0]!.assertions[0]!.expect_exit = 256;
    expect(() => parseScriptedSource(Buffer.from(JSON.stringify(candidate)))).toThrow();
  });
  it("grades actual exit/stdout, never a producer pass claim", () => {
    const f = fixture();
    f.receipt.cases[0]!.assertions[0]!.exit_code = 1;
    expect(f.grade(f.receipt).verdict).toBe("fail");
    f.receipt.cases[0]!.assertions[0]!.exit_code = 0;
    f.receipt.cases[0]!.assertions[0]!.stdout = "literal aZZ";
    expect(f.grade(f.receipt).verdict).toBe("fail");
  });
  it.each(["run_id", "task_id", "config_id", "source_sha256", "runner_sha256"])(
    "rejects changed %s binding",
    (key) => {
      const f = fixture();
      expect(f.grade({ ...f.receipt, [key]: "changed" }).verdict).toBe("fail");
    },
  );
  it.each(["missing", "extra", "reordered", "duplicate"])(
    "rejects %s case observations",
    (mode) => {
      const f = fixture();
      const cases = f.receipt.cases;
      if (mode === "missing") cases.pop();
      if (mode === "extra") cases.push(cases[0]!);
      if (mode === "reordered") cases.reverse();
      if (mode === "duplicate") cases[1] = cases[0]!;
      expect(f.grade(f.receipt).verdict).toBe("fail");
    },
  );
  it("rejects missing or reordered assertions and incomplete output", () => {
    const f = fixture();
    f.receipt.cases[0]!.assertions.reverse();
    expect(f.grade(f.receipt).verdict).toBe("fail");
    f.receipt.cases[0]!.assertions.pop();
    expect(f.grade(f.receipt).verdict).toBe("fail");
    expect(f.grade({ ...f.receipt, complete: false }).verdict).toBe("fail");
  });
  it("rejects duplicate JSON keys and case IDs before returning a runnable config", () => {
    expect(() =>
      parseScriptedSource(
        Buffer.from('{"skill_name":"whiteglove-pdf","skill_name":"whiteglove-pdf","evals":[]}'),
      ),
    ).toThrow();
    expect(() =>
      parseScriptedSource(
        Buffer.from(JSON.stringify({ ...source, evals: [source.evals[0], source.evals[0]] })),
      ),
    ).toThrow("duplicate case ID");
  });
  it("rejects unsupported dialect and unsafe fixtures", () => {
    expect(() =>
      parseScriptedSource(Buffer.from(JSON.stringify({ ...source, skill_name: "other" }))),
    ).toThrow();
    const altered = structuredClone(source);
    altered.evals[0]!.files = ["../outside"];
    expect(() => parseScriptedSource(Buffer.from(JSON.stringify(altered)))).toThrow();
  });
  it("refuses request or retained-byte substitution", () => {
    const f = fixture();
    expect(() =>
      scriptedGrader(f.imported, { ...f.request, config: { ...f.request.config, id: "other" } }),
    ).toThrow();
    expect(() =>
      scriptedGrader(
        { ...f.imported, source_base64: Buffer.from("{}").toString("base64") },
        f.request,
      ),
    ).toThrow();
  });
});
