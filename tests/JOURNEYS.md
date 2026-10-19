# Journey coverage observations — J-Rig

Audited revision: `e3119f41ffce449844c6320b3d97eef777a9ba20` (2026-10-19),
bead `bd_000-projects-0s9t`. This file maps selected documented workflows to
assertions in committed test source. It does not authorize provider spending,
workflow dispatch, publication, promotion or an authority change.

## Method and denominator

No engineer-owned journey declarations or journey thresholds existed at the
audited revision. **Declared journeys: 0; policy threshold evaluation: not
applicable.** The five journeys below are observational selections from the
[README](../README.md), package documentation and roster workflow. They are
not exhaustive and have no newly assigned criticality or acceptance policy.
Roles correspond to the observational groups in [PERSONAS.md](PERSONAS.md).

The denominator is the **23 numbered steps below**. Evidence status:

- **Local:** relevant assertions exercise the stated local boundary (including
  real fixture processes, SQLite or loopback HTTP where specified).
- **Partial:** tests exercise functions, stubs or injected seams but do not
  establish the whole named operation across its external boundaries.
- **Unverified:** no test or live execution evidence was inspected that proves
  the stated step. A workflow definition alone is not execution evidence.
- **Placeholder:** the documented product surface is not implemented here.

Counts: **12 Local, 6 Partial, 4 Unverified, 1 Placeholder**. All five journeys
have a partial or unverified boundary; none is claimed fully covered end to
end. These statuses are source observations, not fresh test results. Layer
labels use the audit taxonomy: L3 unit, L4 integration, L6 user-flow/CLI end to
end. A `.e2e.test.ts` filename alone does not establish live external coverage.

## J1 — Author a skill and evaluate it for review

Role: skill author → pack maintainer.
Trigger: a new or changed skill requires a spec and an evidence-backed decision.
Linked [RTM](RTM.md): REQ-002, REQ-005–007, REQ-017, REQ-030, REQ-032.
Sources: README evaluation/coverage-honesty sections and
[CLI usage](../packages/cli/README.md).

| Step | Operation | Layer and evidence | Status and stop condition |
| --- | --- | --- | --- |
| 1 | Scaffold a baseline spec with correctly scoped cases. | L3: [scaffold-spec.test.ts](../packages/cli/src/commands/scaffold-spec.test.ts) validates generated schema, control-case scope and adversarial execution scope. | **Local:** generation assertions; invalid names/control scope are explicitly handled. |
| 2 | Human reviews proposed criteria and clears the review requirement. | L6 local CLI: [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts) asserts `--require-reviewed` rejects `needs-review` with exit 1. | **Partial:** refusal is tested; the human's semantic review and removal of tags are not mechanically established. Stop while review is required. |
| 3 | Execute and judge the skill with the chosen provider. | L6 built CLI with stub plus local HTTP fixtures: [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts), [eval-budget.e2e.test.ts](../packages/cli/src/commands/eval-budget.e2e.test.ts). | **Partial:** real CLI/process/DB paths, synthetic provider responses. Dead judge exits 2 with error evidence; budget exhaustion exits 3 without verdict/bundle and records `failed`. No external model quality claim. |
| 4 | Emit consumable evidence and apply rollout policy. | L6 CLI emission plus L3 library: [eval.e2e.test.ts](../packages/cli/src/commands/eval.e2e.test.ts), [decide.test.ts](../packages/rollout-gate/src/decide.test.ts). | **Partial:** emission and decision assertions are separate seams, not one authenticated promotion test. Malformed/missing/error/stub evidence blocks by policy; schema-valid output alone does not prove cryptographic authenticity. |
| 5 | Render a stable review comment. | L3: [render.test.ts](../packages/pr-comment/src/render.test.ts) proves byte-identical rendering, marker discovery, reason escaping and allow/block content. | **Local:** rendering only. Invalid marker keys reject. Posting/updating a real GitHub comment is outside this step and unverified by these tests. |

Evidence distribution: 2 Local, 3 Partial. The mapped tests support local
review preparation; they do not prove human approval or live promotion.

## J2 — Run, resume and inspect a generic evaluation suite

Role: experiment operator.
Trigger: a Task × Config manifest and named Grader are ready for measurement.
Linked [RTM](RTM.md): REQ-008–012, REQ-014–015.
Sources: README generic runs, named Graders, balanced sampling, suite lifecycle
and unified report sections.

| Step | Operation | Layer and evidence | Status and stop condition |
| --- | --- | --- | --- |
| 1 | Validate the manifest and run balanced fixture jobs. | L4: [suite.test.ts](../packages/cli/src/commands/suite.test.ts) asserts four cells/eight completed jobs, real local child processes and SQLite. | **Local:** invalid manifest paths, duplicate identities and invalid/non-positive targets reject. Provider throughput is outside the fixture claim. |
| 2 | Persist grades and retain immutable snapshots when regrading. | L4: [grade.test.ts](../packages/cli/src/commands/grade.test.ts) checks second immutable Grade, saved-Grade reuse and snapshot-change policy. | **Local:** incomplete/missing Runs and invalid graders refuse; dead injected judge stores no quality Grade. No claim that an injected judge measures external model quality. |
| 3 | Resume without duplicate work; retain failures for top-up. | L4: [suite.test.ts](../packages/cli/src/commands/suite.test.ts) asserts identical raw Run IDs on resume, failed jobs without Grades, and pending top-up counts. | **Local:** corrupt or mismatched audits refuse; timeout stays a harness failure, not a quality Grade. |
| 4 | Render selected lineage and inspect the loopback report endpoint. | L4: [report.test.ts](../packages/cli/src/commands/report.test.ts) asserts JSON/Markdown/HTML and uncertainty counts; [report-server.test.ts](../packages/cli/src/lib/report-server.test.ts) fetches HTTP 200 report/health responses. | **Local:** wildcard bind and foreign Host headers reject, unknown routes return 404, injected SIGINT closes the server. HTML is unsigned local output. |
| 5 | Interpret the report in a browser, including no-data and accessibility behavior. | L3 renderer: [substrate.test.ts](../packages/core/src/report/substrate.test.ts) checks escaped HTML, labels and no-data text. | **Partial:** source/string assertions; no browser-driven interaction or accessibility-engine assertions were identified for this surface. |

Evidence distribution: 4 Local, 1 Partial. This is the strongest mapped local
lifecycle; browser behavior and arbitrary external harness semantics remain
outside the inspected assertions.

## J3 — Refine a skill while retaining provenance

Role: skill author / Refiner user.
Trigger: a skill improvement candidate should be bounded and measured.
Linked [RTM](RTM.md): REQ-023–026. Structural acceptance emission is an
additional observed seam; no extra RTM ID is invented here.
Sources: [Refiner documentation](../packages/refiner/README.md) and
[refiner-core documentation](../packages/refiner-core/README.md).

| Step | Operation | Layer and evidence | Status and stop condition |
| --- | --- | --- | --- |
| 1 | Bootstrap a held-out eval set and store the original document. | L4 command/store seam: [cli.test.ts](../packages/refiner/src/cli.test.ts) asserts bootstrap document/set persistence and status output. | **Local:** local fixture/store contract; not a claim that a synthetic eval set is scientifically sufficient. |
| 2 | Score the skill and request a bounded proposal. | L3 injected adapters: [score.test.ts](../packages/refiner/src/score.test.ts) checks evaluator arguments, hash anchoring and pass-rate mapping; [propose.test.ts](../packages/refiner/src/propose.test.ts) checks request/response translation. | **Partial:** injected runner/completion clients. Malformed evaluator output, nonzero exit, missing key and provider errors reject. Live provider semantics and spending are unverified here. |
| 3 | Apply the anchored edit and reject non-improving candidates. | L3/L4: [apply.test.ts](../packages/refiner-core/src/apply.test.ts), [accept.test.ts](../packages/refiner-core/src/accept.test.ts), [cli.test.ts](../packages/refiner/src/cli.test.ts). | **Local:** stale/ambiguous anchors reject, append-only versions are asserted, and behavioral/non-regression decisions are tested separately. This is not proof of one uninterrupted scoring-to-acceptance run. |
| 4 | Emit structural acceptance evidence. | L6 built CLI: [emit-refiner-pass.test.ts](../packages/cli/src/commands/emit-refiner-pass.test.ts) asserts predicate URI, determinant fields and kernel-valid Statement output from fixture accept records. | **Local:** missing determinants, malformed input and regressed accept records reject; structural emission only does not prove the supplied record came from a valid live experiment or carry a trusted signature. |
| 5 | Complete one live propose → evaluate → accept/reject lifecycle. | No single live lifecycle test was established by the inspected Refiner adapter/CLI suites. | **Unverified:** separate component tests cannot establish real-provider behavior or measured benefit. Human publication/promotion authority remains separate. |

Evidence distribution: 3 Local, 1 Partial, 1 Unverified. The component
assertions preserve local safety contracts; they do not demonstrate a measured
live improvement.

## J4 — Run the nightly roster and deliver trusted reporting

Role: pack maintainer / library operator.
Trigger: the scheduled roster evaluates a fixed source revision.
Linked [RTM](RTM.md): REQ-006, REQ-018, REQ-033–034.
Sources: [nightly workflow](../.github/workflows/nightly-skill-evals.yml),
[roster operations](../eval-roster/README.md), and
[dashboard package status](../packages/dashboard/README.md).

| Step | Operation | Layer and evidence | Status and stop condition |
| --- | --- | --- | --- |
| 1 | Prepare the pinned roster, run skills and classify outcomes. | L3/config assertions: [eval-roster.test.ts](eval-roster.test.ts) checks timeout budget, provider-specific settings, error-reason propagation and headroom extraction. | **Partial:** helper/config tests, not a hosted roster run. Non-classified/error-shape mismatches refuse propagation; provider failures remain no-verdict error evidence. |
| 2 | Bind canonical payload bytes and assemble the manifest. | L3/L4: [canonical-payload.test.ts](../scripts/canonical-payload.test.ts) exercises both nightly/release emitters and manifest assembly, checks source identity and byte hashes, and rejects altered payloads or missing signature files. | **Local:** synthetic unsigned fixtures; signature files contain `{}` as transport placeholders, not cryptographic verification. |
| 3 | Keyless-sign and verify each published bundle. | Workflow declares the cosign path; no live signing/verification receipt was inspected as part of this source mapping. | **Unverified:** workflow commands alone prove neither OIDC identity nor production Rekor verification. |
| 4 | Publish the manifest and ingest it through the external dashboard's trust boundary. | Workflow declares rolling release upload; the consuming dashboard is a separate repository. | **Unverified:** no current upload/ingest execution evidence inspected. Do not infer freshness or successful verification from a local row schema. |
| 5 | Use the in-repository team dashboard. | [packages/dashboard/README.md](../packages/dashboard/README.md) calls the package an Epic 10 placeholder. | **Placeholder:** no implemented journey to map. This does not describe the status of the separate Intent Eval Dashboard application. |

Evidence distribution: 1 Local, 1 Partial, 2 Unverified, 1 Placeholder. Historical live
receipts may exist elsewhere; this bounded source audit neither substitutes
for them nor declares they failed. No provider or workflow was run for this map.

## J5 — Record usage and review adoption evidence

Role: library operator.
Trigger: a skill usage session or curated review should inform an advisory
adoption signal. Source: README skill-scoring/intake sections.
Linked [RTM](RTM.md): REQ-028–029.

| Step | Operation | Layer and evidence | Status and stop condition |
| --- | --- | --- | --- |
| 1 | Ingest a usage event while excluding low-quality/gamed usage from verified counts. | L4 registered CLI + SQLite: [skill-signals.test.ts](../packages/cli/src/commands/skill-signals.test.ts) asserts passing usage counts and failing usage persists without counting. | **Local:** invalid source rejects; connection closes on write failure. Input provenance fields are not independent proof of the invoking human's identity. |
| 2 | Record a curated review and compute the advisory adoption result. | L4 intake plus L3 functions: [skill-signals.test.ts](../packages/cli/src/commands/skill-signals.test.ts), [adoption.test.ts](../packages/refiner-core/src/adoption.test.ts). | **Local:** review persistence, fixed-clock 2×2 decisions, weak-evidence `hold`, source-verification filtering and tenant isolation are asserted. The review is curated signal, not a signed approval. |
| 3 | Have an accountable operator interpret and act on the advisory result. | No human decision/authorization journey is established by the local intake/adoption tests. | **Unverified:** provisional thresholds and advisory results do not independently authorize deprecation, publication or rollout. |

Evidence distribution: 2 Local, 1 Unverified. This mapping does not install an
automated authority path where the documented system provides advisory data.

## Reading the gaps

Missing or partial evidence is not automatically a new blocking requirement.
The observational RTM carries the source-derived requirement priorities; no
journey threshold or critical flag is introduced here. The report should
retain separate findings for local fixture coverage, external execution,
human review and the placeholder dashboard. Combining these categories into
one passing percentage would hide the boundaries the tests actually exercise.
