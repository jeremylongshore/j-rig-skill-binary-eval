---
title: Repo Blueprint — j-rig-skill-binary-eval
date: 2026-06-10
authors:
  - Jeremy Longshore (Intent Solutions)
status: NORMATIVE
binding_authority: iaj-E01
inherits_from:
  - intent-eval-lab/000-docs/011-AT-ARCH-ecosystem-master-blueprint.md (Blueprint A)
  - intent-eval-lab/000-docs/012-AT-ARCH-platform-runtime-blueprint.md (Blueprint B)
  - intent-eval-lab/000-docs/013-AT-SPEC-repo-blueprint-template.md (Blueprint C — this template)
related_drs:
  - 004-AT-DECR (S1Q5 — provider PASS/FAIL gates)
  - 010-AT-DECR (S4 — widened-scope lock; provider gates reaffirmed; hybrid language)
  - 018-AT-DECR (S5 — j-rig kernel-adoption normative reconciliation; @j-rig/* v2.0.0 major bump)
related_glossary:
  - intent-eval-lab/000-docs/014-DR-GLOS-canonical-glossary.md
filing_standard: Document Filing Standard v4.3
---

**Beads:** `bd_000-projects-mte`

# Repo Blueprint — j-rig-skill-binary-eval

## § 1 — Repo identity

| Field              | Value                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo name**      | `j-rig-skill-binary-eval` (GH-canonical; local working-dir is `j-rig-binary-eval`, retained for backward-compat)                          |
| **Type**           | `runtime`                                                                                                                                  |
| **Owner**          | per `CODEOWNERS` — `@jeremylongshore`                                                                                                      |
| **Maturity**       | `v1.x production`                                                                                                                          |
| **Ecosystem role** | Behavioral evaluation harness for Claude `SKILL.md` artifacts — scores skill changes across seven binary layers and emits Evidence Bundle rows + a rollout decision. |
| **Bead prefix**    | `iaj-` (per Blueprint A § 2.1 taxonomy)                                                                                                    |
| **Plane module**   | JRIG → Intent Eval Platform (j-rig-skill-binary-eval)                                                                                      |

### 1.1 Dependencies (peer repos consumed)

| Peer repo                | Consumed at  | Pinned range            | Cited blueprint                                            |
| ------------------------ | ------------ | ----------------------- | --------------------------------------------------------- |
| `intent-eval-core`       | build / test | `0.2.0` (exact, pre-v0.3 cutover; widens to `>=0.2.0, <1.0.0` once `iaj-E02b` lands the `EvidenceBundlePayload` adoption) | `intent-eval-core/000-docs/` per-repo blueprint           |
| `audit-harness`          | test         | vendored `.audit-harness/` (self-pin via `scripts/audit-harness`) | `audit-harness/000-docs/` per-repo blueprint             |

> The `@intentsolutions/core` dependency is the canonical-contracts kernel: this repo imports its TS types + JSON Schemas + Zod validators for Evidence Bundle and `gate-result/v1`, never redefining them. Strict SemVer per Blueprint A § 4.2.

### 1.2 Non-goals (inherited + repo-specific)

This repo inherits every anti-goal locked in Blueprint A § 3 (NOT a generalized autonomous agent platform; NOT a workflow automation competitor; NOT a distributed compute platform; NOT a no-code builder; NOT infinite orchestration; NOT trying to be the union of every adjacent category; AISE 5-domain stack is internal scope-map, NOT separate-brand surface). In addition, this repo specifically does NOT:

- Define or persist the canonical Evidence Bundle / `gate-result/v1` schemas — those live in `intent-eval-core` and are consumed here, never re-declared.
- Author the GitHub Action shell that turns a bundle + policy into a CI ship/no-ship verdict — that is `intent-rollout-gate`'s job; this repo emits the bundle the gate consumes.
- Generate or rewrite SKILL.md content (that is the separate Skill Refiner product); this repo judges skills, it does not improve them.

Scope-creep into any item above triggers ISEDC re-convene per Blueprint A § 2.3 governance routing.

---

## § 2 — Problem statement

A skill author cannot ship a `SKILL.md` change with confidence: there is no externally-judged, reproducible signal that the new version is better than the old one, no protection against silently regressing a known-good behavior, and no machine-verifiable evidence that the verdict was reached honestly. Manual spot-checking grades what the skill *claims* it does, not what it *actually* does, and gives no audit trail.

This repo addresses that by running every skill version through seven binary layers — package integrity, trigger quality, functional quality, regression protection, baseline value, model variance, and rollout safety — with the evaluator always separate from the skill under test, then emitting a signed Evidence Bundle row plus a rollout decision. It cites Blueprint A § 1.1 mission (verifiable, vendor-neutral evaluation) as upstream context.

The boundary: this repo *produces* the Evidence Bundle and the decision logic; it hands the bundle off to `intent-rollout-gate` (the Action shell) for CI integration, and it consumes the canonical schemas from `intent-eval-core`. It does not own the schema and it does not own the Action.

---

## § 3 — Scope boundaries

### 3.1 In scope

What this repo ships, end-to-end:

- The seven-layer binary evaluation engine (`@j-rig/core`): spec parsing, execution, observation, judgment (deterministic-first, LLM-judge-second), optimization, evidence, and the score-card / governance logic.
- The author + CI CLI (`@j-rig/cli`, binary `j-rig`): `eval`, `validate`, `check`, `report`, `optimize`, `drift`, `emit-evidence` subcommands.
- The SQLite evidence persistence layer (`@j-rig/db`): runs, scores, regressions, baselines, launch reports.
- `@j-rig/rollout-gate` decision logic (the predicate the Action shell delegates to).
- Provider adapters with the two mandatory CISO PASS/FAIL gates (G1 credential-redaction, G2 env-var spillover) enforced in-repo.

### 3.2 Out of scope (permanent, no FUTURE flag)

What this repo refuses to do, full stop:

- Canonical schema authority — the Evidence Bundle and `gate-result/v1` shapes are owned by `intent-eval-core` per DR-018; redefining them here would fork the contract.
- The GitHub Action manifest + runtime that gates a PR — owned by `intent-rollout-gate`, which delegates to `@j-rig/rollout-gate`.
- Improving / rewriting SKILL.md content — that is the Skill Refiner product (a distinct product in the agent-rig stack), not an eval harness concern.

> "Out of scope" here means "this will not be in this repo, ever." Items that are merely deferred live in § 3.3.

### 3.3 Deferred (FUTURE flag required)

| Deferred item                                                   | Earliest milestone | FUTURE.md reference                          |
| --------------------------------------------------------------- | ------------------ | -------------------------------------------- |
| `@j-rig/*` v2.0.0 consuming kernel `EvidenceBundlePayload`       | `iaj-E02b`         | this repo `FUTURE.md#kernel-payload-adoption` |
| npm-published `@j-rig/*` packages (currently no `pnpm publish`) | downstream-demand  | this repo `FUTURE.md#npm-publish`             |
| Team dashboard (`@j-rig/dashboard` package currently a stub)    | Epic 10            | this repo `FUTURE.md#dashboard`              |

### 3.4 Anti-goals (binding-scope-control)

- **Inherited from Blueprint A § 3**: NOT a generalized autonomous agent platform; NOT a workflow automation competitor; NOT a no-code builder; NOT infinite orchestration (cite Blueprint A § 3 in full).
- **Repo-specific — the evaluator never judges itself**: a skill under test must never be its own evaluator (Design Principle 2). The failure mode prevented is reward-hacking — a skill that grades itself toward a PASS, defeating the entire purpose of an external eval.
- **Repo-specific — no gradient scores**: criteria are binary yes/no, never fuzzy gradients (Design Principle 1). The failure mode prevented is verdict-laundering through averaging, where a blocker failure gets diluted by unrelated passing criteria.

Scope-creep into any one triggers ISEDC re-convene per Blueprint A § 2.3.

---

## § 4 — Architecture

### 4.1 Module layout

Top-level directory structure and package boundaries:

```text
j-rig-skill-binary-eval/
├── packages/
│   ├── core/        — @j-rig/core: seven-layer engine (checks, trigger, execution,
│   │                  judgment, optimizer, evidence, drift, governance, providers, schemas)
│   ├── cli/         — @j-rig/cli: the `j-rig` binary (commands/, lib/, providers/)
│   ├── db/          — @j-rig/db: SQLite persistence (schema, lifecycle, evidence)
│   └── dashboard/   — @j-rig/dashboard: team reporting surface (Epic 10, stub)
├── tests/           — repo-level smoke + cross-package integration
├── 000-docs/        — enterprise documentation (this blueprint, epics, references)
├── .audit-harness/  — vendored Intent Solutions Testing SOP harness
└── scripts/         — audit-harness wrapper + tooling
```

### 4.2 Data flow

The harness pipeline is linear across the seven layers, bottom to top:

```text
[YAML eval spec + SKILL.md version]
  → Spec Layer (parse contracts, criteria, test cases)
  → Execution Layer (run skill against trigger/functional/regression/baseline cases)
  → Observation Layer (capture outputs, artifacts, cost, latency)
  → Judgment Layer (deterministic checks first; external LLM judges second)
  → Optimization Layer (failure clustering; one atomic change proposal)
  → Evidence Layer (SQLite: runs, scores, regressions, baselines, launch reports)
  → CLI/CI emit-evidence (Evidence Bundle row + rollout decision)
```

The `emit-evidence` subcommand is the terminal stage that wraps the verdict as an Evidence Bundle row (in-toto Statement over DSSE) for downstream `intent-rollout-gate` consumption.

### 4.3 Runtime boundaries

| Concern                          | Specification                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Process model**                | single-process CLI (`j-rig`) invoked locally by authors or in CI                                              |
| **IPC**                          | stdin-stdout JSON (the `emit-evidence` pipeline mode reads a JSON envelope on stdin and writes a Statement to stdout) |
| **External services consumed**   | LLM provider APIs (judge invocations + skill execution); `cosign` binary for DSSE signing; local SQLite file  |
| **Process isolation guarantees** | provider credentials are brokered and never spill into spawned subprocesses (CISO gate G2); the skill under test runs in the execution layer, isolated from the judge |

### 4.4 Storage needs

| Storage class         | Backing store | Retention                | Reference                           |
| --------------------- | ------------- | ------------------------ | ----------------------------------- |
| Evidence (hot)        | SQLite file   | local / repo-controlled  | `Blueprint B § 4.2 cost governance` |
| Cold archive          | N/A           | deferred — no cloud archive tier in v1.x | this repo `FUTURE.md`     |

### 4.5 External dependencies (cite by version)

Strict SemVer per Blueprint A § 4.2.

| Dependency                       | Range                  | Purpose                                   | Notes                                                       |
| -------------------------------- | ---------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `@intentsolutions/core@0.2.0`    | `0.2.0` (exact)        | canonical Evidence Bundle + gate-result schemas/types | Apache-2.0; widens after `iaj-E02b` kernel-payload adoption |
| `zod@^4.4.3`                     | `>=4.4.3, <5.0.0`      | schema validation                         | MIT                                                         |
| `commander@^15.0.0`              | `>=15.0.0, <16.0.0`    | CLI argument parsing                      | MIT                                                         |
| `better-sqlite3@^12.10.0`        | `>=12.10.0, <13.0.0`   | SQLite evidence persistence               | MIT; native module                                          |
| `drizzle-orm@^0.45.2`            | `>=0.45.2, <0.46.0`    | typed query layer over SQLite             | Apache-2.0                                                  |

MAJOR bumps to any of the above require a Class-2 pair Decision Record before they land.

### 4.6 Failure boundaries

- **Crash boundary**: a single `j-rig` CLI invocation is the crash boundary — a panic in one eval run does not corrupt the SQLite evidence store (writes are transactional) or affect other runs.
- **Retry boundary**: provider invocations are bounded — a hung `invokeProvider` times out and is recorded as a FAIL (verified by the CISO gate tests), never retried indefinitely.
- **Isolation guarantees**: a provider credential leak or env-var spillover is caught by the G1/G2 gates *before* the adapter lands; downstream Evidence Bundle consumers (`intent-rollout-gate`) are protected because a failing gate is a HARD STOP that blocks merge.
- **Emitted FailureTaxonomy categories**: provider-timeout, judge-disagreement, regression-on-sacred-case, blocker-failure (mapped to Blueprint B § 2.13 categories at the emit-evidence boundary).

---

## § 5 — Canonical entities used

| Entity              | Direction | Blueprint B Ref     | Attributes implemented                                                                                  | Glossary ref                              |
| ------------------- | --------- | ------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `EvalSpec`          | consumes  | `Blueprint B § 2.1` | required fields + criteria + test-cases (parsed from YAML; schema consumed from kernel)                  | `014-DR-GLOS-canonical-glossary.md` § 2.1 |
| `EvalRun`           | both      | `Blueprint B § 2.2` | required fields + UUID + lifecycle + content-hash (persisted in SQLite evidence store)                   | `014-DR-GLOS-canonical-glossary.md` § 2.2 |
| `EvidenceBundle`    | produces  | `Blueprint B § 2.4` | required fields + content-hash + DSSE wrap + provenance (emitted via `emit-evidence`; schema from kernel) | `014-DR-GLOS-canonical-glossary.md` § 2.4 |
| `JudgeDecision`     | produces  | `Blueprint B § 2.5` | required fields + binary verdict + evaluator-separation provenance                                       | `014-DR-GLOS-canonical-glossary.md` § 2.5 |
| `RegressionPack`    | both      | `Blueprint B § 2.7` | required fields + sacred-case flags (regression comparison + baseline gating)                            | `014-DR-GLOS-canonical-glossary.md` § 2.7 |
| `RolloutGate`       | produces  | `Blueprint B § 2.8` | required fields + ship/no-ship predicate (`@j-rig/rollout-gate` decision body)                           | `014-DR-GLOS-canonical-glossary.md` § 2.8 |
| `SkillSnapshot`     | consumes  | `Blueprint B § 2.9` | required fields + content-hash (the SKILL.md version under test)                                         | `014-DR-GLOS-canonical-glossary.md` § 2.9 |
| `CostRecord`        | produces  | `Blueprint B § 2.12`| token + latency + cost capture per invocation (Observation Layer)                                        | `014-DR-GLOS-canonical-glossary.md` § 2.12 |

**Entities NOT touched by this repo:** `MatcherMap`, `RuntimeReceipt`, `SessionTrace`, `ToolInvocation`, `FailureTaxonomy` (the last is consumed as a vocabulary at the emit boundary but this repo does not persist `FailureTaxonomy` rows as a first-class entity). Canonical definitions are sourced from `intent-eval-core` and `014-DR-GLOS-canonical-glossary.md` — never redefined locally.

---

## § 6 — Interfaces

### 6.1 CLI

```text
j-rig <subcommand> [flags] [args]
```

| Subcommand      | Purpose                                                              | Exit codes                                                  |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `eval`          | run a skill version through the seven-layer harness                 | `0` PASS / `1` user error / `2` blocking violation          |
| `validate`      | structural validation of an eval spec + SKILL.md                    | `0` valid / `1` user error / `2` invalid artifact           |
| `check`         | quick smoke check of harness wiring                                 | `0` ok / `1` error                                          |
| `report`        | render run / score / regression reports                             | `0` ok / `1` user error                                     |
| `optimize`      | failure clustering + one-atomic-change proposal                     | `0` ok / `1` user error                                     |
| `drift`         | re-evaluate against drifted model / baseline                        | `0` no drift / `1` user error / `2` drift detected          |
| `emit-evidence` | wrap a verdict as an Evidence Bundle row (Statement over DSSE)      | `0` emitted / `1` user error / `2` signing/hash mismatch    |

### 6.2 HTTP / gRPC APIs

N/A — this repo ships no HTTP or gRPC server. It is a single-process CLI + library.

### 6.3 Config files

| File                     | Schema                                                | Canonical example                  |
| ------------------------ | ----------------------------------------------------- | ---------------------------------- |
| eval spec (`*.eval.yaml`) | Zod-validated EvalSpec (schema consumed from kernel)  | `000-docs/templates/eval-schemas/` |

### 6.4 Output formats

| Output              | Shape                                                                | Reference         |
| ------------------- | -------------------------------------------------------------------- | ----------------- |
| Evidence Bundle row | in-toto Statement v1 over DSSE; predicate body per Blueprint B § 7.4 | `Blueprint B § 7` |
| JSON envelope       | `emit-evidence` pipeline-mode stdin/stdout JSON                      | `packages/cli/src/commands/emit-evidence` |
| Plain-text fallback | human-readable run + score summary from `report`                    | n/a               |

### 6.5 Event schemas

| Event                              | Attributes                              | OTel taxonomy                                            |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `agent.evidence_bundle.emitted`    | bundle-id, predicate-uri, signing-mode  | per iel-E12 (forward-ref; carries `taxonomy_status: draft` until RFC lock) |
| `agent.rollout.gate.decided`       | gate-id, decision, regression-count     | `agent.rollout.gate.<subkey>` (per iel-E12, forward-ref) |

### 6.6 Public-API stability promise

What this repo guarantees across SemVer minor bumps:

- The `j-rig` CLI subcommand surface (§ 6.1) and exit-code semantics — stable; new subcommands are additive only.
- The `@j-rig/rollout-gate` decision-logic export consumed by `intent-rollout-gate` — stable signature within a MAJOR line.
- The `emit-evidence` JSON envelope shape — stable; the predicate body itself is governed by the kernel's `gate-result/v1` contract, not this repo.

Breaking changes to anything above require MAJOR bump (Blueprint A § 4.2) AND a Class-2 pair Decision Record (Blueprint A § 2.3) before merge. The pending `@j-rig/*` v2.0.0 bump (kernel `EvidenceBundlePayload` adoption per DR-018) is exactly such a change.

---

## § 7 — Testing strategy

Layer applicability is per-repo-type per `~/.claude/skills/audit-tests/references/layer-applicability.md`. This is a `runtime` repo; all seven layers apply.

### 7.1 L0 — git hooks (pre-commit)

- **In-scope checks**: escape-scan, partner-name grep guard, license-header presence, hash-pin verification.
- **Enforcement**: `scripts/audit-harness <subcommand>` (vendored install). NEVER `~/.claude/` paths.

### 7.2 L1–L2 — static analysis (lint + typecheck + escape-scan)

- **Lint**: ESLint flat config + typescript-eslint; Prettier `format:check`.
- **Typecheck**: `tsc --noEmit` across all packages + `tests/`.
- **Escape-scan**: `scripts/audit-harness escape-scan --staged` (vendored).

### 7.3 L3 — unit tests

| Concern                | Target                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| **Framework**          | vitest                                                            |
| **Coverage floor**     | enforced via repo `tests/TESTING.md` policy (hash-pinned)         |
| **Mutation kill rate** | per `tests/TESTING.md` policy                                     |
| **CI gate**            | `pnpm run check` (lint + typecheck + test) on Node 22             |

### 7.4 L4 — integration tests

What is exercised end-to-end **inside the repo** (no external services):

- `emit-evidence` CLI integration — full Statement emission, predicate-body-only mode, hash-mismatch refusal, malformed-stdin rejection (10 integration cases in `emit-evidence.test.ts`).
- Cross-package wiring smoke (`tests/smoke.test.ts`).

### 7.5 L5 — system tests

What is exercised against **external services**:

- Provider judge invocations against live LLM provider APIs (gated behind explicit stub opt-in for CI per the stub-provider discipline).
- **Provider PASS/FAIL gates**: see § 8.3 — credential-redaction (G1) + env-var spillover (G2) tests are NON-NEGOTIABLE for this repo because it touches LLM providers.

### 7.6 L6 — acceptance tests

| Concern           | Specification                                                          |
| ----------------- | --------------------------------------------------------------------- |
| **Gherkin scope** | author skill-eval flows (eval → score → emit) codified as acceptance  |
| **Lint**          | `scripts/audit-harness gherkin-lint`                                  |
| **RTM**           | `tests/` traceability per Intent Solutions Testing SOP                 |
| **Personas**      | skill author + CI reviewer (per audit-tests RTM/personas)             |
| **Journeys**      | local author eval loop + PR gate journey                              |

### 7.7 L7 — chaos / property / fuzz

- **Applicability**: partially applicable. Provider-timeout chaos is exercised today (the CISO gate tests assert a hung `invokeProvider` times out as a FAIL). Broader property-based testing is a gap.
- **Framework**: fast-check (candidate; not yet adopted for full property coverage).
- **Scope**: the timeout/hang invariant is property-exercised today; full property coverage is filed under the `iaj-` prefix as a follow-up.

### 7.8 CI gates

The exact commands a PR runs on merge:

```text
pnpm install
pnpm run check        # lint + typecheck + test (Node 22)
scripts/audit-harness verify
```

**Hash-pin discipline**: after any policy edit in `tests/TESTING.md`, re-run `scripts/audit-harness init` and commit the updated `.harness-hash` in the same commit. Pre-commit refuses unsigned policy edits by design.

### 7.9 Fixtures

| Concern                       | Specification                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Location**                  | per-package `*.test.ts` co-located fixtures + `tests/`                                                                              |
| **Naming convention**         | `<kind>-<slug>.test.ts`                                                                                                              |
| **Vendor-generic discipline** | All fixtures are scrubbed per DR-004 S1Q2 + DR-010 § 10 reaffirmation. Partner-name grep guard runs in CI.                          |

### 7.10 Golden files (if applicable)

N/A — this repo does not maintain snapshot golden files; Evidence Bundle outputs are asserted structurally against the kernel schema, not against frozen snapshots.

---

## § 8 — Security / isolation

### 8.1 Secrets management

Secrets are handled via the **broker pattern** per Blueprint B § 4.1: provider credentials never cross the subprocess boundary.

| Secret class       | Storage                                          | Broker                         | Repo-specific                                       |
| ------------------ | ------------------------------------------------ | ------------------------------ | --------------------------------------------------- |
| provider-api-key   | SOPS-encrypted `.env.sops` / GitHub Actions secret | in-process broker; redacted handle downstream | enforced by CISO gates G1 + G2 (see § 8.3) |

**SOPS + age standard**: when this repo persists secrets at rest, it uses the SOPS + age pattern per the parent `~/.claude/CLAUDE.md` § "SOPS + age secrets standard". `.env.sops` committed; `.env` plaintext is git-ignored; CI receives the age key via `SOPS_AGE_KEY` GitHub Actions secret. NEVER decrypt to disk.

### 8.2 Sandbox model

| Concern                 | Default per Blueprint B § 4.1                                | This repo's override (if any)                                          |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Filesystem**          | per-Run scratch directory; no host-FS access outside scratch | default                                                               |
| **Network egress**      | declared egress allowlist per EvalSpec                       | default (provider endpoints only)                                     |
| **Wall-clock ceiling**  | 30 minutes default; 4 hours hard ceiling                     | per-provider-invocation timeout enforced (hung invoke → FAIL)         |
| **Memory ceiling**      | 2 GiB default; 8 GiB hard ceiling                            | default                                                               |
| **Credential boundary** | broker-pattern; plaintext never crosses subprocess boundary  | enforced by G2 env-var spillover test                                 |

### 8.3 Provider PASS/FAIL gates (RESTATED — this repo touches LLM providers)

> This repo invokes LLM providers (judge invocations + skill execution + the Anthropic adapter). The gates below are restated verbatim. These gates are NON-NEGOTIABLE per DR-004 S1Q5 (declined reopening at Session 4 per DR-010 § 10). Removing or weakening this section is itself a Class-1 ISEDC trigger.

The platform's two provider gates are **non-negotiable** and both must PASS before any provider abstraction lands or is bumped in this repo:

1. **Credential-redaction test** — every code path that surfaces an error, log entry, or metric containing a provider response MUST redact the credential. Test asserts the literal credential string is absent from every observable surface.
2. **Env-var spillover test** — provider credentials set in this repo's process environment MUST NOT spill into any spawned subprocess. Test spawns a subprocess and asserts the provider env vars are absent from its environment.

Both tests run in CI on every PR touching provider code. A FAIL on either is a HARD STOP — the PR cannot merge. In this repo they are implemented as CISO gates G1 (`g1-credential-redaction.test.ts`) and G2 (`g2-env-var-spillover.test.ts`) under `packages/core/src/providers/ciso-gates/`, and both also assert a hung `invokeProvider` times out as a FAIL.

Provider adapter library choice (LiteLLM / Vercel AI SDK / custom) is decided per-repo through in-prototype measurement against these gates plus CTO measurement protocol committed BEFORE prototyping plus CMO ≥3 named providers in launch leaderboard plus GC license audit (DR-004 S1Q5 + DR-010 reaffirmation).

### 8.4 Audit logging

| Concern            | Specification                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| **What is logged** | verdict emissions, signing events, verification failures, provider-gate results                               |
| **Append-only**    | yes — Evidence rows are never amended in place per Blueprint A § 1.2 principle 3                               |
| **Signing**        | Evidence Bundle rows are signed via `cosign` (DSSE) per Blueprint B § 7.5                                      |
| **Retention**      | local SQLite evidence store; retention is repo/deployment-controlled (no cloud cold tier in v1.x)             |

### 8.5 Threat model

An adversary with write access to the npm registry could publish a poisoned version of a transitive dependency (`better-sqlite3`, `drizzle-orm`, `zod`) or of `@intentsolutions/core`; we defend with strict-SemVer pinned ranges, sigstore provenance on the kernel, and a license audit on the resolved tree. An adversary cannot make a skill grade itself toward a PASS — the evaluator is always separate (Design Principle 2). An adversary who plants a credential-leaking code path in a provider adapter is stopped at CI by the G1/G2 gates before merge. An adversary cannot dilute a blocker failure through averaging — blockers block release unconditionally (Design Principle 6).

---

## § 9 — Observability

### 9.1 OpenTelemetry events

| Event                              | Trigger                                            | Attributes                              |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------- |
| `agent.evidence_bundle.emitted`    | `emit-evidence` writes a Statement                 | bundle-id, predicate-uri, signing-mode  |
| `agent.rollout.gate.decided`       | `@j-rig/rollout-gate` returns a ship/no-ship verdict | gate-id, decision, regression-count     |

Both forward-reference `iel-E12` (the OTel RFC) and carry `taxonomy_status: draft` until the `agent.rollout.gate.*` / `agent.evidence_bundle.*` taxonomies are locked.

### 9.2 Trace propagation

| Concern               | Specification                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| **Incoming trace ID** | honored via CLI flag when invoked from `intent-rollout-gate` in CI; N/A for local author runs |
| **Span hierarchy**    | a `j-rig eval` invocation is the root span; per-layer spans nest under it     |
| **Span attributes**   | required attributes per the iel-E12 RFC (forward-ref)                        |

### 9.3 Lineage capture

- **SessionTrace**: N/A — this repo does not populate SessionTrace fields (not in its entity set per § 5).
- **RuntimeReceipt**: N/A — not consumed.
- **ToolInvocation rows**: N/A — not emitted.

The repo's lineage surface is the `EvalRun` → `EvidenceBundle` chain it persists in SQLite + emits at the `emit-evidence` boundary.

### 9.4 Log levels

| Level   | When                                                                 |
| ------- | -------------------------------------------------------------------- |
| `ERROR` | unrecoverable failure — operator action required                     |
| `WARN`  | degraded state — operation continues but signal is reduced           |
| `INFO`  | high-level lifecycle events — start, end, terminal state transitions |
| `DEBUG` | per-step diagnostics — disabled by default in production             |
| `TRACE` | per-operation diagnostics — enabled only in test environments        |

### 9.5 Failure taxonomy

Blueprint B § 2.13 `FailureTaxonomy` categories this repo can surface at the emit boundary:

- `provider-timeout` — a hung `invokeProvider` exceeded its ceiling.
- `regression-on-sacred-case` — a sacred regression case failed (blocks release regardless of average).
- `blocker-failure` — a blocker criterion failed (cannot be averaged out).

This repo surfaces these categories as a vocabulary at emit time but does not persist `FailureTaxonomy` rows as a first-class kernel entity.

---

## § 10 — Cost governance

> This repo touches a paid surface (LLM provider API calls). Sections below apply.

### 10.1 Token ceilings

| Concern                          | Default                | Per-EvalSpec override                                      |
| -------------------------------- | ---------------------- | ---------------------------------------------------------- |
| **Per-invocation token ceiling** | per EvalSpec contract  | permitted via EvalSpec `runtime_limits.token_ceiling`      |
| **Per-run wall-clock ceiling**   | per-invocation timeout (hung → FAIL) | permitted via EvalSpec `runtime_limits.wall_clock_ceiling` |
| **Concurrency**                  | bounded via `p-limit`  | per-deployment                                             |

### 10.2 Cost attribution

Per Blueprint B § 2.12 `CostRecord`:

- **Consumed**: token + latency fields read from provider responses in the Observation Layer.
- **Produced**: one `CostRecord` per provider invocation, persisted in the SQLite evidence store.

### 10.3 Retention lifecycle

| Class   | Window        | Backing store        |
| ------- | ------------- | -------------------- |
| Hot     | local session | SQLite evidence store |
| Warm    | N/A           | —                    |
| Cold    | N/A           | —                    |
| Archive | N/A           | deferred (no cloud archive tier in v1.x) |

Deviations (adding a cloud cold/archive tier) require a Class-2 pair Decision Record.

### 10.4 Cache strategy

| Cache class    | Purpose                      | Hit/miss accounting                                      |
| -------------- | ---------------------------- | -------------------------------------------------------- |
| Prompt cache   | reduce provider token cost   | emitted to `CostRecord` as `cache_hits` / `cache_misses` when the provider supports it |

### 10.5 Budget ceilings

| Scope               | Daily      | Monthly    | Per-feature |
| ------------------- | ---------- | ---------- | ----------- |
| provider api spend  | per-deployment | per-deployment | per-EvalSpec |

Exceeding any ceiling pauses execution and surfaces an alert; ceilings are enforced at the runtime sandbox boundary per Blueprint B § 4.1, not at the policy layer alone.

---

## § 11 — Release strategy

### 11.1 Versioning

**Strict SemVer** per Blueprint A § 4.2.

| Bump  | When                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| MAJOR | breaking change to § 6.6 stability promise (e.g. the pending `@j-rig/*` v2.0.0 kernel-payload adoption per DR-018)        |
| MINOR | additive feature; new optional field; new CLI subcommand; new event emission                                              |
| PATCH | bug fix; documentation polish; internal refactor with no public-API change                                                |

### 11.2 Changelog

`CHANGELOG.md` discipline per Keep a Changelog format. Every PR that merges to main updates `CHANGELOG.md` under `## [Unreleased]`; the release commit promotes `[Unreleased]` to the new version + date. Current version: `1.1.0` (per `version.txt`).

### 11.3 Migration notes

| Concern                      | Location                                       |
| ---------------------------- | ---------------------------------------------- |
| **Migration guide location** | `CHANGELOG.md` `[Unreleased]` migration notes + per-MAJOR release notes |
| **Migration generator**      | hand-authored                                  |
| **Required for**             | every MAJOR bump (the v2.0.0 kernel-payload migration is the next one) |

### 11.4 Compatibility guarantees

Across minor bumps:

- The `j-rig` CLI subcommand surface + exit codes (§ 6.1) are preserved.
- The `@j-rig/rollout-gate` decision export signature is preserved within a MAJOR line.

Across MAJOR bumps: only the items explicitly preserved in the MAJOR release notes (the v2.0.0 release will document the `EvidenceBundlePayload` migration).

### 11.5 Evidence retention discipline

Per Blueprint A § 4.2 + DR-010 § 7 Q5 CISO non-negotiable: production-Rekor signing for any predicate URI is gated on that predicate's SPEC.md normative section landing.

- **v0.x / v1.x releases** anchor evidence to sigstore staging (`rekor.sigstage.dev`) — EXPERIMENTAL mode — until the relevant predicate's SPEC.md normative section is merged on `intent-eval-lab` main.

This repo's predicate-URI inventory and per-predicate cutover status:

| Predicate URI                                  | Status      | SPEC.md ref                                  | Signing mode       |
| ---------------------------------------------- | ----------- | -------------------------------------------- | ------------------ |
| `evals.intentsolutions.io/gate-result/v1`      | conditional | `intent-eval-lab` Blueprint B § 7 (normative; production-Rekor gated on the kernel SPEC.md fold) | `sigstore_staging` |

### 11.6 License audit

Every release runs `npm-license-checker` (or pnpm equivalent) on the resolved dependency tree per DR-010 § 7 Q2 GC non-negotiable. GPL / AGPL dependencies are blocked at CI absent explicit GC waiver. This repo's own license is **Apache-2.0** (relicensed from MIT in v1.0.0 per DR-018 / j-rig-skill-binary-eval#73).

---

## § 12 — Beads / work breakdown

| Concern               | Value                                                            |
| --------------------- | ---------------------------------------------------------------- |
| **Bead prefix**       | `iaj-` (per Blueprint A § 2.1)                                   |
| **bd workspace**      | umbrella `~/000-projects/.beads/`                               |
| **Epic naming**       | `iaj-E<NN>` (e.g., `iaj-E01`)                                   |
| **Plane project**     | JRIG                                                             |
| **Plane module**      | Intent Eval Platform → j-rig-skill-binary-eval                  |
| **GH ↔ Plane mirror** | via `bd-sync` per global CLAUDE.md three-layer discipline        |

### 12.1 Cross-repo bead dependencies

Other ecosystem repos' beads this repo's work depends on (ALL bd-sync-mirrored):

- `iec-E12` (`intent-eval-core` kernel v0.2.0 `EvidenceBundlePayload`) — `iaj-E02b` is blocked on this kernel release before the `@j-rig/*` v2.0.0 bump can land.

### 12.2 In-repo epic inventory

| Epic       | Status      | Purpose                                               |
| ---------- | ----------- | ----------------------------------------------------- |
| `iaj-E01`  | in-progress | This repo blueprint (Blueprint C application)         |
| `iaj-E02b` | open        | j-rig schema upgrade to kernel `EvidenceBundlePayload` (blocked on `iec-E12`) |

---

## § 13 — Definition of Done

This repo is "complete enough to release" when **every** check below passes:

- [ ] All tests pass at the L0–L7 policy floors declared in § 7 (coverage, mutation kill rate, integration scenarios, system tests).
- [ ] Provider PASS/FAIL gates pass (§ 8.3) — credential-redaction (G1) + env-var spillover (G2) both green — this repo touches LLM providers.
- [ ] All canonical entities consumed (§ 5) have their schema versions pinned to a known-good range (`@intentsolutions/core` pinned).
- [ ] License audit clean per § 11.6 (no GPL / AGPL absent explicit GC waiver; repo is Apache-2.0).
- [ ] Partner-name vendor-generic grep returns 0 against all public-facing directories — use the current partner-name pattern maintained in the ecosystem CLAUDE.md.
- [ ] Evidence Bundle round-trip verified — emit → DSSE wrap → cosign sign → cosign verify-attestation → consume succeeds end-to-end.
- [ ] `CHANGELOG.md` entry written under `## [Unreleased]` (or promoted to the new version for the release commit).
- [ ] This per-repo blueprint matches reality — `/validate-consistency` clean against this repo's `000-docs/`, `README.md`, and `CHANGELOG.md`.
- [ ] Acting head of board sign-off (or designated approver per `CODEOWNERS`).
