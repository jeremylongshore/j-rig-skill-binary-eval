/**
 * Context provided to the skill during execution.
 */
export interface ExecutionContext {
  skill_body: string;
  base_path?: string;
  file_contents?: Record<string, string>;
  context_hints?: Record<string, unknown>;
}

/**
 * Raw output captured from a skill execution.
 */
export interface ExecutionOutput {
  text: string;
  artifacts: ArtifactRecord[];
  tool_calls: number;
  error?: string;
}

/**
 * A captured artifact from skill execution.
 */
export interface ArtifactRecord {
  filename: string;
  content: string;
  type: "text" | "binary_ref";
  size_bytes: number;
}

/**
 * Execution timing and cost metadata.
 */
export interface ExecutionMeta {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_cost_usd?: number;
  timed_out: boolean;
}

/**
 * The complete observed outcome of a functional execution.
 */
export interface ObservedOutcome {
  test_case_id: string;
  prompt: string;
  output: ExecutionOutput;
  meta: ExecutionMeta;
  status: "completed" | "failed" | "timed_out";
}

/**
 * Provider interface for skill execution.
 * Abstracts the actual LLM call so tests can use a mock.
 */
export interface ExecutionProvider {
  execute(
    prompt: string,
    context: ExecutionContext,
    options?: { timeout_ms?: number; model?: string },
  ): Promise<ExecutionOutput & { meta: ExecutionMeta }>;
}
