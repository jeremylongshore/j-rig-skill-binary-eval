import { z } from "zod";

/**
 * Stable identifiers used by the generic evaluation substrate.
 *
 * These are deliberately less restrictive than skill names: a task or
 * configuration may be supplied by another repository, a benchmark fixture,
 * or a local experiment. The characters remain safe for filenames and CLI
 * diagnostics.
 */
export const EvalIdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe evaluation identifier");

/** A model/harness-neutral task definition. */
export const EvalTaskSchema = z.object({
  id: EvalIdentifierSchema,
  version: z.string().min(1).default("1"),
  description: z.string().min(1).optional(),
  input: z.unknown().optional(),
  tags: z.array(z.string().min(1)).default([]),
});

export type EvalTask = z.infer<typeof EvalTaskSchema>;

/**
 * The executable boundary for a configuration.
 *
 * `command` and `args` are intentionally separate. The runner never invokes a
 * shell, so task data cannot become shell syntax accidentally.
 */
export const RunnerHarnessSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive().max(86_400_000).default(60_000),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
});

export type RunnerHarness = z.infer<typeof RunnerHarnessSchema>;

/** A named, versioned execution configuration. */
export const EvalConfigSchema = z.object({
  id: EvalIdentifierSchema,
  version: z.string().min(1).default("1"),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  harness: RunnerHarnessSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().min(1)).default([]),
});

export type EvalConfig = z.infer<typeof EvalConfigSchema>;

/** Runner outcomes distinguish harness failure from a completed model output. */
export const RunnerStatusSchema = z.enum(["completed", "runner_error", "timed_out"]);
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

/** Metadata passed to every runner invocation. */
export interface RunnerRequest {
  run_id: string;
  task: EvalTask;
  config: EvalConfig;
  model: string;
  sample_index: number;
}

/** An immutable reference to an artifact produced during a raw run. */
export interface RunnerArtifact {
  name: string;
  relative_path: string;
  media_type?: string;
  size_bytes: number;
  sha256: string;
}

/** The ungraded observation returned by a runner. */
export interface RunnerResult {
  status: RunnerStatus;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  error_message?: string;
  artifacts: RunnerArtifact[];
}

/** Any execution implementation can plug into the generic substrate. */
export interface EvalRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
}
