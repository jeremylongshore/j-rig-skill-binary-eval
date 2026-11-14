import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildGraderSnapshot } from "./eval-grader-snapshot.js";

// Captured by evaluating the original inline snapshot expression at ca99c93.
const fixtures = [
  {
    name: "defaults",
    input:
      '{"executionMetadata":{},"scoringCriteria":[],"providers":{"judgeProviderName":"fixture","judgeModelId":"judge"},"spec":{}}',
    expected:
      '{"schema":"j-rig/binary-criteria-grader/v1","criteria":[],"judge":{"provider":"fixture","model":"judge","samples":1,"temperature":0,"timeout_ms":120000,"sample_concurrency":1},"stability":{"min_blocker_agreement":null}}',
    sha256: "2744d731bf634fc56fcce2ee74cc277ebd11f6f7aabe241fea0c0d198300effe",
  },
  {
    name: "explicit zeros",
    input:
      '{"executionMetadata":{},"scoringCriteria":[],"providers":{"judgeProviderName":"fixture","judgeModelId":"judge"},"spec":{"judge_temperature":0,"judge_timeout_ms":0,"judge_sample_concurrency":0,"min_blocker_agreement":0},"judgeSamples":0}',
    expected:
      '{"schema":"j-rig/binary-criteria-grader/v1","criteria":[],"judge":{"provider":"fixture","model":"judge","samples":0,"temperature":0,"timeout_ms":0,"sample_concurrency":0},"stability":{"min_blocker_agreement":0}}',
    sha256: "d6a3b106432a7355ab7fed40f45d1306f7cb6913cc3e798d1778cc725ff2cc9d",
  },
  {
    name: "sample fallback and disabled observations",
    input:
      '{"executionMetadata":{},"scoringCriteria":[],"providers":{"judgeProviderName":"fixture","judgeModelId":"judge"},"spec":{"judge_temperature":0.4},"judgeSamples":3,"toolConfig":{"fingerprint":"ignored","runtime":{}}}',
    expected:
      '{"schema":"j-rig/binary-criteria-grader/v1","criteria":[],"judge":{"provider":"fixture","model":"judge","samples":3,"temperature":0.4,"timeout_ms":120000,"sample_concurrency":3},"stability":{"min_blocker_agreement":null}}',
    sha256: "2392937f564bc2eda40f6ae374a3ffdb8722e173133c85db03fdbeb0b28113a1",
  },
  {
    name: "enabled observations and metadata",
    input:
      '{"executionMetadata":{"execution_parameters":{"reasoning_effort":"low"},"execution_provider":"fixture"},"scoringCriteria":[],"providers":{"judgeProviderName":"fixture","judgeModelId":"judge"},"spec":{"judge_temperature":0.2,"judge_timeout_ms":123,"judge_sample_concurrency":2,"min_blocker_agreement":0.8},"toolConfig":{"fingerprint":"sha256:fixture","runtime":{"judgeObservations":{}}},"judgeSamples":5}',
    expected:
      '{"schema":"j-rig/binary-criteria-grader/v1","execution_parameters":{"reasoning_effort":"low"},"execution_provider":"fixture","tool_observations":"jrig-tool-observations/v1","mcp_configuration_sha256":"sha256:fixture","criteria":[],"judge":{"provider":"fixture","model":"judge","samples":5,"temperature":0.2,"timeout_ms":123,"sample_concurrency":2},"stability":{"min_blocker_agreement":0.8}}',
    sha256: "6831961b53a97fddbf240369991524d6a91d6c5fa44b8328f82046447a7d2041",
  },
];

it.each(fixtures)("preserves snapshot bytes: $name", ({ input, expected, sha256 }) => {
  const actual = JSON.stringify(buildGraderSnapshot(JSON.parse(input)));
  expect(actual).toBe(expected);
  expect(createHash("sha256").update(actual).digest("hex")).toBe(sha256);
});

it("binds explicit pacing policy to grader identity without changing default snapshots", () => {
  const base = JSON.parse(fixtures[0]!.input) as Parameters<typeof buildGraderSnapshot>[0];
  const snapshot = (rpm: number) =>
    buildGraderSnapshot({
      ...base,
      executionMetadata: {
        request_pacing: {
          schema: "j-rig/request-pacing/v1",
          requests_per_minute: rpm,
          minimum_start_interval_ms: Math.ceil(60000 / rpm),
          scope: "invocation-selected-judge-endpoints-all-completions",
        },
      },
    });
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  expect(digest(snapshot(30))).not.toBe(digest(snapshot(60)));
  expect(digest(snapshot(30))).not.toBe(digest(buildGraderSnapshot(base)));
  expect(snapshot(30)).toMatchObject({ request_pacing: { requests_per_minute: 30 } });
});
