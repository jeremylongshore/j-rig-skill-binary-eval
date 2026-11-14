/**
 * Agentic execution trajectory — what an execution provider OBSERVED a skill
 * do, as opposed to the text it said it did.
 *
 * A single-completion provider sends one chat request and can only report
 * text, so it leaves `ExecutionOutput.trajectory` undefined. An agentic
 * provider (the `claude-code` execution provider, which runs `claude -p
 * --output-format stream-json` in a per-case workspace) fills it with:
 *
 *   - `steps`: every tool call, in stream order, with a deterministic,
 *     workspace-relative input summary (never the raw input: a Write's file
 *     body is not repeated here);
 *   - `files`: the post-run workspace manifest, every file with its sha256
 *     and whether the run created, modified, or left it unchanged (deleted
 *     files are listed with `sha256: null`).
 *
 * The trajectory checks (`checks/trajectory-checks.ts`) grade this record.
 * "Observed behavior outranks claimed behavior" (design principle 3): a
 * criterion such as "the skill lints before it renders" is graded from the
 * recorded tool order, not from the final message.
 */

export const TRAJECTORY_SCHEMA = "j-rig/trajectory/v1" as const;

/** One recorded tool call. */
export interface TrajectoryStep {
  /** 0-based position in the stream. */
  index: number;
  /** Tool name exactly as the agent called it (`Bash`, `Write`, `Skill`, an MCP tool, …). */
  tool: string;
  /**
   * Deterministic summary of the call input, workspace paths made relative:
   * Bash → the command; Read/Write/Edit → the file path; Glob/Grep → the
   * pattern; Skill → the skill name; anything else → canonical (key-sorted)
   * JSON. Truncated to {@link MAX_INPUT_SUMMARY_CHARS}.
   */
  input_summary: string;
  /** True when the tool result came back flagged as an error. */
  is_error?: boolean;
}

export type TrajectoryFileChange = "created" | "modified" | "unchanged" | "deleted";

/** One entry of the post-run workspace manifest. */
export interface TrajectoryFile {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Lowercase hex sha256 of the final bytes; null for a deleted file. */
  sha256: string | null;
  size_bytes: number;
  change: TrajectoryFileChange;
}

/** Why the agent run ended. */
export type TrajectoryStop =
  "completed" | "error" | "max_turns" | "timeout" | "budget" | "no_result";

export interface Trajectory {
  schema: typeof TRAJECTORY_SCHEMA;
  /** Which execution provider recorded it (e.g. `claude-code`). */
  source: string;
  /** Model the agent reported running on, when the stream said. */
  model?: string;
  steps: TrajectoryStep[];
  /** Sorted by path. Excludes the installed skill copy and the sandbox home. */
  files: TrajectoryFile[];
  /** Assistant turns observed (distinct assistant message ids). */
  turns: number;
  stop: TrajectoryStop;
}

export const MAX_INPUT_SUMMARY_CHARS = 2000;
