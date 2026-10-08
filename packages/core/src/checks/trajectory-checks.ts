import { z } from "zod";
import type { ArtifactRecord } from "../execution/types.js";
import type { Trajectory, TrajectoryFile, TrajectoryStep } from "../execution/trajectory.js";

/**
 * Trajectory checks — deterministic criteria graded from what an agentic
 * execution provider OBSERVED (tool calls, their order, files produced), not
 * from the response text.
 *
 * They are ordinary `method: deterministic` criteria: `deterministic_check`
 * names the check and `deterministic_check_params` carries its parameters,
 * which the spec schema validates at load time against the schemas below (a
 * typo'd param fails `j-rig validate`, before any model spend).
 *
 * Every check fails CLOSED when the outcome carries no trajectory: a
 * single-completion provider cannot observe tools or files, so "no tool was
 * called" would otherwise pass vacuously on a run that never could have
 * called one.
 */

/** Selects tool calls: exact tool name, optional substring of the input summary. */
export const ToolMatcherSchema = z
  .object({
    tool: z.string().min(1).describe("Exact tool name (e.g. Bash, Write, Skill)"),
    input_contains: z
      .string()
      .min(1)
      .optional()
      .describe("Substring the call's input summary must contain (Bash command, file path, …)"),
  })
  .strict();
export type ToolMatcher = z.infer<typeof ToolMatcherSchema>;

/** Selects workspace files: exactly one of an exact relative path or a regex over it. */
const FileSelectorShape = {
  path: z.string().min(1).optional().describe("Exact workspace-relative path"),
  pattern: z.string().min(1).optional().describe("Regex over the workspace-relative path"),
};

function exactlyOneSelector(v: { path?: string; pattern?: string }): boolean {
  return (v.path === undefined) !== (v.pattern === undefined);
}

function validRegex(v: { pattern?: string }): boolean {
  if (v.pattern === undefined) return true;
  try {
    new RegExp(v.pattern);
    return true;
  } catch {
    return false;
  }
}

const SELECTOR_MESSAGE = "exactly one of `path` or `pattern` is required";
const REGEX_MESSAGE = "`pattern` is not a valid regular expression";

export const TRAJECTORY_CHECK_PARAM_SCHEMAS = {
  /** The tool was called at least `min_count` (default 1) times. */
  tool_called: ToolMatcherSchema.extend({
    min_count: z.number().int().min(1).optional(),
  }).strict(),
  /** No call matched. */
  tool_not_called: ToolMatcherSchema,
  /** Both happened, and the first `first` call precedes the first `then` call. */
  order_before: z.object({ first: ToolMatcherSchema, then: ToolMatcherSchema }).strict(),
  /** A matching file exists after the run (and, with `produced: true`, the run created or modified it). */
  file_exists: z
    .object({ ...FileSelectorShape, produced: z.boolean().optional() })
    .strict()
    .refine(exactlyOneSelector, SELECTOR_MESSAGE)
    .refine(validRegex, REGEX_MESSAGE),
  /**
   * Every matching file exists, and its sha256 appears in the text of the
   * file named by `in` — a produced text artifact (a receipt, a manifest).
   * `in` may use `{path}` for the matched file's path, e.g. `{path}.qa.json`.
   */
  file_matches_sha_in: z
    .object({
      ...FileSelectorShape,
      in: z
        .string()
        .min(1)
        .refine(
          (v) => !v.startsWith("/") && !v.split("/").includes(".."),
          "`in` must be a workspace-relative path without `..`",
        )
        .describe("Produced text file that must contain the sha256"),
    })
    .strict()
    .refine(exactlyOneSelector, SELECTOR_MESSAGE)
    .refine(validRegex, REGEX_MESSAGE),
} as const;

export type TrajectoryCheckName = keyof typeof TRAJECTORY_CHECK_PARAM_SCHEMAS;
export const TRAJECTORY_CHECK_NAMES = Object.keys(
  TRAJECTORY_CHECK_PARAM_SCHEMAS,
) as TrajectoryCheckName[];

export function isTrajectoryCheck(name: string): name is TrajectoryCheckName {
  return Object.prototype.hasOwnProperty.call(TRAJECTORY_CHECK_PARAM_SCHEMAS, name);
}

/** Spec-load validation: returns one message per problem (empty = valid). */
export function trajectoryCheckParamIssues(
  name: TrajectoryCheckName,
  params: Record<string, unknown> | undefined,
): string[] {
  const parsed = TRAJECTORY_CHECK_PARAM_SCHEMAS[name].safeParse(params ?? {});
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => {
    const at = i.path.length > 0 ? ` at params.${i.path.join(".")}` : "";
    return `${name}: ${i.message}${at}`;
  });
}

export interface TrajectoryCheckResult {
  passed: boolean;
  message: string;
}

/** What a trajectory check reads from an outcome. */
export interface TrajectoryCheckInput {
  trajectory?: Trajectory;
  artifacts: ArtifactRecord[];
}

function matches(step: TrajectoryStep, m: ToolMatcher): boolean {
  if (step.tool !== m.tool) return false;
  return m.input_contains === undefined || step.input_summary.includes(m.input_contains);
}

function describe(m: ToolMatcher): string {
  return m.input_contains === undefined ? m.tool : `${m.tool}(…${m.input_contains}…)`;
}

function selectFiles(files: TrajectoryFile[], sel: { path?: string; pattern?: string }) {
  const live = files.filter((f) => f.change !== "deleted");
  if (sel.path !== undefined) return live.filter((f) => f.path === sel.path);
  const re = new RegExp(sel.pattern!);
  return live.filter((f) => re.test(f.path));
}

function selectorLabel(sel: { path?: string; pattern?: string }): string {
  return sel.path !== undefined ? `"${sel.path}"` : `/${sel.pattern}/`;
}

/**
 * Run a trajectory check. Params are re-parsed here (defense in depth for a
 * criterion that reached the engine without the spec schema); an invalid
 * param, a missing trajectory, or a missing `in` file all fail closed.
 */
export function runTrajectoryCheck(
  name: TrajectoryCheckName,
  input: TrajectoryCheckInput,
  params: Record<string, unknown> | undefined,
): TrajectoryCheckResult {
  const issues = trajectoryCheckParamIssues(name, params);
  if (issues.length > 0) {
    return { passed: false, message: `Check "${name}" errored: ${issues.join("; ")}` };
  }
  const t = input.trajectory;
  if (!t) {
    return {
      passed: false,
      message:
        `Check "${name}" needs an observed trajectory, and this execution provider records ` +
        `none (single-completion providers cannot observe tools or files). Run with ` +
        `--execution-provider claude-code.`,
    };
  }
  // A run cut short by a budget, an error or a missing result is truncated:
  // grading it would let `tool_not_called` pass on calls that never had the
  // chance to happen. `j-rig eval` already skips such cases (they carry an
  // error); this keeps every other caller of the engine fail-closed too.
  if (t.stop !== "completed") {
    return {
      passed: false,
      message: `Check "${name}" refused: the run ended with stop "${t.stop}", so its trajectory is truncated`,
    };
  }

  switch (name) {
    case "tool_called": {
      const p = TRAJECTORY_CHECK_PARAM_SCHEMAS.tool_called.parse(params);
      const min = p.min_count ?? 1;
      const n = t.steps.filter((s) => matches(s, p)).length;
      return {
        passed: n >= min,
        message: `${describe(p)} called ${n} time(s); required at least ${min}`,
      };
    }
    case "tool_not_called": {
      const p = TRAJECTORY_CHECK_PARAM_SCHEMAS.tool_not_called.parse(params);
      const hit = t.steps.find((s) => matches(s, p));
      return hit
        ? { passed: false, message: `${describe(p)} was called at step ${hit.index}` }
        : { passed: true, message: `${describe(p)} was never called` };
    }
    case "order_before": {
      const p = TRAJECTORY_CHECK_PARAM_SCHEMAS.order_before.parse(params);
      const a = t.steps.find((s) => matches(s, p.first));
      const b = t.steps.find((s) => matches(s, p.then));
      if (!a || !b) {
        const missing = [!a ? describe(p.first) : null, !b ? describe(p.then) : null]
          .filter(Boolean)
          .join(" and ");
        return { passed: false, message: `${missing} never called` };
      }
      return {
        passed: a.index < b.index,
        message: `${describe(p.first)} first at step ${a.index}, ${describe(p.then)} first at step ${b.index}`,
      };
    }
    case "file_exists": {
      const p = TRAJECTORY_CHECK_PARAM_SCHEMAS.file_exists.parse(params);
      const found = selectFiles(t.files, p);
      const ok = p.produced
        ? found.filter((f) => f.change === "created" || f.change === "modified")
        : found;
      return ok.length > 0
        ? {
            passed: true,
            message: `${selectorLabel(p)} matched ${ok.map((f) => f.path).join(", ")}`,
          }
        : {
            passed: false,
            message:
              found.length > 0
                ? `${selectorLabel(p)} exists but the run did not produce it`
                : `no file matched ${selectorLabel(p)}`,
          };
    }
    case "file_matches_sha_in": {
      const p = TRAJECTORY_CHECK_PARAM_SCHEMAS.file_matches_sha_in.parse(params);
      const found = selectFiles(t.files, p);
      if (found.length === 0) {
        return { passed: false, message: `no file matched ${selectorLabel(p)}` };
      }
      for (const f of found) {
        const inPath = p.in.split("{path}").join(f.path);
        const holder = input.artifacts.find((a) => a.filename === inPath && a.type === "text");
        if (!holder) {
          return {
            passed: false,
            message: `"${inPath}" is not a text file the run produced, so ${f.path} cannot be verified`,
          };
        }
        if (!f.sha256 || !holder.content.toLowerCase().includes(f.sha256)) {
          return {
            passed: false,
            message: `sha256 of ${f.path} does not appear in "${inPath}"`,
          };
        }
      }
      return {
        passed: true,
        message: `sha256 of ${found.map((f) => f.path).join(", ")} recorded in ${p.in}`,
      };
    }
  }
}
