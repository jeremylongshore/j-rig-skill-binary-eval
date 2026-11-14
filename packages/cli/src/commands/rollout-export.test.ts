import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRolloutExport } from "./rollout-export.js";

it("does not overwrite retained rollout evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rollout-export-"));
  try {
    const path = join(root, "source.json");
    const input = {
      skillId: "demo",
      skillHash: "hash",
      spec: {},
      status: "completed" as const,
      runs: [],
    };
    writeRolloutExport(path, input);
    const retained = readFileSync(path, "utf8");
    expect(() => writeRolloutExport(path, { ...input, status: "incomplete" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(retained);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
