import { describe, it, expect } from "vitest";
import { parseAgentsMd } from "./agents-md-parser.js";

describe("parseAgentsMd — minimal cases", () => {
  it("returns empty structure for an empty document", () => {
    const r = parseAgentsMd("");
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.title).toBe("");
      expect(r.data.sections).toHaveLength(0);
      expect(r.data.tools).toHaveLength(0);
      expect(r.data.capabilities).toHaveLength(0);
      expect(r.data.constraints).toHaveLength(0);
      expect(r.data.commands).toEqual({});
      expect(r.data.frontmatter).toEqual({});
    }
  });

  it("extracts the first H1 as title (ignores subsequent H1s)", () => {
    const md = "# First Title\n\nbody\n\n# Second Title\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe("First Title");
  });

  it("returns parse error on broken frontmatter", () => {
    const md = "---\n: invalid yaml :\n   bad: indent\n---\n# Title\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(false);
  });

  it("is deterministic for broken frontmatter across repeated calls", () => {
    // Regression: gray-matter caches by input string; an input that throws on
    // the first call must NOT report success on a second identical call.
    const md = "---\n: : not yaml :\n---\n# x\n";
    const first = parseAgentsMd(md);
    const second = parseAgentsMd(md);
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
  });

  it("preserves frontmatter when present", () => {
    const md = "---\nname: my-project\nversion: 1.0\n---\n# Title\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.frontmatter.name).toBe("my-project");
      expect(r.data.frontmatter.version).toBe(1);
    }
  });
});

describe("parseAgentsMd — section extraction", () => {
  const md = `# Project

## Setup
Install deps.

\`\`\`bash
pnpm install
\`\`\`

## Build
\`\`\`bash
pnpm run build
\`\`\`

### Sub-section
content under H3

## Tools
- ripgrep
- jq
- python3

## Constraints
- never push to main
- never delete fixtures
`;

  it("extracts H2 + H3 sections in document order", () => {
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      const headings = r.data.sections.map((s) => s.heading);
      expect(headings).toEqual(["Setup", "Build", "Sub-section", "Tools", "Constraints"]);
      const levels = r.data.sections.map((s) => s.level);
      expect(levels).toEqual([2, 2, 3, 2, 2]);
    }
  });

  it("captures section bodies up to the next heading", () => {
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      const setupSec = r.data.sections.find((s) => s.heading === "Setup");
      expect(setupSec?.content).toContain("Install deps.");
      expect(setupSec?.content).toContain("pnpm install");
      expect(setupSec?.content).not.toContain("pnpm run build"); // belongs to next section
    }
  });
});

describe("parseAgentsMd — command extraction", () => {
  const md = `# Project

## Setup
\`\`\`bash
pnpm install
# this is a comment, should be skipped
$ npx setup
\`\`\`

## Build
\`\`\`
pnpm run build
\`\`\`

## Test
\`\`\`sh
pnpm run test
pnpm run test:watch
\`\`\`

## Code style
\`\`\`bash
pnpm run lint
\`\`\`

## Random non-shell block
\`\`\`typescript
const x = 1;
\`\`\`
`;

  it("extracts shell commands from semantic sections, by kind", () => {
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.commands.setup).toEqual(["pnpm install", "npx setup"]);
      expect(r.data.commands.build).toEqual(["pnpm run build"]); // empty info string still shell-ish
      expect(r.data.commands.test).toEqual(["pnpm run test", "pnpm run test:watch"]);
      expect(r.data.commands.style).toEqual(["pnpm run lint"]);
    }
  });

  it("ignores typescript and other non-shell code blocks", () => {
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      // The "## Random non-shell block" exists as a section but no kind-regex
      // matches it, so commands map has no entry for it (and no false positive
      // from the typescript block).
      expect(r.data.commands).not.toHaveProperty("typescript");
    }
  });

  it("strips comment lines and shell prompts", () => {
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.commands.setup).not.toContain("# this is a comment, should be skipped");
      expect(r.data.commands.setup).not.toContain("# this is a comment");
      expect(r.data.commands.setup).toContain("npx setup"); // $ stripped
    }
  });

  it("matches Test / Testing / Tests case-insensitively", () => {
    const md2 = "## Testing instructions\n\n```bash\nnpm test\n```\n";
    const r = parseAgentsMd(md2);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.commands.test).toEqual(["npm test"]);
  });
});

describe("parseAgentsMd — bullet extraction", () => {
  it("extracts top-level bullets from Tools section", () => {
    const md = "## Tools\n- ripgrep\n- jq\n- python3\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tools).toEqual(["ripgrep", "jq", "python3"]);
  });

  it("extracts bullets from Capabilities/Behaviors sections", () => {
    const md = "## Capabilities\n- can edit files\n* can run tests\n+ can open PRs\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capabilities).toEqual(["can edit files", "can run tests", "can open PRs"]);
    }
  });

  it("extracts bullets from Constraints/Don'ts sections", () => {
    const md = "## Don'ts\n- never push to main\n- never skip tests\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.constraints).toEqual(["never push to main", "never skip tests"]);
    }
  });

  it("merges bullets from multiple matching sections", () => {
    const md = "## Tools\n- a\n\n## Capabilities\n- b\n\n## Behaviors\n- c\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tools).toContain("a");
      // Capabilities + Behaviors both flow into capabilities[]
      expect(r.data.capabilities).toEqual(["b", "c"]);
    }
  });

  it("ignores nested bullets (only top-level)", () => {
    const md = "## Tools\n- top-level\n  - nested\n- another top-level\n";
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tools).toEqual(["top-level", "another top-level"]);
    }
  });
});

describe("parseAgentsMd — fenced code block protection", () => {
  it("does NOT treat ## headings inside code blocks as section starts", () => {
    const md = `# Project

## Build
\`\`\`bash
echo "## Not a heading"
echo "## Still inside the fence"
\`\`\`

## Test
\`\`\`bash
pnpm test
\`\`\`
`;
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      const headings = r.data.sections.map((s) => s.heading);
      expect(headings).toEqual(["Build", "Test"]);
      expect(r.data.commands.build).toContain('echo "## Not a heading"');
    }
  });
});

describe("parseAgentsMd — realistic full document", () => {
  it("parses a full AGENTS.md and exposes all extractors", () => {
    const md = `---
name: example-project
maintainer: Jeremy Longshore
---
# Example Project

This file tells AI agents how to operate this repo.

## Setup
Install dependencies before any other operation.

\`\`\`bash
pnpm install
cp .env.example .env
\`\`\`

## Build
\`\`\`bash
pnpm run build
\`\`\`

## Testing
Run the full check before committing:

\`\`\`bash
pnpm run check
\`\`\`

## Tools
- pnpm
- node 20+
- python 3.12

## Constraints
- never commit secrets
- never disable a test to make CI green

## Code style
We use Prettier + ESLint flat config.

\`\`\`bash
pnpm run format
pnpm run lint
\`\`\`
`;
    const r = parseAgentsMd(md);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.frontmatter.name).toBe("example-project");
      expect(r.data.title).toBe("Example Project");
      expect(r.data.commands.setup).toEqual(["pnpm install", "cp .env.example .env"]);
      expect(r.data.commands.build).toEqual(["pnpm run build"]);
      expect(r.data.commands.test).toEqual(["pnpm run check"]);
      expect(r.data.commands.style).toEqual(["pnpm run format", "pnpm run lint"]);
      expect(r.data.tools).toEqual(["pnpm", "node 20+", "python 3.12"]);
      expect(r.data.constraints).toEqual([
        "never commit secrets",
        "never disable a test to make CI green",
      ]);
    }
  });
});
