import { describe, it, expect } from "vitest";
import { bootstrap } from "./bootstrap.js";
import { makeSkillDoc } from "./apply.js";

const DOC_TEXT = `---
name: demo
description: a demo skill
---

# Demo Skill

Use this skill to validate and normalize input.
Always check the schema before processing.
- Reject malformed payloads with a clear error.
- Log every rejection for the audit trail.

\`\`\`bash
echo skip-fence-lines
\`\`\`

short
`;

describe("bootstrap", () => {
  it("is deterministic: same text + opts → identical EvalSet (incl. hash)", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const a = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    const b = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    expect(a).toEqual(b);
    expect(a.hash).toBe(b.hash);
  });

  it("extracts behavioral probes from body lines, skipping frontmatter/headings/fences/short lines", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    const prompts = set.items.map((i) => i.prompt);
    expect(prompts).toContain("Use this skill to validate and normalize input.");
    expect(prompts).toContain("Reject malformed payloads with a clear error.");
    // headings, fence markers, frontmatter, and the too-short "short" are excluded
    expect(prompts).not.toContain("# Demo Skill");
    expect(prompts).not.toContain("name: demo");
    expect(prompts).not.toContain("short");
    expect(prompts.some((p) => p.startsWith("```"))).toBe(false);
  });

  it("strips bullet/number markers from probe text", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    expect(set.items.every((i) => !/^[-*+]\s/.test(i.prompt))).toBe(true);
  });

  it("assigns stable, zero-padded synthetic item ids", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    expect(set.items[0].id).toBe("demo-syn-001");
  });

  it("populates the DR-028 versioning fields (eval_set_version, lineage_parent, refresh_due_at)", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    expect(set.evalSetVersion).toBe("1.0.0");
    expect(set.lineageParent).toBeNull();
    // 90 days after now
    expect(set.refreshDueAt).toBe("2026-09-15T00:00:00.000Z");
    expect(set.source).toBe("synthetic");
  });

  it("honors an explicit version + lineage parent", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, {
      evalSetVersion: "2.1.0",
      lineageParent: "a".repeat(64),
      now: "2026-06-17T00:00:00.000Z",
    });
    expect(set.evalSetVersion).toBe("2.1.0");
    expect(set.lineageParent).toBe("a".repeat(64));
  });

  it("--quick mode skips refresh-due-at but keeps version + lineage", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    const set = bootstrap(doc, { quick: true });
    expect(set.refreshDueAt).toBeNull();
    expect(set.evalSetVersion).toBe("1.0.0");
  });

  it("rejects an invalid 'now' timestamp", () => {
    const doc = makeSkillDoc("demo", DOC_TEXT);
    expect(() => bootstrap(doc, { now: "not-a-date" })).toThrow(/rfc3339/);
  });
});
