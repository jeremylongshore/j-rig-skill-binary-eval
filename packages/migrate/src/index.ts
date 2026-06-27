/**
 * @j-rig/migrate — codemod that rewrites v0.1.0-draft Evidence Bundle rows
 * into the v2.0 kernel `gate-result/v1` shape.
 *
 * Two layers:
 *   - pure transform (`migrateBundle` / `migrateStatement`) — no IO
 *   - codemod driver (`runCodemod`) — walks files via an injectable fs and
 *     emits a unified diff; `nodeFs` is the real-disk binding.
 *
 * The `j-rig migrate <dir>` CLI subcommand in `@intentsolutions/jrig-cli` wraps `runCodemod`.
 */
export {
  migrateBundle,
  migrateStatement,
  deriveGateName,
  deriveGateVersion,
  derivePolicyRef,
  NOT_APPLICABLE_TOKEN,
  NOT_APPLICABLE_REASON,
  type MigrateBundleResult,
  type RowReport,
  type RowOutcome,
} from "./transform.js";

export {
  runCodemod,
  unifiedDiff,
  type CodemodFs,
  type CodemodOptions,
  type CodemodResult,
  type FileResult,
} from "./codemod.js";

export { nodeFs } from "./fs.js";
