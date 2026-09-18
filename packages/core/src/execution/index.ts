export { runFunctionalTests, checkOutputExpectations } from "./runner.js";
export { ExecutableRunner } from "./executable-runner.js";
export {
  EvalConfigSchema,
  EvalIdentifierSchema,
  EvalTaskSchema,
  RunnerHarnessSchema,
  RunnerStatusSchema,
  type EvalConfig,
  type EvalRunner,
  type EvalTask,
  type RunnerArtifact,
  type RunnerHarness,
  type RunnerRequest,
  type RunnerResult,
  type RunnerStatus,
} from "./substrate.js";
export {
  runSelfTest,
  toSelfTestJudgment,
  buildSelfTestCriterion,
  summarizeSelfTest,
  DEFAULT_SELF_TEST_TIMEOUT_MS,
  type SelfTestResult,
} from "./self-test.js";
export type {
  ExecutionContext,
  ExecutionOutput,
  ExecutionMeta,
  ArtifactRecord,
  ObservedOutcome,
  ExecutionProvider,
} from "./types.js";
