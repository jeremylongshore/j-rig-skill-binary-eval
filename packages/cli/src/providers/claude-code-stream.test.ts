import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeStreamParser,
  parseClaudeStream,
  relativizePaths,
  summarizeToolInput,
} from "./claude-code-stream.js";

// Recorded locally on the Claude subscription (haiku), scrubbed: the temp
// root is __ROOT__, uuids renumbered, rate-limit events dropped.
const FIXTURES = join(import.meta.dirname, "__fixtures__", "claude-code");
const load = (name: string) => readFileSync(join(FIXTURES, `${name}.stream.jsonl`), "utf8");
const WS = "__ROOT__/ws";

describe("parseClaudeStream — recorded write-receipt run (skill installed)", () => {
  const parsed = parseClaudeStream(load("write-receipt"), WS);

  it("records every tool call in stream order with workspace-relative summaries", () => {
    expect(parsed.steps).toEqual([
      { index: 0, tool: "Skill", input_summary: "receipt-writer" },
      { index: 1, tool: "Write", input_summary: "report.md" },
      { index: 2, tool: "Bash", input_summary: "sha256sum report.md > report.md.sha256" },
    ]);
  });

  it("reads init, turns, result text, cost and usage", () => {
    expect(parsed.init).toMatchObject({
      model: "claude-haiku-5-5",
      apiKeySource: "none",
      claudeCodeVersion: "2.1.293",
    });
    expect(parsed.init?.skills).toContain("receipt-writer");
    expect(parsed.turns).toBe(4);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.result).toMatchObject({
      subtype: "success",
      isError: false,
      numTurns: 5,
      totalCostUsd: 0.00275216,
      usage: {
        inputTokens: 8,
        outputTokens: 321,
        cacheCreationInputTokens: 11316,
        cacheReadInputTokens: 32766,
      },
    });
    expect(parsed.result?.text).toContain("report.md.sha256");
  });

  it("is deterministic: one-shot, re-parse and arbitrary chunking agree", () => {
    const text = load("write-receipt");
    expect(parseClaudeStream(text, WS)).toEqual(parsed);
    for (const size of [1, 7, 64, 1000]) {
      const p = new ClaudeStreamParser(WS);
      for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
      expect(p.finish()).toEqual(parsed);
    }
  });
});

describe("parseClaudeStream — recorded read-missing run (naked, failing Read)", () => {
  const parsed = parseClaudeStream(load("read-missing"), WS);

  it("flags the tool call whose result came back as an error", () => {
    expect(parsed.steps).toEqual([
      { index: 0, tool: "Read", input_summary: "notes.txt" },
      { index: 1, tool: "Read", input_summary: "missing.txt", is_error: true },
    ]);
    expect(parsed.turns).toBe(2);
    expect(parsed.result?.text).toMatch(/^First line of notes\.txt/);
  });
});

describe("parseClaudeStream — damaged and partial transcripts", () => {
  it("counts non-JSON lines instead of failing and keeps the events that parsed", () => {
    const text = [
      "not json",
      "[1,2]",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      }),
      JSON.stringify({ type: "rate_limit_event" }),
    ].join("\n");
    const p = parseClaudeStream(text, "/w");
    expect(p.malformedLines).toBe(2);
    expect(p.steps).toEqual([{ index: 0, tool: "Bash", input_summary: "ls" }]);
    // An assistant message without an id still counts as a turn.
    expect(p.turns).toBe(1);
    expect(p.result).toBeNull();
    expect(p.init).toBeNull();
  });

  it("falls back to the last assistant text when there is no result event", () => {
    const text = JSON.stringify({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "partial answer" }] },
    });
    const p = parseClaudeStream(text, "/w");
    expect(p.lastText).toBe("partial answer");
    expect(p.turns).toBe(1);
  });
});

describe("summarizeToolInput / relativizePaths", () => {
  it("rewrites only whole workspace-root path components", () => {
    expect(relativizePaths("cat /tmp/x/ws/a.md /tmp/x/ws2/b.md", "/tmp/x/ws")).toBe(
      "cat a.md /tmp/x/ws2/b.md",
    );
    expect(relativizePaths("cd /tmp/x/ws && ls", "/tmp/x/ws/")).toBe("cd . && ls");
    // Regex metacharacters in the root are escaped in both rewrites.
    expect(
      relativizePaths("cat /tmp/x.y/ws/a.md /tmp/xzy/ws/b.md /tmp/x.y/ws", "/tmp/x.y/ws"),
    ).toBe("cat a.md /tmp/xzy/ws/b.md .");
  });

  it("summarizes unknown tools as key-sorted JSON and truncates long input", () => {
    expect(summarizeToolInput("mcp__x__y", { b: 1, a: { d: [2], c: "z" } }, "/w")).toBe(
      '{"a":{"c":"z","d":[2]},"b":1}',
    );
    expect(summarizeToolInput("Bash", { command: "echo ab ".repeat(1000) }, "/w")).toHaveLength(
      2000,
    );
    expect(summarizeToolInput("Grep", { pattern: "TODO", path: "/w/src" }, "/w")).toBe("TODO");
    expect(summarizeToolInput("Write", "not-an-object", "/w")).toBe("{}");
  });

  it("redacts credential-shaped substrings in persisted summaries", () => {
    const s = summarizeToolInput(
      "Bash",
      {
        command: 'curl -H "Authorization: Bearer abcdefghijklmnop" -d k=sk-ant-0123456789abcdef x',
      },
      "/w",
    );
    expect(s).not.toContain("abcdefghijklmnop");
    expect(s).not.toContain("sk-ant-0123456789abcdef");
    expect(s).toContain("curl");
  });
});
