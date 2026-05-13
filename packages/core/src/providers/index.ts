export {
  ProviderError,
  isProviderError,
  type ProviderErrorCategory,
} from "./errors.js";

export type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  FinishReason,
  Provider,
  StreamChunk,
  TokenUsage,
  ToolCallResult,
  ToolDefinition,
} from "./types.js";

export {
  runCisoGateG1,
  runCisoGateG2,
  findKeySubstrings,
  type G1Args,
  type G1Result,
  type G2Args,
  type G2Result,
} from "./ciso-gates/index.js";

export { CleanProvider } from "./test-fixtures/clean-provider.js";
export { LeakyProvider } from "./test-fixtures/leaky-provider.js";

export {
  DEFAULT_MODELS,
  runEC1,
  runEC2,
  runEC3,
  runEC4,
  runEC5,
  runFullECSuite,
  type ECModelSet,
  type ECPerModelOutcome,
  type ECResult,
  type ECRunner,
  type ECRunnerOptions,
  type ECSuiteResult,
  type EC4Options,
  type EC4Triggers,
} from "./eval-cases/index.js";

export {
  computeProviderScoreCard,
  draftDecisionRecordFragment,
  locToScore,
  type RubricScores,
  type ProviderScoreCard,
  type ProviderScoreCardInputs,
  type StaticAnalysisInputs,
} from "./score-card/index.js";
