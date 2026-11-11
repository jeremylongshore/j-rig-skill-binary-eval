import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_REFINER_PASS_V1_URI } from "@intentsolutions/core/validators/v1/skill-refiner-pass-v1";
import { registerEmitRefinerPassCommand } from "./emit-refiner-pass.js";

const UUID = "0189d4e0-1111-7abc-89ab-0123456789ab";
const HASH = `sha256:${"a".repeat(64)}`;
const RESULT_HASH = `sha256:${"b".repeat(64)}`;
let directory: string;

function record() {
  return {
    verdict: "accept",
    reason: ["significant-behavioral-improvement"],
    refiner_strategy_id: "naive-in-context",
    skill_version_id: UUID,
    parent_version_id: null,
    source_snapshot_hash: HASH,
    result_snapshot_hash: RESULT_HASH,
    eval_set_ref: { hash: HASH, version: "1.0.0", lineage_id: UUID },
    edit_proposal_hash: HASH,
    behavioral_delta: 0.12,
    named_dimension_deltas: [{ id: "readability", delta: 0.01, non_regressed: true }],
    alpha: 0.05,
    test_statistic_kind: "one-sided-z",
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "refiner-pass-command-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function invoke(raw: string, extra: string[] = []): Promise<void> {
  const input = join(directory, "record.json");
  writeFileSync(input, raw);
  const program = new Command().exitOverride();
  registerEmitRefinerPassCommand(program);
  await program.parseAsync(["emit-refiner-pass", "--input", input, ...extra], { from: "user" });
}

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map(([chunk]) => String(chunk))
    .join("");
}

function directFlags(): string[] {
  return [
    "--verdict",
    "accept",
    "--reason",
    "significant-behavioral-improvement",
    "--refiner-strategy-id",
    "naive-in-context",
    "--skill-version-id",
    UUID,
    "--source-snapshot-hash",
    HASH,
    "--result-snapshot-hash",
    RESULT_HASH,
    "--edit-proposal-hash",
    HASH,
    "--eval-set-hash",
    HASH,
    "--eval-set-version",
    "1.0.0",
    "--eval-set-lineage-id",
    UUID,
    "--behavioral-delta",
    "0.12",
    "--named-dimension",
    "readability:0.01:true",
  ];
}

describe("emit-refiner-pass registered command", () => {
  it("emits the exact predicate and binds the subject to its result snapshot", async () => {
    const body = record();
    await invoke(JSON.stringify(body), ["--subject-name", "reviewed-skill"]);
    expect(JSON.parse(stdout())).toEqual({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "reviewed-skill", digest: { sha256: "b".repeat(64) } }],
      predicateType: SKILL_REFINER_PASS_V1_URI,
      predicate: body,
    });
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it("emits only the canonical predicate without a second statement", async () => {
    const reversedInput = Object.fromEntries(Object.entries(record()).reverse());
    await invoke(JSON.stringify(reversedInput), ["--predicate-body-only"]);
    expect(stdout()).toBe(`${JSON.stringify(record())}\n`);
    expect(process.stdout.write).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("creates nested output directories and reserves stderr for the file receipt", async () => {
    const output = join(directory, "nested", "body.json");
    await invoke(JSON.stringify(record()), ["--predicate-body-only", "--output", output]);
    expect(readFileSync(output, "utf8")).toBe(`${JSON.stringify(record())}\n`);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      `emit-refiner-pass: wrote ${output}\n`,
    );
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([
    ["", "no input received"],
    ["{", "input is not valid JSON"],
    ["null", "must be a JSON object"],
    ["[]", "must be a JSON object"],
    ["{}", "failed kernel validation"],
  ])("refuses invalid input %j before any output", async (raw, message) => {
    await invoke(raw);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("refuses unknown keys instead of dropping a misspelled determinant", async () => {
    await invoke(JSON.stringify({ ...record(), skill_ver_id: UUID }));
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("unrecognized field(s): skill_ver_id"),
    );
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("refuses an accepted verdict containing a regressed named dimension", async () => {
    const body = record();
    body.named_dimension_deltas[0]!.non_regressed = false;
    await invoke(JSON.stringify(body));
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("failed kernel validation"),
    );
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("normalizes camel-case determinants and optional provenance", async () => {
    const body = {
      ...record(),
      cost_record_ref: UUID,
      replay_fidelity_level: "RF-0",
      signing_downgrade_reason: "local-key-unavailable",
    };
    const camel = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    );
    await invoke(JSON.stringify(camel), ["--predicate-body-only"]);
    expect(JSON.parse(stdout())).toEqual(body);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("preserves explicit snake-case null over a conflicting camel-case parent", async () => {
    await invoke(JSON.stringify({ ...record(), parentVersionId: UUID }), ["--predicate-body-only"]);
    expect(JSON.parse(stdout())).toEqual(record());
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("supplies the sole supported statistic when the input omits it", async () => {
    const body: Record<string, unknown> = record();
    delete body.test_statistic_kind;
    await invoke(JSON.stringify(body), ["--predicate-body-only"]);
    expect(JSON.parse(stdout())).toEqual(record());
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("prefers complete direct flags to malformed pipeline input and applies defaults", async () => {
    await invoke("{", [...directFlags(), "--predicate-body-only"]);
    expect(JSON.parse(stdout())).toEqual(record());
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it("retains explicitly supplied direct provenance and parent identity", async () => {
    await invoke("", [
      ...directFlags(),
      "--parent-version-id",
      UUID,
      "--alpha",
      "0.1",
      "--test-statistic-kind",
      "one-sided-z",
      "--cost-record-ref",
      UUID,
      "--replay-fidelity-level",
      "RF-0",
      "--signing-downgrade-reason",
      "local-key-unavailable",
      "--predicate-body-only",
    ]);
    expect(JSON.parse(stdout())).toEqual({
      ...record(),
      parent_version_id: UUID,
      alpha: 0.1,
      cost_record_ref: UUID,
      replay_fidelity_level: "RF-0",
      signing_downgrade_reason: "local-key-unavailable",
    });
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([
    ["--behavioral-delta", "unknown", "must be a number"],
    ["--named-dimension", "readability", "must be 'id:delta:non_regressed'"],
    ["--named-dimension", "readability:unknown:true", "delta must be a number"],
    ["--named-dimension", "readability:0.1:maybe", "must be 'true' or 'false'"],
  ])("refuses malformed direct value %s=%s", async (flag, value, message) => {
    await invoke("", [...directFlags(), flag, value]);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not fill missing direct determinants from otherwise valid pipeline input", async () => {
    await invoke(JSON.stringify(record()), ["--verdict", "accept"]);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("failed kernel validation"),
    );
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
