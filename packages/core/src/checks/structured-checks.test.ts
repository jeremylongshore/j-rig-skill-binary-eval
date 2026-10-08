import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CriterionSchema } from "../schemas/criterion.js";
import { judgeCriteria } from "../judgment/engine.js";
import type { ObservedOutcome } from "../execution/types.js";
import type { Trajectory } from "../execution/trajectory.js";
import {
  evaluateWithGrader,
  GraderDefinitionSchema,
  hashGraderSnapshot,
  type DeterministicGraderDefinition,
} from "../grading/substrate.js";
import {
  parseJsonPath,
  resolveJsonPath,
  runStructuredCheck,
  structuredCheckParamIssues,
  structuredInputFromOutput,
  type StructuredCheckInput,
} from "./structured-checks.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/structured/${name}`, import.meta.url), "utf8");
const RECEIPT = fixture("receipt.json");
const SCHEMA = JSON.parse(fixture("receipt.schema.json")) as Record<string, unknown>;
const PDF_SHA = "4480c3f1dd1164a44521007b732fee306b2e3ce5f3c1cb64e2825db7b5d1e231";

const textInput: StructuredCheckInput = { text: RECEIPT, files_unavailable: "fixture: none" };

describe("JSONPath subset", () => {
  it("parses dot, bracket-quoted and index steps", () => {
    expect(parseJsonPath("$.outputs[0]['sha256']")).toEqual([
      { key: "outputs" },
      { index: 0 },
      { key: "sha256" },
    ]);
    expect(parseJsonPath(`$["weird key"]`)).toEqual([{ key: "weird key" }]);
    expect(parseJsonPath("$")).toEqual([]);
  });

  it("rejects wildcards, filters, slices and a missing root", () => {
    expect(parseJsonPath("$.outputs[*]")).toMatch(/unsupported step/);
    expect(parseJsonPath("$..sha256")).toMatch(/property name/);
    expect(parseJsonPath("$.a[?(@.b)]")).toMatch(/unsupported step/);
    expect(parseJsonPath("outputs")).toMatch(/must start with `\$`/);
  });

  it("distinguishes a missing key from a present null", () => {
    const doc = JSON.parse(RECEIPT) as unknown;
    expect(resolveJsonPath(doc, parseJsonPath(`$['weird key']`) as never)).toEqual({
      found: true,
      value: null,
    });
    expect(resolveJsonPath(doc, parseJsonPath("$.nope") as never)).toEqual({ found: false });
    expect(resolveJsonPath(doc, parseJsonPath("$.outputs[5]") as never)).toEqual({ found: false });
  });
});

describe("structured checks over text / stdout", () => {
  it("json_path asserts exists, equals and matches", () => {
    const run = (p: Record<string, unknown>) => runStructuredCheck("json_path", textInput, p);
    expect(run({ path: "$.status", exists: true }).passed).toBe(true);
    expect(run({ path: "$.missing", exists: false }).passed).toBe(true);
    expect(
      run({ path: "$.document", equals: { pages: 12, title: "Quarterly report" } }).passed,
    ).toBe(true);
    expect(run({ path: "$.warnings", equals: [] }).passed).toBe(true);
    expect(run({ path: `$['weird key']`, equals: null }).passed).toBe(true);
    expect(run({ path: "$.document.pages", equals: 13 })).toEqual({
      passed: false,
      message: "$.document.pages = 12; expected 13",
    });
    expect(run({ path: "$.outputs[0].sha256", matches: "^[a-f0-9]{64}$" }).passed).toBe(true);
    expect(run({ path: "$.document", matches: "x" }).message).toMatch(/needs a string/);
    expect(run({ path: "$.nope", equals: 1 }).passed).toBe(false);
  });

  it("json_path fails closed on output that is not JSON", () => {
    const r = runStructuredCheck(
      "json_path",
      { text: "Done! Here is your report." },
      {
        path: "$.status",
        exists: true,
      },
    );
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/the output is not valid JSON/);
  });

  it("schema_valid validates against a pinned draft 2020-12 schema", () => {
    expect(runStructuredCheck("schema_valid", textInput, { schema: SCHEMA })).toEqual({
      passed: true,
      message: "the output validates against the schema (draft 2020-12)",
    });
    const bad = JSON.stringify({ status: "maybe", document: { title: "", pages: 0 }, outputs: [] });
    const r = runStructuredCheck("schema_valid", { text: bad }, { schema: SCHEMA });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(
      /fails the schema: \/status must be equal to one of the allowed values/,
    );
  });

  it("exit_code fails closed when no exit code was observed", () => {
    expect(runStructuredCheck("exit_code", { text: "" }, { equals: 0 })).toEqual({
      passed: false,
      message: "no process exit code was observed for this run",
    });
    expect(
      runStructuredCheck("exit_code", { text: "", exit_code: null }, { equals: 0 }).message,
    ).toMatch(/killed by a signal/);
    expect(runStructuredCheck("exit_code", { text: "", exit_code: 2 }, { equals: 2 }).passed).toBe(
      true,
    );
    expect(runStructuredCheck("exit_code", { text: "", exit_code: 1 }, { equals: 0 })).toEqual({
      passed: false,
      message: "exit code 1; required 0",
    });
  });

  it("file checks fail closed when the run observes no files", () => {
    const r = runStructuredCheck("file_sha256", textInput, { path: "report.pdf", sha256: PDF_SHA });
    expect(r).toEqual({ passed: false, message: `cannot check "report.pdf": fixture: none` });
  });

  it("re-validates params at run time (defense in depth)", () => {
    expect(
      runStructuredCheck("json_path", textInput, { path: "$.a[*]", exists: true }).message,
    ).toMatch(/errored: json_path: invalid JSONPath/);
  });
});

describe("spec-load validation", () => {
  const criterion = (check: string, params: Record<string, unknown>) =>
    CriterionSchema.safeParse({
      id: "c",
      description: "d",
      method: "deterministic",
      deterministic_check: check,
      deterministic_check_params: params,
    });
  const messages = (r: ReturnType<typeof criterion>) =>
    r.success ? [] : r.error.issues.map((i) => i.message);

  it("accepts well-formed structured checks", () => {
    expect(criterion("json_path", { path: "$.status", equals: "ok" }).success).toBe(true);
    expect(
      criterion("json_path", { path: "$.x", file: "out/receipt.json", exists: true }).success,
    ).toBe(true);
    expect(criterion("schema_valid", { schema: SCHEMA }).success).toBe(true);
    expect(
      criterion("file_sha256", { path: "report.pdf", sha256: `sha256:${PDF_SHA}` }).success,
    ).toBe(true);
  });

  it("rejects exit_code on a skill eval criterion", () => {
    expect(messages(criterion("exit_code", { equals: 0 }))).toEqual([
      "exit_code applies to command runs graded by `j-rig grade`; a skill eval case has no process exit code",
    ]);
  });

  it("rejects bad paths, modes, regexes, digests and schemas before any spend", () => {
    expect(messages(criterion("json_path", { path: "$.a[*]", exists: true }))[0]).toMatch(
      /invalid JSONPath/,
    );
    expect(messages(criterion("json_path", { path: "$.a", exists: true, equals: 1 }))).toContain(
      "json_path: exactly one of `exists`, `equals` or `matches` is required",
    );
    expect(messages(criterion("json_path", { path: "$.a" }))).toContain(
      "json_path: exactly one of `exists`, `equals` or `matches` is required",
    );
    expect(messages(criterion("json_path", { path: "$.a", matches: "(" }))[0]).toMatch(
      /not a valid regular expression/,
    );
    expect(
      messages(criterion("json_path", { path: "$.a", exists: true, file: "../x" }))[0],
    ).toMatch(/workspace-relative/);
    expect(messages(criterion("file_sha256", { path: "a", sha256: "ABC" }))[0]).toMatch(
      /64 lowercase hex/,
    );
    expect(
      messages(criterion("schema_valid", { schema: { type: "object", requird: ["a"] } }))[0],
    ).toMatch(/not a valid draft 2020-12 JSON Schema: strict mode: unknown keyword: "requird"/);
    expect(
      messages(
        criterion("schema_valid", {
          schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
        }),
      )[0],
    ).toMatch(/draft 2020-12 is pinned/);
    expect(
      messages(criterion("schema_valid", { schema: { $ref: "https://example.com/s.json" } }))[0],
    ).toMatch(/can't resolve reference/);
    expect(structuredCheckParamIssues("exit_code", { equals: 0, extra: 1 })[0]).toMatch(
      /Unrecognized key/,
    );
  });
});

describe("files produced by the claude-code provider", () => {
  const trajectory: Trajectory = {
    schema: "j-rig/trajectory/v1",
    source: "claude-code",
    steps: [{ index: 0, tool: "Write", input_summary: "out/receipt.json" }],
    files: [
      {
        path: "out/receipt.json",
        sha256: "c".repeat(64),
        size_bytes: RECEIPT.length,
        change: "created",
      },
      { path: "report.pdf", sha256: PDF_SHA, size_bytes: 9000, change: "created" },
    ],
    turns: 2,
    stop: "completed",
  };
  const outcome = (t: Trajectory): ObservedOutcome => ({
    test_case_id: "tc",
    prompt: "render it",
    output: {
      text: "Rendered.",
      tool_calls: 1,
      trajectory: t,
      artifacts: [
        {
          filename: "out/receipt.json",
          content: RECEIPT,
          type: "text",
          size_bytes: RECEIPT.length,
        },
        { filename: "report.pdf", content: "", type: "binary_ref", size_bytes: 9000 },
      ],
    },
    meta: { started_at: "t", completed_at: "t", duration_ms: 1, timed_out: false },
    status: "completed",
  });

  it("grades a produced JSON file, its schema and a binary file's hash", async () => {
    const criteria = [
      {
        id: "status-ok",
        check: "json_path",
        params: { path: "$.status", equals: "ok", file: "out/receipt.json" },
      },
      {
        id: "receipt-valid",
        check: "schema_valid",
        params: { schema: SCHEMA, file: "out/receipt.json" },
      },
      { id: "pdf-hash", check: "file_sha256", params: { path: "report.pdf", sha256: PDF_SHA } },
      {
        id: "pdf-not-json",
        check: "json_path",
        params: { path: "$.a", exists: true, file: "report.pdf" },
      },
    ].map((c) =>
      CriterionSchema.parse({
        id: c.id,
        description: c.id,
        method: "deterministic",
        deterministic_check: c.check,
        deterministic_check_params: c.params,
      }),
    );
    const results = await judgeCriteria(criteria, outcome(trajectory), {
      judge: async () => {
        throw new Error("deterministic criteria never reach the judge");
      },
    });
    expect(results.map((r) => [r.criterion_id, r.verdict])).toEqual([
      ["status-ok", "yes"],
      ["receipt-valid", "yes"],
      ["pdf-hash", "yes"],
      ["pdf-not-json", "no"],
    ]);
    expect(results[3]!.reasoning).toMatch(/content of "report.pdf" was not captured/);
  });

  it("refuses file checks on a truncated trajectory", () => {
    const input = structuredInputFromOutput(outcome({ ...trajectory, stop: "max_turns" }).output);
    expect(
      runStructuredCheck("file_sha256", input, { path: "report.pdf", sha256: PDF_SHA }),
    ).toEqual({
      passed: false,
      message: `cannot check "report.pdf": the run ended with stop "max_turns", so its file manifest is truncated`,
    });
  });

  it("refuses file checks when the provider records no trajectory", () => {
    const o = outcome(trajectory);
    delete o.output.trajectory;
    const r = runStructuredCheck("json_path", structuredInputFromOutput(o.output), {
      path: "$.status",
      exists: true,
      file: "out/receipt.json",
    });
    expect(r.message).toMatch(/records no produced files/);
  });
});

describe("j-rig grade graders over a command Run", () => {
  const grader = (checks: unknown[]) =>
    GraderDefinitionSchema.parse({
      id: "cli-checker",
      version: "1.0.0",
      kind: "deterministic",
      checks,
    }) as DeterministicGraderDefinition;

  it("keeps the snapshot hash of an existing output_contains grader byte-identical", () => {
    const legacy = grader([
      { id: "has-answer", type: "output_contains", expected: "4" },
      { id: "has-explanation", type: "output_contains", expected: "because" },
    ]);
    // Recorded from main before the structured checks were added: an unchanged
    // grader must keep its snapshot, or every saved Grade looks stale.
    expect(hashGraderSnapshot({ ...legacy, id: "answer-checker" })).toBe(
      "sha256:2e54864e1ceaed98fb0d9d7e610949d439035d0359ca7dac0b4d5bda318e6aa7",
    );
  });

  it("grades exit code, stdout JSON and the artifact manifest", () => {
    const def = grader([
      { id: "exit-ok", type: "exit_code", equals: 0 },
      { id: "status", type: "json_path", path: "$.status", equals: "ok" },
      { id: "shape", type: "schema_valid", schema: SCHEMA },
      { id: "pdf", type: "file_sha256", path: "out/report.pdf", sha256: PDF_SHA },
      {
        id: "file-json",
        type: "json_path",
        path: "$.a",
        exists: true,
        file: "out/report.pdf",
        required: false,
      },
    ]);
    const grade = evaluateWithGrader("raw_1", RECEIPT, def, {
      exit_code: 0,
      artifacts: [{ relative_path: "out/report.pdf", sha256: `sha256:${PDF_SHA}` }],
    });
    expect(grade.checks.map((c) => [c.id, c.passed])).toEqual([
      ["exit-ok", true],
      ["status", true],
      ["shape", true],
      ["pdf", true],
      ["file-json", false],
    ]);
    expect(grade.checks[4]!.details).toMatch(/seals the artifact manifest, not file content/);
    expect(grade.verdict).toBe("pass");
    expect(grade.score).toBe(0.8);
  });

  it("fails a required structured check and the exit code without an observation", () => {
    const def = grader([{ id: "exit-ok", type: "exit_code", equals: 0 }]);
    expect(
      evaluateWithGrader("raw_1", "", def, { exit_code: 3, artifacts: [] }).checks[0],
    ).toMatchObject({
      passed: false,
      details: "exit code 3; required 0",
      expected: '{"equals":0}',
    });
    expect(evaluateWithGrader("raw_1", "", def).verdict).toBe("fail");
  });

  it("rejects malformed structured grader checks at load", () => {
    expect(
      GraderDefinitionSchema.safeParse({
        id: "g",
        version: "1",
        kind: "deterministic",
        checks: [{ id: "x", type: "json_path", path: "$..a", exists: true }],
      }).success,
    ).toBe(false);
    expect(
      GraderDefinitionSchema.safeParse({
        id: "g",
        version: "1",
        kind: "deterministic",
        checks: [{ id: "x", type: "exit_code", equals: 0, expected: "0" }],
      }).success,
    ).toBe(false);
  });
});
