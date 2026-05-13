/**
 * AGENTS.md parser — structured view of a project's agent-instruction file.
 *
 * AGENTS.md is the open agent-tooling convention (OpenAI Codex CLI / Cursor /
 * Anthropic Claude Code interop) that ships in a repository's root and tells
 * automation agents how the project expects to be operated. Common sections:
 *
 *   ## Setup commands
 *   ## Build / Test / Lint
 *   ## Code style
 *   ## PR instructions
 *   ## Project overview
 *   ## Tools
 *   ## Constraints / Don'ts
 *
 * No formal spec pins the section names; the parser MUST tolerate variation.
 *
 * What this parser extracts (for downstream j-rig consumption):
 *
 *   1. Optional YAML frontmatter (some projects add one; many don't)
 *   2. The first H1 (title)
 *   3. All H2 sections with body content + nested H3 subsections
 *   4. Command extractions from semantically-named sections (build / test /
 *      setup / lint / style) — fenced code blocks inside those sections
 *      become `commands.{kind}: string[]`. Heuristic: any code block whose
 *      info string is bash / sh / shell / zsh, OR has no info string,
 *      counts as a command block.
 *   5. Bullet-list extractions from "tools" / "capabilities" / "constraints"
 *      sections — top-level bullets become `tools[]` / `capabilities[]` /
 *      `constraints[]`.
 *
 * The output is a stable structured shape; downstream code (j-rig eval
 * harness, MM-N implementations) decides what to do with it.
 */
import matter from "gray-matter";
import type { ParseError, ParseResult } from "./yaml-parser.js";

/** Canonical command-kind tags. Sections matched by case-insensitive regex. */
export type CommandKind = "build" | "test" | "lint" | "setup" | "style" | "format";

const COMMAND_HEADING_REGEXES: Record<CommandKind, RegExp> = {
  build: /\bbuild\b/i,
  test: /\btest(s|ing)?\b/i,
  lint: /\blint(ing|er)?\b/i,
  setup: /\b(setup|install|bootstrap|getting started)\b/i,
  style: /\b(code\s*style|conventions?)\b/i,
  format: /\b(format|formatter|formatting|prettier)\b/i,
};

const TOOL_HEADING_RE = /\btools?\b|\bcapabilit(y|ies)\b/i;
const CAPABILITY_HEADING_RE = /\bcapabilit(y|ies)\b|\bbehaviors?\b|\babilit(y|ies)\b/i;
const CONSTRAINT_HEADING_RE = /\bconstraints?\b|\bdon'?ts?\b|\bmust\s*not\b|\bguardrails?\b/i;

export interface ParsedAgentsMd {
  /** YAML frontmatter, if any. Empty object when no frontmatter present. */
  frontmatter: Record<string, unknown>;
  /** First H1 in the document. Empty string if none. */
  title: string;
  /** All H2 sections in document order. */
  sections: AgentSection[];
  /** Commands extracted from semantically-named sections, by kind. */
  commands: Partial<Record<CommandKind, string[]>>;
  /** Top-level bullets from any Tools / Capabilities heading. */
  tools: string[];
  /** Top-level bullets from any Capabilities / Behaviors heading. */
  capabilities: string[];
  /** Top-level bullets from any Constraints / Don'ts heading. */
  constraints: string[];
  /** Raw markdown body (frontmatter stripped). */
  body: string;
}

export interface AgentSection {
  /** Heading text (without the leading `## `). */
  heading: string;
  /** Heading level (2 or 3 — H1 is the document title). */
  level: 2 | 3;
  /** Markdown body of this section, up to the next heading of equal-or-higher level. */
  content: string;
}

/**
 * Parse an AGENTS.md document.
 *
 * The parser is permissive: missing frontmatter is fine, missing sections are
 * fine, unknown sections are preserved verbatim. The only failure mode is a
 * syntactically broken frontmatter block (which gray-matter throws on).
 */
export function parseAgentsMd(content: string): ParseResult<ParsedAgentsMd> {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    const errors: ParseError[] = [
      {
        path: "",
        message: `Failed to parse AGENTS.md frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
    return { success: false, errors };
  }

  const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
  const body = parsed.content;

  const title = extractTitle(body);
  const sections = extractSections(body);

  const commands: Partial<Record<CommandKind, string[]>> = {};
  for (const kind of Object.keys(COMMAND_HEADING_REGEXES) as CommandKind[]) {
    const cmds = extractCommandsForKind(sections, kind);
    if (cmds.length > 0) commands[kind] = cmds;
  }

  const tools = extractBulletsForHeading(sections, TOOL_HEADING_RE);
  const capabilities = extractBulletsForHeading(sections, CAPABILITY_HEADING_RE);
  const constraints = extractBulletsForHeading(sections, CONSTRAINT_HEADING_RE);

  return {
    success: true,
    data: { frontmatter, title, sections, commands, tools, capabilities, constraints, body },
  };
}

/** First H1 in the body, or "" if none. Stops at first newline. */
function extractTitle(body: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

/**
 * Extract H2 + H3 sections from a markdown body. Each section's content runs
 * from the line after its heading to the line before the next heading of
 * equal-or-higher level (or EOF).
 */
function extractSections(body: string): AgentSection[] {
  const lines = body.split(/\r?\n/);
  const sections: AgentSection[] = [];
  let current: { heading: string; level: 2 | 3; startLine: number } | null = null;

  // We protect against fenced code blocks containing `## ` lines.
  let inFence = false;
  let fenceMarker = "";

  const flush = (endLineExclusive: number): void => {
    if (current === null) return;
    const content = lines.slice(current.startLine + 1, endLineExclusive).join("\n").trim();
    sections.push({ heading: current.heading, level: current.level, content });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^```+(\S*)\s*$/);
    if (fenceMatch) {
      const marker = fenceMatch[0].match(/^`+/)![0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h2) {
      flush(i);
      current = { heading: h2[1].trim(), level: 2, startLine: i };
    } else if (h3) {
      flush(i);
      current = { heading: h3[1].trim(), level: 3, startLine: i };
    }
  }
  flush(lines.length);
  return sections;
}

/**
 * Pull command lines out of any section whose heading matches the given kind.
 * "Command lines" = non-empty, non-comment lines inside any fenced code block
 * whose info string is shell-ish (bash / sh / shell / zsh / "" for ambiguous).
 * Comments (lines starting with `#`) and prompts (`$ `, `> `) are stripped.
 */
function extractCommandsForKind(sections: AgentSection[], kind: CommandKind): string[] {
  const re = COMMAND_HEADING_REGEXES[kind];
  const matches = sections.filter((s) => re.test(s.heading));
  const cmds: string[] = [];
  for (const sec of matches) {
    cmds.push(...extractShellCommandsFromBlock(sec.content));
  }
  return cmds;
}

const SHELL_INFO_STRINGS = new Set(["", "bash", "sh", "shell", "zsh", "console"]);

/** Pull command lines out of fenced shell code blocks in a markdown chunk. */
function extractShellCommandsFromBlock(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const cmds: string[] = [];
  let inShellBlock = false;
  let currentMarker = "";
  for (const line of lines) {
    const fenceMatch = line.match(/^```+(\S*)\s*$/);
    if (fenceMatch) {
      const marker = fenceMatch[0].match(/^`+/)![0];
      if (!inShellBlock) {
        const info = (fenceMatch[1] ?? "").toLowerCase();
        if (SHELL_INFO_STRINGS.has(info)) {
          inShellBlock = true;
          currentMarker = marker;
        }
      } else if (marker.length >= currentMarker.length) {
        inShellBlock = false;
        currentMarker = "";
      }
      continue;
    }
    if (!inShellBlock) continue;
    const stripped = line.replace(/^[\s]*[$>]\s+/, "").trim();
    if (!stripped) continue;
    if (stripped.startsWith("#")) continue;
    cmds.push(stripped);
  }
  return cmds;
}

/**
 * Pull top-level bullets (- foo / * foo / + foo) out of any section whose
 * heading matches the regex. Returns the bullet text with the marker stripped.
 */
function extractBulletsForHeading(sections: AgentSection[], headingRe: RegExp): string[] {
  const matches = sections.filter((s) => headingRe.test(s.heading));
  const out: string[] = [];
  for (const sec of matches) {
    for (const line of sec.content.split(/\r?\n/)) {
      const m = line.match(/^[-*+]\s+(.+?)\s*$/);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}
