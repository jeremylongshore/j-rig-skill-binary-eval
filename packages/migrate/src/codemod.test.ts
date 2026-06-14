import { describe, it, expect } from "vitest";
import { runCodemod, unifiedDiff, type CodemodFs } from "./codemod.js";

/** In-memory fs for driver tests — no disk IO. */
function memFs(files: Record<string, string>): CodemodFs & { files: Record<string, string> } {
  const store = { ...files };
  return {
    files: store,
    walk(dir: string): string[] {
      return Object.keys(store)
        .filter((p) => p.startsWith(dir))
        .sort();
    },
    read(path: string): string {
      return store[path];
    },
    write(path: string, content: string): void {
      store[path] = content;
    },
  };
}

const V1_ROW = JSON.stringify(
  {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "j-rig:ci:MM-1", digest: { sha256: "a".repeat(64) } }],
    predicateType: "https://evals.intentsolutions.io/gate-result/v1",
    predicate: {
      gate_id: "j-rig:ci:MM-1",
      result: "PASS",
      policy_hash: `sha256:${"c".repeat(64)}`,
      input_hash: `sha256:${"a".repeat(64)}`,
      timestamp: "2026-06-13T00:00:00.000Z",
      runner: "j-rig@2.0.0",
      commit_sha: "abc1234",
    },
  },
  null,
  2,
);

describe("runCodemod — dry run (default)", () => {
  it("reports a changed file but does NOT write by default", () => {
    const fs = memFs({ "dir/bundle.json": `[${V1_ROW}]\n` });
    const res = runCodemod("dir", fs);
    expect(res.changedCount).toBe(1);
    expect(res.files[0].changed).toBe(true);
    expect(res.files[0].written).toBe(false);
    // Original untouched.
    expect(fs.files["dir/bundle.json"]).toContain('"result": "PASS"');
    expect(fs.files["dir/bundle.json"]).not.toContain("gate_decision");
  });

  it("produces a unified diff showing the field rewrite", () => {
    const fs = memFs({ "dir/bundle.json": `[${V1_ROW}]\n` });
    const res = runCodemod("dir", fs);
    const diff = res.files[0].diff;
    expect(diff).toContain("--- a/dir/bundle.json");
    expect(diff).toContain("+++ b/dir/bundle.json");
    // Indentation depends on container nesting; assert on the trimmed line.
    const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(removed.some((l) => l.includes('"result": "PASS"'))).toBe(true);
    expect(added.some((l) => l.includes('"gate_decision": "pass"'))).toBe(true);
  });
});

describe("runCodemod — write mode", () => {
  it("writes the migrated content when write=true", () => {
    const fs = memFs({ "dir/bundle.json": `[${V1_ROW}]\n` });
    const res = runCodemod("dir", fs, { write: true });
    expect(res.files[0].written).toBe(true);
    expect(fs.files["dir/bundle.json"]).toContain('"gate_decision": "pass"');
    expect(fs.files["dir/bundle.json"]).not.toContain('"result": "PASS"');
  });

  it("preserves a trailing newline", () => {
    const fs = memFs({ "dir/bundle.json": `[${V1_ROW}]\n` });
    runCodemod("dir", fs, { write: true });
    expect(fs.files["dir/bundle.json"].endsWith("\n")).toBe(true);
  });

  it("preserves the absence of a trailing newline", () => {
    const fs = memFs({ "dir/bundle.json": `[${V1_ROW}]` });
    runCodemod("dir", fs, { write: true });
    expect(fs.files["dir/bundle.json"].endsWith("\n")).toBe(false);
  });
});

describe("runCodemod — filtering & skipping", () => {
  it("ignores non-json files by default", () => {
    const fs = memFs({ "dir/readme.md": "# not json", "dir/b.json": `[${V1_ROW}]\n` });
    const res = runCodemod("dir", fs);
    expect(res.files.map((f) => f.path)).toEqual(["dir/b.json"]);
  });

  it("honors a custom include predicate", () => {
    const fs = memFs({ "dir/a.evidence": `[${V1_ROW}]\n` });
    const res = runCodemod("dir", fs, { include: (p) => p.endsWith(".evidence") });
    expect(res.files).toHaveLength(1);
    expect(res.files[0].changed).toBe(true);
  });

  it("leaves an already-v2 file unchanged", () => {
    const v2 = JSON.stringify([{ predicate: { gate_id: "g", gate_decision: "pass" } }]);
    const fs = memFs({ "dir/v2.json": v2 });
    const res = runCodemod("dir", fs, { write: true });
    expect(res.changedCount).toBe(0);
    expect(res.files[0].changed).toBe(false);
    expect(res.files[0].written).toBe(false);
  });
});

describe("runCodemod — parse errors", () => {
  it("reports a parse error without throwing", () => {
    const fs = memFs({ "dir/broken.json": "{ not valid json" });
    const res = runCodemod("dir", fs);
    expect(res.errorCount).toBe(1);
    expect(res.files[0].parseError).not.toBeNull();
    expect(res.files[0].changed).toBe(false);
  });
});

describe("unifiedDiff", () => {
  it("marks unchanged lines with a leading space", () => {
    const diff = unifiedDiff("f", "a\nb\nc", "a\nB\nc");
    expect(diff).toContain(" a");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" c");
  });

  it("handles added trailing lines", () => {
    const diff = unifiedDiff("f", "a", "a\nb");
    expect(diff).toContain("+b");
  });

  it("handles removed trailing lines", () => {
    const diff = unifiedDiff("f", "a\nb", "a");
    expect(diff).toContain("-b");
  });
});
