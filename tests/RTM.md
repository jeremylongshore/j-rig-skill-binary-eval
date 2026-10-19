# Requirements Traceability Matrix — J-Rig

<!-- Managed by audit-tests/rtm-builder-agent. Observational extraction only.
Engineer-authored MoSCoW overrides must survive subsequent audits. No policy,
coverage threshold, release authority, or historical acceptance is changed. -->

Audit baseline: `e3119f41ffce449844c6320b3d97eef777a9ba20`, 2026-10-19.
Refs bead `bd_000-projects-0s9t`.

## Scope and interpretation

This first matrix inventories current operator contracts in the root README,
STUB-PROVIDERS, MIGRATION, package documentation, active specifications 031–048
(040 is a historical dogfood report), and the package export contract for the
PR-comment renderer. It maps selected assertions across all nine workspace
packages. It does **not** exhaustively extract every historical blueprint, epic,
external decision record, template, or commit message. Historical completion
claims and npm publication versions are not accepted as test evidence.

No existing RTM, engineer overrides, explicit MoSCoW frontmatter, Gherkin
scenarios, or in-source `REQ-NNN` test references were found in the inspected
source set. All priorities below are **SHOULD, inferred — engineer review** under
the audit skill's fallback rule; this is not a downgrade of normative language
in the source contracts. In particular, source `MUST` obligations and safety
boundaries remain binding regardless of this provisional prioritization.

**Covered** means concrete local assertions exercise the bounded requirement
described in that row. **Partial** means local tests cover only part of the
stated product/operator claim. **Unverified** means no applicable test evidence
was found within this inventory. None of these labels asserts a fresh passing
run, live provider quality, signed publication, or exhaustive correctness.
See the audit report for executed checks. L3 denotes unit/contract tests, L4
local integration (SQLite, filesystem, HTTP fixtures, child processes), and L6
CLI smoke/end-to-end checks through the built executable. L7 means user
acceptance testing; no L7 evidence is inferred from these automated tests. These are test-taxonomy labels,
not J-Rig's seven product evaluation dimensions. No browser layer is inferred
from tests of HTML strings.

## Matrix

Each linked test file is an explicit sidecar association to its row's REQ ID;
quoted names identify representative tests, not every assertion in that file.

| Req ID | MoSCoW | Authored source and requirement | Layers | Test evidence and limit | Status |
| --- | --- | --- | --- | --- | --- |
| REQ-001 | SHOULD | [README: seven layers](../README.md#the-solution): package checks detect invalid frontmatter, missing skill files and broken references. | L3, L4 | [package-checker.test.ts](../packages/core/src/checks/package-checker.test.ts): “fails on missing SKILL.md”, “fails on broken frontmatter”, “detects broken file references”. These exercise the checker; independent `check`/`validate` CLI acceptance is not established here. | Covered |
| REQ-002 | SHOULD | [README: design principles](../README.md#non-negotiable-design-principles): binary criteria use deterministic checks first and a separate judge; unavailable samples must not manufacture certainty. | L3 | [judgment.test.ts](../packages/core/src/judgment/judgment.test.ts): “routes deterministic before judge in mixed criteria”, “never reports false certainty from a degraded run (1 success + 4 errors)”; [criterion.test.ts](../packages/core/src/schemas/criterion.test.ts): rejects a missing deterministic check. Injected judge assertions do not establish live judge independence or calibration quality. | Partial |
| REQ-003 | SHOULD | [CLI: trigger evidence](../packages/cli/README.md#trigger-evidence): preserve routing outcomes, explicit coverage status, private receipt digest and portable summary without private prompts. | L3, L4, L6 | [trigger.test.ts](../packages/core/src/trigger/trigger.test.ts): false positive/negative/sibling confusion; [eval-trigger.e2e.test.ts](../packages/cli/src/commands/eval-trigger.e2e.test.ts): “retains independently verifiable routing (%s)” runs correct, incorrect, provider-error, skipped, not-applicable and trigger-only-error modes against local HTTP. | Covered |
| REQ-004 | SHOULD | [README: coverage honesty](../README.md#the-solution): sacred regressions block; naked-model parity flags obsolete review; disabled dimensions remain explicit. | L3, L4, L6 | [eval-baseline-regression.test.ts](../packages/cli/src/commands/eval-baseline-regression.test.ts): “loaded baseline + regressed sacred criterion -> detectRegressions -> computeScoreCard -> decideRollout = block”; [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts): “promotes a deterministic skill row only after a regression baseline runs”; [governance.test.ts](../packages/core/src/governance/governance.test.ts): obsolete candidate and blocker decisions. | Covered |
| REQ-005 | SHOULD | [STUB-PROVIDERS](../STUB-PROVIDERS.md): explicit stub opt-in and refusal of stub/false-ground-truth rows by rollout consumers. | L3, L6 | [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts) exercises the built CLI with explicit stub configuration; [decide.test.ts](../packages/rollout-gate/src/decide.test.ts): “blocks a passing row produced by the stub provider by default”, “blocks a row that declares ground_truth=false under any provider name”. The whole consumer fleet and every banner/opt-in entry point are not proven by these associations. | Partial |
| REQ-006 | SHOULD | [Spec 037](../000-docs/037-AT-SPEC-real-provider-failure-boundary-2026-08-02.md): unrecovered provider failure means no quality verdict, error evidence, failed persisted run and exit 2; do not judge failed executions. | L3, L4, L6 | [eval-infrastructure-failure.test.ts](../packages/cli/src/commands/eval-infrastructure-failure.test.ts): partial outages and credential redaction; [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts): “signs `error` when an execution call fails, and never judges the failed test case”. Test names use “signs”; the assertions establish statement output, not cryptographic signing. | Covered |
| REQ-007 | SHOULD | [Spec 047](../000-docs/047-AT-SPEC-eval-cost-latency-budgets-2026-10-08.md): invocation budget uses the stricter spec/flag limit; exhaustion exits 3 without a verdict or bundle row; unknown USD rates fail closed. | L3, L4, L6 | [budget.test.ts](../packages/cli/src/providers/budget.test.ts); [eval-budget.e2e.test.ts](../packages/cli/src/commands/eval-budget.e2e.test.ts): “stops on --max-calls with no verdict, records why, skips later models, exits 3”, “fails --max-usd closed when the model has no rate on file”. Local server records actual call count; SQLite and absent bundle are asserted. | Covered |
| REQ-008 | SHOULD | [Spec 031](../000-docs/031-AT-SPEC-generic-runner-config-raw-run-2026-08-01.md): shell-free runner passes explicit environment/JSON, retains output, bounds timeout and output, and preserves default-free config snapshots. | L3, L4 | [executable-runner.test.ts](../packages/core/src/execution/executable-runner.test.ts): “passes JSON and lineage metadata without inheriting secrets”, stdout/stderr overflow and unchanged snapshot cases. POSIX process-group cases are platform conditional; this is host protection, not an OS sandbox. | Covered |
| REQ-009 | SHOULD | [Spec 031: raw Run ledger](../000-docs/031-AT-SPEC-generic-runner-config-raw-run-2026-08-01.md#raw-run-ledger): persist lineage before execution; reuse sealed sample read-only and distinguish runner error/timeout from quality. | L3, L4 | [raw-runs.test.ts](../packages/db/src/raw-runs.test.ts): “refuses to reuse an id whose lineage or any snapshot differs”, immutable artifact manifest; [run.test.ts](../packages/cli/src/commands/run.test.ts): “persists a completed raw run and resumes the same sample read-only”. | Covered |
| REQ-010 | SHOULD | [Spec 032](../000-docs/032-AT-SPEC-named-graders-snapshots-regrade-2026-08-01.md): `grade` snapshots named graders immutably, requires intentional regrade, refuses incomplete runs and retains sampled disagreement. | L3, L4 | [grade.test.ts](../packages/cli/src/commands/grade.test.ts): “grades a raw Run and keeps a regrade as a second immutable snapshot”, “does not store a quality Grade for a dead judge and allows a healthy retry”; [grades.test.ts](../packages/db/src/grades.test.ts). Model judge is injected, not a live service. | Covered |
| REQ-011 | SHOULD | [Spec 033](../000-docs/033-AT-SPEC-balanced-sampling-uncertainty-2026-08-01.md): balanced target-N top-ups reserve active samples, replace failed ones, compute per-cell Wilson uncertainty and do not mix grader snapshots. | L3, L4 | [substrate.test.ts](../packages/core/src/sampling/substrate.test.ts): “tops up completed runs, reserves active runs, and replaces failures”, “refuses to mix a different grader snapshot”; [sample-plan.test.ts](../packages/cli/src/commands/sample-plan.test.ts). | Covered |
| REQ-012 | SHOULD | [Spec 036](../000-docs/036-AT-SPEC-eval-suite-lifecycle-2026-08-01.md): `suite` executes the manifest matrix, resumes without duplicate work, retains ungraded failures and writes suite-scoped audit/report artifacts. | L4 | [suite.test.ts](../packages/cli/src/commands/suite.test.ts): “executes a balanced two-task/two-config target and resumes without duplicate work”, “retains runner failures as ungraded observations and leaves a top-up pending”. Uses real local harness children, SQLite and report files through the command function. | Covered |
| REQ-013 | SHOULD | [Decision 044](../000-docs/044-AT-DECR-suite-replaces-batch-2026-10-05.md): deprecated `batch` continues to work with notice; `suite` is the supported generic lifecycle. | L4 | [batch.test.ts](../packages/cli/src/commands/batch.test.ts): “prints the deprecation notice on stderr before doing anything” and resume assertions. Future removal in the subsequent release is not claimed complete. | Covered |
| REQ-014 | SHOULD | [Specs 034](../000-docs/034-AT-SPEC-unified-report-json-markdown-2026-08-01.md) and [038](../000-docs/038-AT-SPEC-unified-report-html-static-2026-08-02.md): reports select a full grader identity, preserve per-cell lineage/no-data, escape static HTML and invent no global pass rate. | L3, L4 | [report/substrate.test.ts](../packages/core/src/report/substrate.test.ts): “renders a no-data-safe Markdown projection without an aggregate pass rate”, “renders escaped, self-contained accessible HTML for a populated report”; [report.test.ts](../packages/cli/src/commands/report.test.ts). Accessibility assertions inspect markup; no rendered browser or assistive-technology exercise is mapped. | Partial |
| REQ-015 | SHOULD | [Spec 041](../000-docs/041-AT-SPEC-eval-report-live-serve-2026-08-02.md): local report server restricts binds and routes, rejects foreign Host headers, and shuts down on signals. | L4 | [report-server.test.ts](../packages/cli/src/lib/report-server.test.ts): “supports a configured port and rejects non-loopback binds”, “rejects a foreign Host header so a DNS-rebinding page cannot read the report”, “closes cleanly when the operator sends SIGINT”. Real loopback HTTP, not remote publication. | Covered |
| REQ-016 | SHOULD | [Specs 035](../000-docs/035-AT-SPEC-eval-batch-skills-root-2026-08-01.md) and [039](../000-docs/039-AT-SPEC-eval-batch-report-projection-2026-08-02.md): `eval-batch` discovers deterministically, scaffolds missing baselines without default source edits, preserves per-skill failures/lineage and emits reports. | L3, L4 | [eval-batch.test.ts](../packages/cli/src/commands/eval-batch.test.ts): discovery/lineage, failed-skill continuation, byte-identical reused specs; [batch report tests](../packages/core/src/report/batch.test.ts). Child evaluator is injected, so a real multi-skill provider campaign is outside this evidence. | Covered |
| REQ-017 | SHOULD | [Spec 042](../000-docs/042-AT-SPEC-skill-promotion-evidence-2026-08-02.md): promotion binds snapshots/identities and requires executed regression evidence; skipped regression is advisory and infrastructure errors cannot promote. | L3, L4, L6 | [skill-promotion.test.ts](../packages/core/src/evidence/skill-promotion.test.ts): “downgrades a skipped regression layer to advisory instead of claiming pass”, “rejects an enabled comparison without a content-addressed baseline”; [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts). | Covered |
| REQ-018 | SHOULD | [Spec 043](../000-docs/043-AT-SPEC-eval-headroom-saturation-signal-2026-09-29.md): headroom measures the eval, remains advisory and appears per cell/model without changing gate authority. | L3, L4 | [headroom.test.ts](../packages/core/src/governance/headroom.test.ts), [eval-headroom.test.ts](../packages/cli/src/commands/eval-headroom.test.ts), [report/substrate.test.ts](../packages/core/src/report/substrate.test.ts): “distinguishes near_ceiling from headroom per cell, never rolled up”. | Covered |
| REQ-019 | SHOULD | [CLAUDE: execution provider](../CLAUDE.md#claude-code-execution-provider-trajectory-grading): subscription-only Claude Code execution refuses CI/API-key billing, scopes environment and refuses grading of truncated trajectories. | L3, L4 | [claude-code.test.ts](../packages/cli/src/providers/claude-code.test.ts): “refuses to construct under CI”, “aborts a run whose init reports an API key source”, turn-budget and process-group tests; [trajectory-checks.test.ts](../packages/core/src/checks/trajectory-checks.test.ts): “refuses a truncated trajectory, so a budget-cut run cannot pass tool_not_called”. Recorded transcripts/fake executable verify the adapter, not current vendor behavior or OS isolation. | Covered |
| REQ-020 | SHOULD | [Spec 046](../000-docs/046-AT-SPEC-structured-deterministic-checks-2026-10-08.md): structured checks validate typed parameters and observed JSON/files/exit codes, fail closed without observations and preserve saved snapshot compatibility. | L3, L4 | [structured-checks.test.ts](../packages/core/src/checks/structured-checks.test.ts): “rejects bad paths, modes, regexes, digests and schemas before any spend”; [grade.test.ts](../packages/cli/src/commands/grade.test.ts): “grades a command Run's exit code and stdout JSON with structured checks”. | Covered |
| REQ-021 | SHOULD | [CLI MCP correlation contract](../packages/cli/README.md): fresh sessions retain distinct identity, explicit tools/environment, bounded output/turns and redacted observation copies. | L3, L4 | [mcp-runtime.test.ts](../packages/cli/src/execution/mcp-runtime.test.ts): “generates a fresh correlation identity per session and overrides ambient substitution”, “refuses an unallowed tool before any effect”, “executes every call, preserves wire correlation, scopes env and closes a real server”. Local stdio fixture plus injected model transport; identity is correlation, not authentication. | Covered |
| REQ-022 | SHOULD | [README: one change at a time](../README.md#non-negotiable-design-principles): optimizer proposes one atomic change, prioritizes blockers/sacred failures and rejects regressions. | L3 | [optimizer.test.ts](../packages/core/src/optimizer/optimizer.test.ts): weakest/blocker selection and “rejects when target passes but another regresses”. A proposal has one target field; no assertion proves semantic atomicity of arbitrary proposed text. [apply.test.ts](../packages/refiner-core/src/apply.test.ts) explicitly supports multiple edit operations. | Partial |
| REQ-023 | SHOULD | [Refiner-core acceptance](../packages/refiner-core/README.md#the-acceptance-gate-dr-028-p0-ratify-1): strict behavioral gain with significant non-regression on every named dimension and comparable eval sets. | L3 | [accept.test.ts](../packages/refiner-core/src/accept.test.ts): “REJECTS pareto-incomparable: behavioral up BUT another dim regresses (the tie-break)”, dropped dimension, distinct eval sets and significance cases. These prove deterministic decision arithmetic for fixtures, not empirical validity of the chosen statistical model. | Covered |
| REQ-024 | SHOULD | [Refiner-core value model](../packages/refiner-core/README.md#what-this-foundation-ships): bounded edits are content-addressed new values; mismatched parents and missing/ambiguous anchors refuse. | L3 | [apply.test.ts](../packages/refiner-core/src/apply.test.ts): “applies a replace op and returns a NEW doc with a new hash (append-only)”, parent/anchor rejection cases; [hash.test.ts](../packages/refiner-core/src/hash.test.ts). | Covered |
| REQ-025 | SHOULD | [Refiner store](../packages/refiner/README.md): content-addressed values, append-only events, one mutable best pointer. | L3 | [store.test.ts](../packages/refiner/src/store.test.ts): deduplicated content addressing, “refuses to point best at an un-stored hash”, append-order/newline assertions. Filesystem is an in-memory seam; crash consistency, concurrent writers and durable on-disk recovery are unverified. | Partial |
| REQ-026 | SHOULD | [Refiner CLI](../packages/refiner/README.md#cli): bootstrap/apply/status operate offline; score delegates to the evaluator and propose uses the strategy/provider boundary. | L3, L4 | [cli.test.ts](../packages/refiner/src/cli.test.ts): persisted bootstrap and immutable apply; [score.test.ts](../packages/refiner/src/score.test.ts): “DELEGATES: invokes the runner with skillDir + --json + the tier model”; [propose.test.ts](../packages/refiner/src/propose.test.ts): mocked strategy/client. No real provider score→proposal→accept→store loop is established here; the README's historical five-command/provider wording is stale relative to tests. | Partial |
| REQ-027 | SHOULD | [Refiner-core slice utility](../packages/refiner-core/README.md#per-block-slice-utility--computed-not-a-constant-epic-intent-eval-lab206): compute first-order block ablation utility, gate stale/unverified sets, distinguish insufficient power and avoid a rolled skill score. | L3 | [slice-utility.test.ts](../packages/refiner-core/src/slice-utility.test.ts): `gateEvalSet`, computed-per-block, schema-required and capped-mode assertions with injected scorers. No claim of higher-order interaction measurement. | Covered |
| REQ-028 | SHOULD | [README: skill scoring](../README.md#skill-scoring--adoption-signal--intake-verbs): CASS-failing usage persists but is excluded, tenant buckets stay distinct and review remains curated signal. | L3, L4 | [skill-signals.test.ts](../packages/cli/src/commands/skill-signals.test.ts): “persists a FAILING (gamed) usage row but EXCLUDES it from the verified count”, curated thumb and tenant tests; [DB skill-signals.test.ts](../packages/db/src/skill-signals.test.ts). | Covered |
| REQ-029 | SHOULD | [README: adoption verdict](../README.md#skill-scoring--adoption-signal--intake-verbs): deterministic time decay uses an injected clock, source/tenant segregation and advisory-only provisional thresholds. | L3 | [adoption.test.ts](../packages/refiner-core/src/adoption.test.ts): identical-input determinism, injected timestamp, half-life, source/tenant separation and provisional defaults. No real soak-window back-test or calibrated-threshold claim is established. | Covered |
| REQ-030 | SHOULD | [Rollout-gate contract](../packages/rollout-gate/README.md#fail-closed-semantics): all required gates must pass; malformed/empty/schema-invalid evidence or invalid policy blocks; v1/v2 forms agree. | L3 | [decide.test.ts](../packages/rollout-gate/src/decide.test.ts): missing/non-passing gates, schema/empty/policy rejection, forbidden outcomes and wire-form parity; [policy.test.ts](../packages/rollout-gate/src/policy.test.ts). Signature verification belongs to the consuming boundary and is not provided by this pure decision library. | Covered |
| REQ-031 | SHOULD | [MIGRATION](../MIGRATION.md): migration produces kernel-valid v2 statements and explicit NOT_APPLICABLE routing without silently converting a non-verdict to passing evidence. | L3, L4 | [roundtrip.test.ts](../packages/migrate/src/roundtrip.test.ts): pass/fail/NOT_APPLICABLE rows validate with the kernel; [transform.test.ts](../packages/migrate/src/transform.test.ts), [codemod.test.ts](../packages/migrate/src/codemod.test.ts), [migrate.test.ts](../packages/cli/src/commands/migrate.test.ts). | Covered |
| REQ-032 | SHOULD | [PR-comment public contract](../packages/pr-comment/src/index.ts): pure idempotent rendering uses stable markers for host find-or-update behavior and safe Markdown. | L3 | [render.test.ts](../packages/pr-comment/src/render.test.ts): byte-identical rendering, marker selection, newline/pipe/backtick escaping; [compat.test.ts](../packages/pr-comment/src/compat.test.ts). No GitHub write occurs: remote idempotent updating is the host's responsibility. | Covered |
| REQ-033 | SHOULD | [Spec 048](../000-docs/048-AT-SPEC-canonical-dashboard-evidence-2026-10-12.md): canonical payload hashes bind the complete array, projections and source identities; publication requires real signature verification and consumer ingest. | L3, L4 | [canonical-payload.test.ts](../scripts/canonical-payload.test.ts): shared bytes under both kernel versions, changed payload/metadata rejection and missing signature-file refusal. These synthetic unsigned fixtures do not exercise real signing, Rekor verification, dashboard ingest or live publication. This is a local automated-test coverage limit, not a claim that operational verification has never occurred; hosted receipts are assessed separately in the audit report. | Partial |
| REQ-034 | SHOULD | [Dashboard README](../packages/dashboard/README.md): team dashboard remains an explicitly declared Epic 10 placeholder. | — | Package has README/package.json and no source tests. The future team UI is unverified in this workspace; the separate intent-eval-dashboard repository is outside this inventory. This row does not declare a currently shipped feature defective. | Unverified |
| REQ-035 | SHOULD | [CLI package contract](../packages/cli/package.json): published `j-rig` is installable with private engine dependencies bundled and documented third-party licensing. | — | No clean packed-consumer install test is identified in the 123-file Vitest inventory. Built-executable tests establish local execution. This is an automation/traceability gap in this inventory, not a finding that the CLI is uninstallable or that release-preparation consumer checks and publication provenance are absent; operational receipts are assessed separately. | Unverified |

## Inventory and remaining traceability work

The configured Vitest source inventory at the baseline contains **123 test
files**: 118 beneath package `src/`, two beneath `tests/`, and three beneath
`scripts/`. Package counts are CLI 40, core 45, dashboard 0, DB 5, migrate 4,
PR-comment 2, refiner 6, refiner-core 14 and rollout-gate 2. These are file counts,
not assertion counts or run results. They exclude standalone JavaScript shell
checks, CI shell steps, downstream repositories and live experiments.

The matrix has **35 requirements: 26 covered, 7 partial, 2 unverified**. All 35
have inferred SHOULD priority; MUST/COULD/WON'T counts are zero. There is no
approved RTM coverage floor. These counts describe this bounded extraction and
must not be reported as whole-product requirement coverage.

All 123 files lack an inline `REQ-NNN` association at the baseline. The matrix
provides sidecar associations for a subset; files not mapped in this scoped
catalog are listed below. They are **not proven orphan tests**: the historical
requirements have not been exhaustively extracted, and lacking an inline ID
does not mean a test lacks an authored requirement. The exhaustive orphan count
is therefore undetermined. Filling the remaining links requires extracting the
corresponding authored requirements, not adding tests that mirror implementation.

**Sidecar-associated: 53 files; not mapped in this scoped catalog: 70 files.**

- [`packages/cli/src/commands/emit-evidence.test.ts`](../packages/cli/src/commands/emit-evidence.test.ts)
- [`packages/cli/src/commands/emit-refiner-pass.test.ts`](../packages/cli/src/commands/emit-refiner-pass.test.ts)
- [`packages/cli/src/commands/eval-mcp.e2e.test.ts`](../packages/cli/src/commands/eval-mcp.e2e.test.ts)
- [`packages/cli/src/commands/parse-agents.test.ts`](../packages/cli/src/commands/parse-agents.test.ts)
- [`packages/cli/src/commands/scaffold-spec.test.ts`](../packages/cli/src/commands/scaffold-spec.test.ts)
- [`packages/cli/src/execution/evidence.test.ts`](../packages/cli/src/execution/evidence.test.ts)
- [`packages/cli/src/execution/observation-redaction.test.ts`](../packages/cli/src/execution/observation-redaction.test.ts)
- [`packages/cli/src/index.test.ts`](../packages/cli/src/index.test.ts)
- [`packages/cli/src/lib/spec-draft.test.ts`](../packages/cli/src/lib/spec-draft.test.ts)
- [`packages/cli/src/providers/anthropic-real.test.ts`](../packages/cli/src/providers/anthropic-real.test.ts)
- [`packages/cli/src/providers/anthropic.test.ts`](../packages/cli/src/providers/anthropic.test.ts)
- [`packages/cli/src/providers/claude-code-stream.test.ts`](../packages/cli/src/providers/claude-code-stream.test.ts)
- [`packages/cli/src/providers/cost-tracking.test.ts`](../packages/cli/src/providers/cost-tracking.test.ts)
- [`packages/cli/src/providers/judge-observations.test.ts`](../packages/cli/src/providers/judge-observations.test.ts)
- [`packages/cli/src/providers/litellm.test.ts`](../packages/cli/src/providers/litellm.test.ts)
- [`packages/cli/src/providers/minimax-plan.test.ts`](../packages/cli/src/providers/minimax-plan.test.ts)
- [`packages/cli/src/providers/openai-compatible.test.ts`](../packages/cli/src/providers/openai-compatible.test.ts)
- [`packages/cli/src/providers/openai.test.ts`](../packages/cli/src/providers/openai.test.ts)
- [`packages/cli/src/providers/transport.test.ts`](../packages/cli/src/providers/transport.test.ts)
- [`packages/cli/src/providers/vercel-ai.test.ts`](../packages/cli/src/providers/vercel-ai.test.ts)
- [`packages/cli/src/providers/verdict.test.ts`](../packages/cli/src/providers/verdict.test.ts)
- [`packages/core/src/checks/deterministic-registry.test.ts`](../packages/core/src/checks/deterministic-registry.test.ts)
- [`packages/core/src/drift/drift.test.ts`](../packages/core/src/drift/drift.test.ts)
- [`packages/core/src/evidence/reader.test.ts`](../packages/core/src/evidence/reader.test.ts)
- [`packages/core/src/evidence/writer.test.ts`](../packages/core/src/evidence/writer.test.ts)
- [`packages/core/src/execution/execution.test.ts`](../packages/core/src/execution/execution.test.ts)
- [`packages/core/src/execution/self-test.test.ts`](../packages/core/src/execution/self-test.test.ts)
- [`packages/core/src/governance/spec-sources.test.ts`](../packages/core/src/governance/spec-sources.test.ts)
- [`packages/core/src/grading/substrate.test.ts`](../packages/core/src/grading/substrate.test.ts)
- [`packages/core/src/index.test.ts`](../packages/core/src/index.test.ts)
- [`packages/core/src/intentional-mapping/mm-1-async-race.test.ts`](../packages/core/src/intentional-mapping/mm-1-async-race.test.ts)
- [`packages/core/src/intentional-mapping/mm-2-through-6.test.ts`](../packages/core/src/intentional-mapping/mm-2-through-6.test.ts)
- [`packages/core/src/judgment/criteria-selection.test.ts`](../packages/core/src/judgment/criteria-selection.test.ts)
- [`packages/core/src/judgment/redact.test.ts`](../packages/core/src/judgment/redact.test.ts)
- [`packages/core/src/otel/emitter.test.ts`](../packages/core/src/otel/emitter.test.ts)
- [`packages/core/src/otel/events.test.ts`](../packages/core/src/otel/events.test.ts)
- [`packages/core/src/otel/names.test.ts`](../packages/core/src/otel/names.test.ts)
- [`packages/core/src/otel/uuid.test.ts`](../packages/core/src/otel/uuid.test.ts)
- [`packages/core/src/parsers/agents-md-parser.test.ts`](../packages/core/src/parsers/agents-md-parser.test.ts)
- [`packages/core/src/parsers/skill-parser.test.ts`](../packages/core/src/parsers/skill-parser.test.ts)
- [`packages/core/src/parsers/yaml-parser.test.ts`](../packages/core/src/parsers/yaml-parser.test.ts)
- [`packages/core/src/providers/ciso-gates/g1-credential-redaction.test.ts`](../packages/core/src/providers/ciso-gates/g1-credential-redaction.test.ts)
- [`packages/core/src/providers/ciso-gates/g2-env-var-spillover.test.ts`](../packages/core/src/providers/ciso-gates/g2-env-var-spillover.test.ts)
- [`packages/core/src/providers/eval-cases/eval-cases.test.ts`](../packages/core/src/providers/eval-cases/eval-cases.test.ts)
- [`packages/core/src/providers/score-card/score-card.test.ts`](../packages/core/src/providers/score-card/score-card.test.ts)
- [`packages/core/src/providers/types.test.ts`](../packages/core/src/providers/types.test.ts)
- [`packages/core/src/schemas/eval-contract.test.ts`](../packages/core/src/schemas/eval-contract.test.ts)
- [`packages/core/src/schemas/evidence-bundle.kernel-shadow.test.ts`](../packages/core/src/schemas/evidence-bundle.kernel-shadow.test.ts)
- [`packages/core/src/schemas/evidence-bundle.test.ts`](../packages/core/src/schemas/evidence-bundle.test.ts)
- [`packages/core/src/schemas/skill-eval-spec-adapter.test.ts`](../packages/core/src/schemas/skill-eval-spec-adapter.test.ts)
- [`packages/core/src/schemas/skill-eval-spec.test.ts`](../packages/core/src/schemas/skill-eval-spec.test.ts)
- [`packages/core/src/schemas/skill-frontmatter.kernel-shadow.test.ts`](../packages/core/src/schemas/skill-frontmatter.kernel-shadow.test.ts)
- [`packages/db/src/index.test.ts`](../packages/db/src/index.test.ts)
- [`packages/db/src/sampling.test.ts`](../packages/db/src/sampling.test.ts)
- [`packages/migrate/src/fs.test.ts`](../packages/migrate/src/fs.test.ts)
- [`packages/refiner/src/providers.test.ts`](../packages/refiner/src/providers.test.ts)
- [`packages/refiner/src/report-render.test.ts`](../packages/refiner/src/report-render.test.ts)
- [`packages/refiner-core/src/bootstrap.test.ts`](../packages/refiner-core/src/bootstrap.test.ts)
- [`packages/refiner-core/src/cost.test.ts`](../packages/refiner-core/src/cost.test.ts)
- [`packages/refiner-core/src/decide.test.ts`](../packages/refiner-core/src/decide.test.ts)
- [`packages/refiner-core/src/eval-set-metrics.test.ts`](../packages/refiner-core/src/eval-set-metrics.test.ts)
- [`packages/refiner-core/src/eval-set.test.ts`](../packages/refiner-core/src/eval-set.test.ts)
- [`packages/refiner-core/src/judge-version.test.ts`](../packages/refiner-core/src/judge-version.test.ts)
- [`packages/refiner-core/src/kernel-version.test.ts`](../packages/refiner-core/src/kernel-version.test.ts)
- [`packages/refiner-core/src/strategies/ops.test.ts`](../packages/refiner-core/src/strategies/ops.test.ts)
- [`packages/refiner-core/src/strategies/strategies.test.ts`](../packages/refiner-core/src/strategies/strategies.test.ts)
- [`scripts/emit-evidence.test.ts`](../scripts/emit-evidence.test.ts)
- [`scripts/license-audit.test.ts`](../scripts/license-audit.test.ts)
- [`tests/eval-roster.test.ts`](../tests/eval-roster.test.ts)
- [`tests/smoke.test.ts`](../tests/smoke.test.ts)

Priority review should address the partial/unverified rows explicitly before
treating them as release gates. Particularly consequential limits are semantic
single-change enforcement (REQ-022), durable/concurrent refiner storage
(REQ-025), complete provider-backed refinement (REQ-026), repeatable automated coverage of cryptographic
publication and downstream ingest (REQ-033), and clean packed CLI installation
(REQ-035). These local-test gaps do not negate separately recorded operational
verification. This audit neither runs a funded provider experiment nor changes any
of those boundaries.
