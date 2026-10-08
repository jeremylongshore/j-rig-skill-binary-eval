/**
 * Deterministic parser for `claude -p --output-format stream-json --verbose`.
 *
 * The stream is newline-delimited JSON. The events this parser reads:
 *
 *   {"type":"system","subtype":"init", model, tools, skills, apiKeySource, claude_code_version, …}
 *   {"type":"assistant","message":{"id", "content":[{type:"text"|"tool_use"|"thinking", …}], …}}
 *   {"type":"user","message":{"content":[{type:"tool_result", tool_use_id, is_error?, …}]}}
 *   {"type":"result", subtype, is_error, num_turns, result, total_cost_usd, usage, stop_reason}
 *
 * Every other event type (rate-limit notices, partial deltas, hooks) is
 * ignored, and a line that is not JSON is counted, not fatal: the trajectory
 * is built from the events that parsed, and the count is reported so a
 * damaged transcript is visible.
 *
 * Same bytes in, same trajectory out: no clock, no randomness, credential-
 * shaped substrings redacted by core's rules, and every
 * absolute path under the workspace root is rewritten relative to it before
 * it reaches an input summary, so a recorded transcript replays identically
 * on any machine.
 */
import { MAX_INPUT_SUMMARY_CHARS, redactCredentials, type TrajectoryStep } from "@j-rig/core";

export interface ClaudeStreamInit {
  model?: string;
  apiKeySource?: string;
  claudeCodeVersion?: string;
  tools: string[];
  skills: string[];
}

export interface ClaudeStreamResult {
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  text?: string;
  stopReason?: string;
  /** API-equivalent USD the CLI reports; on a subscription this is not billed. */
  totalCostUsd?: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

export interface ParsedClaudeStream {
  init: ClaudeStreamInit | null;
  steps: TrajectoryStep[];
  /** Distinct assistant message ids seen. */
  turns: number;
  /** Last assistant text block (fallback when no result event arrived). */
  lastText: string;
  result: ClaudeStreamResult | null;
  malformedLines: number;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Key-sorted JSON so the same input object always summarizes the same way. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Rewrite absolute paths under `root` to workspace-relative form. The root
 * itself becomes `.`; a path inside it loses the `root/` prefix.
 */
export function relativizePaths(text: string, root: string): string {
  if (!root) return text;
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only a whole path component matches: `/ws` must not rewrite `/ws2/x`.
  return text
    .replace(new RegExp(`${esc}/`, "g"), "")
    .replace(new RegExp(`${esc}(?![A-Za-z0-9._-])`, "g"), ".");
}

/** Deterministic, workspace-relative summary of one tool call's input. */
export function summarizeToolInput(tool: string, input: unknown, root: string): string {
  const obj = isObj(input) ? input : {};
  const str = (k: string): string | undefined =>
    typeof obj[k] === "string" ? (obj[k] as string) : undefined;
  let summary: string;
  switch (tool) {
    case "Bash":
      summary = str("command") ?? canonicalJson(obj);
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      summary = str("file_path") ?? str("notebook_path") ?? canonicalJson(obj);
      break;
    case "Glob":
    case "Grep":
      summary = str("pattern") ?? canonicalJson(obj);
      break;
    case "Skill":
      summary = str("skill") ?? str("command") ?? canonicalJson(obj);
      break;
    default:
      summary = canonicalJson(obj);
  }
  // Credential-shaped substrings (bearer tokens, sk-/ghp_ keys, long opaque
  // tokens) are redacted with core's provider-error rules: the summary is
  // persisted in the eval output, and a skill's command may carry a secret.
  summary = redactCredentials(relativizePaths(summary, root));
  return summary.length > MAX_INPUT_SUMMARY_CHARS
    ? summary.slice(0, MAX_INPUT_SUMMARY_CHARS)
    : summary;
}

/**
 * Incremental parser: feed stdout chunks as they arrive (so the provider can
 * enforce the turn budget live), then call {@link finish}.
 */
export class ClaudeStreamParser {
  readonly #root: string;
  #buf = "";
  #init: ClaudeStreamInit | null = null;
  readonly #steps: TrajectoryStep[] = [];
  readonly #stepByToolUseId = new Map<string, TrajectoryStep>();
  readonly #messageIds = new Set<string>();
  #anonymousTurns = 0;
  #lastText = "";
  #result: ClaudeStreamResult | null = null;
  #malformed = 0;

  constructor(workspaceRoot: string) {
    this.#root = workspaceRoot;
  }

  get turns(): number {
    return this.#messageIds.size + this.#anonymousTurns;
  }

  get init(): ClaudeStreamInit | null {
    return this.#init;
  }

  push(chunk: string): void {
    this.#buf += chunk;
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 1);
      this.#line(line);
    }
  }

  finish(): ParsedClaudeStream {
    if (this.#buf.length > 0) {
      this.#line(this.#buf);
      this.#buf = "";
    }
    return {
      init: this.#init,
      steps: this.#steps.map((s) => ({ ...s })),
      turns: this.turns,
      lastText: this.#lastText,
      result: this.#result,
      malformedLines: this.#malformed,
    };
  }

  #line(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      this.#malformed++;
      return;
    }
    if (!isObj(e)) {
      this.#malformed++;
      return;
    }
    switch (e.type) {
      case "system":
        if (e.subtype === "init") this.#onInit(e);
        return;
      case "assistant":
        this.#onAssistant(e);
        return;
      case "user":
        this.#onUser(e);
        return;
      case "result":
        this.#onResult(e);
        return;
      default:
        return;
    }
  }

  #onInit(e: Json): void {
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    this.#init = {
      ...(typeof e.model === "string" ? { model: e.model } : {}),
      ...(typeof e.apiKeySource === "string" ? { apiKeySource: e.apiKeySource } : {}),
      ...(typeof e.claude_code_version === "string"
        ? { claudeCodeVersion: e.claude_code_version }
        : {}),
      tools: strings(e.tools),
      skills: strings(e.skills),
    };
  }

  #onAssistant(e: Json): void {
    const msg = isObj(e.message) ? e.message : {};
    if (typeof msg.id === "string") this.#messageIds.add(msg.id);
    else this.#anonymousTurns++;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        const step: TrajectoryStep = {
          index: this.#steps.length,
          tool: block.name,
          input_summary: summarizeToolInput(block.name, block.input, this.#root),
        };
        this.#steps.push(step);
        if (typeof block.id === "string") this.#stepByToolUseId.set(block.id, step);
      } else if (block.type === "text" && typeof block.text === "string" && block.text) {
        this.#lastText = block.text;
      }
    }
  }

  #onUser(e: Json): void {
    const msg = isObj(e.message) ? e.message : {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!isObj(block) || block.type !== "tool_result") continue;
      if (block.is_error !== true || typeof block.tool_use_id !== "string") continue;
      const step = this.#stepByToolUseId.get(block.tool_use_id);
      if (step) step.is_error = true;
    }
  }

  #onResult(e: Json): void {
    const u = isObj(e.usage) ? e.usage : {};
    this.#result = {
      ...(typeof e.subtype === "string" ? { subtype: e.subtype } : {}),
      isError: e.is_error === true,
      ...(typeof e.num_turns === "number" ? { numTurns: e.num_turns } : {}),
      ...(typeof e.result === "string" ? { text: e.result } : {}),
      ...(typeof e.stop_reason === "string" ? { stopReason: e.stop_reason } : {}),
      ...(typeof e.total_cost_usd === "number" ? { totalCostUsd: e.total_cost_usd } : {}),
      usage: {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheCreationInputTokens: num(u.cache_creation_input_tokens),
        cacheReadInputTokens: num(u.cache_read_input_tokens),
      },
    };
  }
}

/** One-shot parse of a complete transcript. */
export function parseClaudeStream(text: string, workspaceRoot: string): ParsedClaudeStream {
  const p = new ClaudeStreamParser(workspaceRoot);
  p.push(text);
  return p.finish();
}
