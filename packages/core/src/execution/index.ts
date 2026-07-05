export { runFunctionalTests, checkOutputExpectations } from "./runner.js";
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
