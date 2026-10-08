export { checkPackage } from "./package-checker.js";

export {
  registerCheck,
  runCheck,
  listChecks,
  type DeterministicCheckFn,
} from "./deterministic-registry.js";

export {
  summarize,
  formatReport,
  type CheckSeverity,
  type CheckResult,
  type PackageReport,
} from "./types.js";

export {
  TRAJECTORY_CHECK_NAMES,
  TRAJECTORY_CHECK_PARAM_SCHEMAS,
  ToolMatcherSchema,
  isTrajectoryCheck,
  runTrajectoryCheck,
  trajectoryCheckParamIssues,
  type ToolMatcher,
  type TrajectoryCheckInput,
  type TrajectoryCheckName,
  type TrajectoryCheckResult,
} from "./trajectory-checks.js";
