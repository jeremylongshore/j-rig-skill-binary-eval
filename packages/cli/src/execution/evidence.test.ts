import { describe, expect, it } from "vitest";
import type { ObservedOutcome } from "@j-rig/core";
import { getJudgeObservations } from "./evidence.js";

function outcome(): ObservedOutcome {
  const session_id = "847753e4-d988-49fa-b739-886b2b7c53b9";
  const data = {
    schema: "jrig-tool-observations/v1",
    session_id,
    redaction: "known-environment-credentials-and-credential-fields/v1",
    calls: [
      {
        id: "a",
        tool: "host__save",
        arguments: { draft: "exact draft" },
        status: "completed",
        result: '{"saved":true,"run_id":"actual-id"}',
      },
    ],
  };
  return {
    test_case_id: "case",
    prompt: "user prompt",
    status: "completed",
    output: {
      text: "model claims invented-id",
      tool_calls: 1,
      artifacts: [
        {
          filename: "tool-session.json",
          type: "text",
          content: JSON.stringify({ schema: "jrig-tool-session/v1", session_id }),
          size_bytes: 0,
        },
        {
          filename: "tool-observations.json",
          type: "text",
          content: JSON.stringify(data),
          size_bytes: Buffer.byteLength(JSON.stringify(data)),
        },
      ],
    },
    meta: { started_at: "", completed_at: "", duration_ms: 0, timed_out: false },
  };
}
describe("judge observation extraction", () => {
  it("requires explicit opt-in and excludes model claims", () => {
    const result = outcome();
    expect(getJudgeObservations(result, false, 10000)).toBeUndefined();
    expect(getJudgeObservations(result, true, 10000)).toBe(result.output.artifacts[1]!.content);
    expect(getJudgeObservations(result, true, 10000)).not.toContain("invented-id");
    result.status = "failed";
    expect(getJudgeObservations(result, true, 10000)).toBeUndefined();
  });
  it.each(["size", "session", "duplicate", "missing", "partial", "count", "limit"])(
    "refuses %s corruption instead of judging unbound data",
    (failure) => {
      const result = outcome();
      const record = result.output.artifacts[1]!;
      if (failure === "size") record.size_bytes++;
      if (failure === "session")
        result.output.artifacts[0]!.content = JSON.stringify({
          schema: "jrig-tool-session/v1",
          session_id: "another-session",
        });
      if (failure === "duplicate") result.output.artifacts.push(record);
      if (failure === "missing") result.output.artifacts = [];
      if (failure === "partial") {
        record.content = record.content.replace('"completed"', '"started"');
        record.size_bytes = Buffer.byteLength(record.content);
      }
      if (failure === "count") result.output.tool_calls++;
      expect(() => getJudgeObservations(result, true, failure === "limit" ? 1 : 10000)).toThrow();
    },
  );
});
