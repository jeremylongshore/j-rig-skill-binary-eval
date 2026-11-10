import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, snapshot, testScopes, workspaceFiles } from "./workspace-inventory.ts";

export function measureQuality(root: string, gate: "bias" | "gherkin") {
  const selected = (path: string) =>
    gate === "bias"
      ? testScopes.some(({ pattern }) => pattern.test(path))
      : path.endsWith(".feature");
  const files = workspaceFiles(root).filter(selected);
  const entries = snapshot(root, files);
  const inventory = entries.map(({ path, sha256 }) => ({ path, sha256 }));
  const gateId = `j-rig:ci:workspace-${gate}`;
  if (entries.length === 0) {
    if (gate === "bias") throw new Error("No tests discovered in the declared Vitest scopes");
    return {
      gate_id: gateId,
      result: "NOT_APPLICABLE",
      input_hash: digest(inventory),
      metadata: {
        discovered_files: 0,
        scanned_files: 0,
        inventory,
        reason: "No tracked or non-ignored Gherkin features",
      },
    };
  }
  const script = gate === "bias" ? "bias-count.sh" : "gherkin-lint.sh";
  const provider = snapshot(root, [`.audit-harness/scripts/${script}`])[0];
  const staging = mkdtempSync(join(tmpdir(), "jrig-quality-"));
  try {
    for (const { path, bytes } of entries) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const execution = spawnSync(
      "bash",
      [
        join(root, ".audit-harness/scripts", script),
        ...(gate === "gherkin" ? ["--path"] : []),
        staging,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (execution.error || execution.signal || ![0, 1].includes(execution.status ?? -1)) {
      throw new Error(`Scanner execution incomplete (exit ${execution.status})`);
    }
    const raw: unknown = JSON.parse(execution.stdout);
    if (
      !raw ||
      typeof raw !== "object" ||
      !("result" in raw) ||
      !["ADVISORY", "PASS", "FAIL"].includes(String(raw.result)) ||
      !("metadata" in raw) ||
      !raw.metadata ||
      typeof raw.metadata !== "object"
    )
      throw new Error("Invalid scanner report");
    if ((raw.result === "FAIL") !== (execution.status === 1))
      throw new Error("Scanner exit/result disagreement");
    if (gate === "bias") {
      const meta = raw.metadata as Record<string, unknown>;
      for (const key of ["test_count", "assertion_count", "bias_total"]) {
        if (!Number.isSafeInteger(meta[key]) || Number(meta[key]) < 0)
          throw new Error(`Invalid scanner ${key}`);
      }
      if (meta.test_count === 0) throw new Error("Scanner recognized no test declarations");
    } else {
      const meta = raw.metadata as Record<string, unknown>;
      for (const key of ["warnings", "errors"]) {
        if (!Number.isSafeInteger(meta[key]) || Number(meta[key]) < 0)
          throw new Error(`Invalid scanner ${key}`);
      }
    }
    const after = snapshot(root, files).map(({ path, sha256 }) => ({ path, sha256 }));
    if (
      digest(workspaceFiles(root).filter(selected)) !== digest(files) ||
      digest(after) !== digest(inventory) ||
      snapshot(root, [provider.path])[0].sha256 !== provider.sha256
    ) {
      throw new Error("Inputs changed during quality scan");
    }
    return {
      ...raw,
      gate_id: gateId,
      input_hash: digest(inventory),
      policy_hash: `sha256:${provider.sha256}`,
      metadata: {
        ...raw.metadata,
        path: "workspace inventory",
        discovered_files: entries.length,
        scanned_files: entries.length,
        inventory,
        provider: provider.path,
        counting_basis:
          "Vendored lexical heuristics; declaration counts are not executed test counts",
      },
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const gate = process.argv[2];
  try {
    if (gate !== "bias" && gate !== "gherkin") throw new Error("Expected bias or gherkin");
    const report = measureQuality(process.cwd(), gate);
    console.log(JSON.stringify(report));
    if (report.result === "FAIL") process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        gate_id: `j-rig:ci:workspace-${gate}`,
        result: "FAIL",
        failure_mode: "measurement-incomplete",
        metadata: { reason: error instanceof Error ? error.message : String(error) },
      }),
    );
    process.exitCode = 2;
  }
}
