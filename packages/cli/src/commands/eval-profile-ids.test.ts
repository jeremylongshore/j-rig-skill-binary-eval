import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import * as core from "@j-rig/core";
import * as storage from "../lib/db.js";
import {
  StubExecutionProvider,
  StubJudgeProvider,
  StubTriggerProvider,
} from "../providers/anthropic.js";
import { prepareEvaluationInvocation } from "./eval-runtime-context.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["criteria", "test_cases"] as const)(
  "refuses duplicate %s IDs before providers, persistence or evidence",
  async (field) => {
    vi.stubEnv("J_RIG_ALLOW_STUB", "1");
    const execute = vi.spyOn(StubExecutionProvider.prototype, "execute");
    const judge = vi.spyOn(StubJudgeProvider.prototype, "judge");
    const trigger = vi.spyOn(StubTriggerProvider.prototype, "selectSkill");
    const open = vi.spyOn(storage, "openDb");
    const started = vi.spyOn(core, "emitRuntimeRunStarted");
    const gate = vi.spyOn(core, "emitGateDecisionEmitted");
    const root = mkdtempSync(join(tmpdir(), "profile-ids-"));
    roots.push(root);
    const spec = join(root, "eval.yaml");
    const database = join(root, "eval.db");
    const bundle = join(root, "bundle.json");
    const rollout = join(root, "rollout.json");
    const criterion = { id: "blocker", description: "Must pass", method: "judge", blocker: true };
    const testCase = {
      id: "case-1",
      description: "Core",
      tier: "core",
      prompt: "Evaluate",
      criteria_ids: ["blocker"],
    };
    writeFileSync(
      spec,
      stringify({
        spec_version: "1.0",
        skill_name: "test-skill",
        description: "Admission",
        criteria:
          field === "criteria" ? [criterion, { ...criterion, blocker: false }] : [criterion],
        test_cases:
          field === "test_cases" ? [testCase, { ...testCase, criteria_ids: [] }] : [testCase],
      }),
    );
    await expect(
      prepareEvaluationInvocation(
        fileURLToPath(new URL("../../../../skill", import.meta.url)),
        {
          spec,
          db: database,
          models: "sonnet",
          provider: "stub",
          json: true,
          emitBundle: bundle,
          rolloutFile: rollout,
        },
        new Command(),
      ),
    ).rejects.toThrow(new RegExp(`${field}\\.1\\.id: duplicate`));
    expect(execute).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect([database, bundle, rollout].map(existsSync)).toEqual([false, false, false]);
  },
);
