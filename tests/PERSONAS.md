# Persona coverage observations — J-Rig

Audited source: `e3119f41ffce449844c6320b3d97eef777a9ba20` (2026-10-19).
This is an observational mapping for bead `bd_000-projects-0s9t`, not a new
persona, access-control, acceptance, or threshold policy.

## Scope and denominator

There was no engineer-owned `tests/PERSONAS.md` or persona threshold declaration
at the audited revision: **formally declared personas: 0; threshold result:
not evaluated**. The CLI/library classification makes a declared persona matrix
optional. No default percentage is installed as repository policy by this audit.

The root [README](../README.md) names skill authors, pack maintainers and
enterprise skill library operators in its W5 table. Its generic task/config,
suite, Grader and reporting sections also describe an experiment-operator
workflow. The four roles below are analyst groupings of those documented
surfaces; they grant no permissions and declare no criticality or MoSCoW tier.

The denominator is **12 selected flows listed below**, not every command,
permission, user, platform integration, or documented promise. A linked test
means relevant assertions exist in source; it does not mean the entire flow is
covered or that this document independently ran the test. Eleven flows have
local test evidence; one is a documented dashboard placeholder. No universal
persona coverage percentage follows from that count. Test execution and layer
classification belong to the accompanying audit report.

## Observed role: skill author / Refiner user

Source: README W5 and package-integrity/evaluation sections;
[CLI usage](../packages/cli/README.md) and
[Refiner CLI](../packages/refiner/README.md).
Observed capabilities: supply a skill/spec, evaluate it, propose and apply edits
using the invoking user's local files and explicitly configured provider.
These are capabilities described by the product, not enforced RBAC permissions.

| Selected flow | Representative assertion evidence | Negative/error evidence and limits |
| --- | --- | --- |
| Scaffold and review an eval spec | [scaffold-spec.test.ts](../packages/cli/src/commands/scaffold-spec.test.ts) validates the generated spec and scopes control/adversarial cases. | [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts) spawns the built CLI and asserts exit 1 plus the `needs-review` refusal. This proves the flag boundary, not the quality of a human review or a model-authored spec. |
| Evaluate a skill and inspect evidence | [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts) exercises the built CLI, bundle schema and provider-failure exit/evidence behavior. | The dead-judge case asserts exit 2, `error` rows and credential-free reasons. [eval-budget.e2e.test.ts](../packages/cli/src/commands/eval-budget.e2e.test.ts) covers exit 3/no-verdict budget stops and stricter budget selection. Stub and local fixture behavior is not live-model ground truth. |
| Refine, score and apply a bounded proposal | [refiner cli.test.ts](../packages/refiner/src/cli.test.ts) bootstraps and applies a stored proposal, asserting two immutable document records. [score.test.ts](../packages/refiner/src/score.test.ts) checks delegated evaluator arguments and score/hash mapping. | [apply.test.ts](../packages/refiner-core/src/apply.test.ts) rejects stale parents and absent/ambiguous anchors; [accept.test.ts](../packages/refiner-core/src/accept.test.ts) rejects behavioral non-improvement and other-dimension regressions. Evaluator/model seams are injected; these tests do not establish one continuous live propose-score-accept lifecycle. |

Evidence presence: 3/3 selected flows. Remaining boundary: live provider
semantics, human spec approval and a single end-to-end refinement lifecycle are
not established by these links.

## Observed role: skill pack maintainer / gate integrator

Source: README W5, sacred-regression and evidence-backed rollout sections;
[rollout-gate API](../packages/rollout-gate/README.md),
[roster operations](../eval-roster/README.md), and the `pr-comment` package.
Observed capabilities: configure baselines/policy, run a pinned roster and
consume decisions in a review workflow. No repository merge permission is
inferred from these capabilities.

| Selected flow | Representative assertion evidence | Negative/error evidence and limits |
| --- | --- | --- |
| Compare regression and naked-model baselines | [eval-baseline-regression.test.ts](../packages/cli/src/commands/eval-baseline-regression.test.ts) composes baseline loading, regression detection, scorecard and rollout decision; a sacred regression yields `block`, matched naked baseline yields `obsolete_review`. | Invalid/unreadable baseline files throw. This is local function composition with fixture judgments, not a live paired experiment. |
| Consume evidence through fail-closed policy | [decide.test.ts](../packages/rollout-gate/src/decide.test.ts) asserts `allow` and required-gate row details for valid evidence. | Missing gates, malformed/empty bundles, invalid policies, error rows and stub/false-ground-truth markers block. This library test does not verify a Sigstore identity, GitHub required checks or an actual protected-branch merge. |
| Render and locate an idempotent PR comment | [render.test.ts](../packages/pr-comment/src/render.test.ts) checks byte-identical rendering, marker lookup, allow/block summaries and table contents. | Invalid marker keys and row limits reject; text escaping is asserted. GitHub API posting, token permissions and update races are outside this pure-renderer evidence. |
| Operate the nightly roster | [eval-roster.test.ts](eval-roster.test.ts) checks class-first error carry-through, headroom parsing, workflow timeout capacity and the MiniMax execution-budget default. | Non-error/unclassified bundles are refused by the error helper; explicit budgets and other-provider settings are preserved. These assertions do not run a hosted schedule or prove signing/upload/dashboard ingestion. |

Evidence presence: 4/4 selected flows. The hosted deployment and trust chain
are partial or external boundaries, not covered merely because helper tests
exist. No provider request or workflow dispatch was performed for this mapping.

## Observed role: experiment operator

Source: README generic task/config runs, named Graders, balanced sampling,
unified report and generic suite lifecycle sections.
Observed capabilities: execute a configured local harness, retain observations,
select immutable Grader snapshots and inspect local reports.

| Selected flow | Representative assertion evidence | Negative/error evidence and limits |
| --- | --- | --- |
| Execute and resume a balanced suite | [suite.test.ts](../packages/cli/src/commands/suite.test.ts) uses real local fixture child processes and SQLite; asserts four cells/eight jobs and identical raw Run IDs after resume. [run.test.ts](../packages/cli/src/commands/run.test.ts) checks sealed-run reuse. | Suite failures remain ungraded, with pending top-ups; invalid manifests/configs, corrupt resume audits and timeouts have failure assertions. These are small deterministic local suites, not representative provider throughput or scale measurements. |
| Grade and intentionally regrade observations | [grade.test.ts](../packages/cli/src/commands/grade.test.ts) persists a second immutable version and proves saved-model-Grade reuse without additional judge calls. | Changed snapshots require regrade; dead judges do not store a quality Grade, and incomplete/missing Runs reject. Model judges are injected or stubbed, so this does not validate external model judgment quality. |
| Inspect and serve the selected report | [report.test.ts](../packages/cli/src/commands/report.test.ts) asserts selected lineage, JSON/Markdown/HTML and uncertainty/count fields. [report-server.test.ts](../packages/cli/src/lib/report-server.test.ts) exercises a local HTTP server and health endpoint. | Non-loopback binds and foreign Host headers reject; SIGINT closes the server. No browser interaction, visual/accessibility journey or signed dashboard publication is proven here; output remains local and unsigned. |

Evidence presence: 3/3 selected flows, including real local persistence/process
and HTTP boundaries. Browser behavior and hosted provider operation remain
outside the selected evidence.

## Observed role: skill library operator

Source: README W5 and skill-scoring/intake sections;
[dashboard package status](../packages/dashboard/README.md).
Observed capabilities: record usage/review signals and consume reporting. The
README says review is a curated signal rather than a signed human trust root.

| Selected flow | Representative assertion evidence | Negative/error evidence and limits |
| --- | --- | --- |
| Record usage and curated reviews | [skill-signals.test.ts](../packages/cli/src/commands/skill-signals.test.ts) invokes registered CLI commands against scratch SQLite and verifies passing usage is counted. | A failing/gamed usage row is persisted but excluded from verified counts; invalid source values reject. These tests establish intake behavior, not identity proof, independent human review or organizational authorization. |
| Use the in-repository team dashboard | No implemented dashboard journey test identified; [packages/dashboard/README.md](../packages/dashboard/README.md) explicitly calls the package a placeholder. | Missing implemented surface and behavioral coverage. This is a scope gap against the root README's future team-dashboard role, not evidence that the separate Intent Eval Dashboard repository lacks tests. |

Evidence presence: 1/2 selected flows. The dashboard placeholder prevents a
claim that this role's selected reporting surface is implemented and tested.

## Interpretation

No role-specific authentication model or signed human-approval authority was
declared by these source documents, so this audit invents neither permission
matrices nor authorization-test expectations. The concrete gaps are the
placeholder dashboard and the explicitly limited live, hosted, browser and
cross-system boundaries above. Engineer-owned persona declarations and chosen
critical flows would be needed before calculating policy compliance.
