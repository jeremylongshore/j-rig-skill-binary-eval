import type { Reporter, TestModule } from "vitest/node";
import { relative } from "node:path";
import { readManifest, writePrivate } from "./workspace-coverage-contract.ts";
import type { ReporterReceipt } from "./workspace-coverage-contract.ts";

export default class CoverageReporter implements Reporter {
  private modules: ReporterReceipt["modules"] = [];
  onTestModuleEnd(module: TestModule) {
    const directory = process.env.JRIG_COVERAGE_STAGE;
    if (!directory) throw new Error("Missing private coverage stage");
    const { manifest } = readManifest(directory);
    this.modules.push({
      path: relative(manifest.root, module.moduleId),
      state: module.state(),
      endedAt: Date.now(),
    });
  }
  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]> = (_modules, errors, reason) => {
    const directory = process.env.JRIG_COVERAGE_STAGE;
    if (!directory) throw new Error("Missing private coverage stage");
    const { manifest, manifestHash } = readManifest(directory);
    writePrivate(directory, "reporter.json", {
      runId: manifest.runId,
      manifestHash,
      reason,
      errors: errors.length,
      modules: this.modules,
    } satisfies ReporterReceipt);
  };
}
