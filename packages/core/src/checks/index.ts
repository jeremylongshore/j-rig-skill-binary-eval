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
