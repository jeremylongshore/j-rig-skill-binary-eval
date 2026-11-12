import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Exercise the actual reviewed workflow receipt code, not a copied implementation.
const workflow = readFileSync(
  new URL("../../../.github/workflows/nightly-skill-evals.yml", import.meta.url),
  "utf8",
);
const extracted = workflow.match(
  /- name: Record migration artifact provenance[\s\S]*?python3 - <<'PYTHON'\n([\s\S]*?) {10}PYTHON/,
);
assert.ok(extracted, "migration receipt step must remain wired");
const script = extracted[1]!
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");

for (const [outcome, payload, signed, expected] of [
  ["success", true, true, "complete"],
  ["failure", true, true, "incomplete"],
  ["skipped", true, true, "incomplete"],
  ["success", true, false, "incomplete"],
  ["success", false, false, "incomplete"],
] as const) {
  test(`migration provenance: ${outcome}, payload=${payload}, signed=${signed}`, () => {
    const root = mkdtempSync(join(tmpdir(), "synthetic-migration-provenance-"));
    try {
      const dir = join(root, "build/evidence");
      mkdirSync(dir, { recursive: true });
      if (payload) writeFileSync(join(dir, "evidence-payload-0.json"), "[]");
      if (signed) writeFileSync(join(dir, "evidence-payload-0.signed-rows.json"), "{}");
      const result = spawnSync("python3", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SIGNING_OUTCOME: outcome,
          GITHUB_REPOSITORY: "synthetic/repo",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_WORKFLOW_REF: "synthetic/repo/.github/workflows/test.yml@refs/heads/main",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(readFileSync(join(dir, "signed-row-provenance.json"), "utf8"));
      assert.equal(receipt.state, expected);
      assert.equal(receipt.signing_step_outcome, outcome);
      assert.equal(receipt.files.length, Number(payload) + Number(signed));
      if (payload)
        assert.equal(
          receipt.files[0].sha256,
          "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
