import {
  GraderDefinitionSchema,
  type DeterministicGraderDefinition,
  type GraderCheck,
} from "../grading/substrate.js";
import {
  SCRIPTED_RESULTS,
  ScriptedInputSchema,
  ScriptedImportSchema,
  validateScriptedRequest,
  sha256Bytes,
} from "./scripted-evals.js";

function exactObject(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
function ordered(items: unknown[]): Record<string, unknown> {
  return {
    type: "array",
    minItems: items.length,
    maxItems: items.length,
    prefixItems: items,
    items: false,
  };
}
const literal = (value: unknown): Record<string, unknown> => ({ const: value });
function escapedSubstring(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** All identities come from the stored request; reported booleans never decide a Grade. */
export function scriptedGrader(
  importValue: unknown,
  requestValue: unknown,
): DeterministicGraderDefinition {
  const imported = ScriptedImportSchema.parse(importValue);
  const request = validateScriptedRequest(requestValue, imported);
  const input = ScriptedInputSchema.parse(request.task.input);
  const checks: GraderCheck[] = [];
  const cases = input.source.evals.map((item, caseIndex) => {
    const assertions = item.assertions.map((assertion, index) => {
      const path = `$.cases[${caseIndex}].assertions[${index}]`;
      checks.push({
        id: `case-${caseIndex}-assertion-${index}-exit`,
        type: "json_path",
        path: `${path}.exit_code`,
        equals: assertion.expect_exit,
        required: true,
      });
      if (assertion.stdout_contains !== undefined && assertion.stdout_contains !== "")
        checks.push({
          id: `case-${caseIndex}-assertion-${index}-stdout`,
          type: "json_path",
          path: `${path}.stdout`,
          matches: escapedSubstring(assertion.stdout_contains),
          required: true,
        });
      return exactObject({
        index: literal(index),
        cmd: literal(assertion.cmd),
        expect_exit: literal(assertion.expect_exit),
        ...(assertion.stdout_contains === undefined
          ? {}
          : { stdout_contains: literal(assertion.stdout_contains) }),
        exit_code: { type: "integer" },
        stdout: { type: "string" },
        duration_ms: { type: "number", minimum: 0 },
        completed: literal(true),
        passed: { type: "boolean" },
      });
    });
    return exactObject({ id: literal(item.id), assertions: ordered(assertions) });
  });
  const schema = exactObject({
    format: literal(SCRIPTED_RESULTS),
    complete: literal(true),
    run_id: literal(request.run_id),
    task_id: literal(request.task.id),
    task_version: literal(request.task.version),
    config_id: literal(request.config.id),
    config_version: literal(request.config.version),
    sample_index: literal(request.sample_index),
    source_sha256: literal(input.source_sha256),
    runner_sha256: literal(input.runner_sha256),
    fixtures: literal(input.fixtures),
    cases: ordered(cases),
  });
  const grader = GraderDefinitionSchema.parse({
    id: `scripted-results-${sha256Bytes(Buffer.from(JSON.stringify(request)))}`,
    version: "1",
    kind: "deterministic",
    description: "Authored assertion observations only; preserved prose is not graded.",
    checks: [
      { id: "authored-suite-exit", type: "exit_code", equals: 0, required: true },
      { id: "complete-bound-receipt", type: "schema_valid", schema, required: true },
      ...checks,
    ],
  });
  if (grader.kind !== "deterministic") throw new Error("expected deterministic grader");
  return grader;
}
