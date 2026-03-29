# j-rig-binary-eval

> Software-grade release discipline for Claude Skills

Binary evaluation harness that treats `SKILL.md` artifacts as production software. Package integrity, trigger precision, functional quality, regression gating, baseline comparison, model-aware testing, and evidence-backed rollout decisions — all through binary yes/no criteria with external evaluators.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jeremylongshore/j-rig-binary-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/j-rig-binary-eval/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jeremylongshore/j-rig-binary-eval)](https://github.com/jeremylongshore/j-rig-binary-eval/releases)

**Links:** [Master Blueprint](000-docs/007-PP-PLAN-master-build-blueprint.md) · [Epic Index](000-docs/epics/README.md) · [Doc Index](000-docs/000-INDEX.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

## One-Pager

### The Problem

Claude Skills ship on instinct. A skill author writes a `SKILL.md`, eyeballs it, maybe runs it once, and pushes. There is no regression gate, no trigger precision measurement, no baseline comparison, no model-variance tracking, and no evidence trail for rollout decisions. When a skill breaks silently after a model update or a description tweak causes sibling confusion across a pack, nobody knows until users complain.

### The Solution

J-Rig Binary Eval is a seven-layer evaluation harness that scores every skill change across seven product surfaces before it ships:

1. **Package Integrity** — Does it parse, validate, and reference real files?
2. **Trigger Quality** — Does it fire on the right prompts and stay silent on the wrong ones?
3. **Functional Quality** — Does it complete its task and produce correct artifacts?
4. **Regression Protection** — Did this change break anything that previously worked?
5. **Baseline Value** — Does the skill actually outperform the naked model?
6. **Model Variance** — Does it work across Haiku, Sonnet, and Opus?
7. **Rollout Safety** — Any prompt leakage, overreach, or unsafe automation?

Every criterion is binary (yes/no). The evaluator is always separate from the skill under test. Observed behavior outranks claimed behavior.

### W5

| | |
|---|---|
| **Who** | Claude Skill authors, skill pack maintainers, enterprise skill library operators |
| **What** | Evaluation harness + regression gate + optimization engine for Claude Skills |
| **Where** | Local CLI (author workflow), CI/CD (PR gate), team dashboard (reporting) |
| **When** | Every skill change: new skill, description edit, body rewrite, model update |
| **Why** | Skills are production software — they need release-quality discipline, not vibes |

### Stack

| Layer | Technology |
|-------|-----------|
| Runtime | TypeScript, Node.js 20+, pnpm |
| CLI/Parsing | commander, @clack/prompts, picocolors, yaml, unified/remark |
| Validation | zod |
| LLM Integration | @anthropic-ai/sdk |
| Persistence | better-sqlite3, drizzle-orm |
| Concurrency | p-limit, async-retry |
| Artifact Extraction | pdf-parse, mammoth |
| Dashboard (future) | Next.js, Tailwind, shadcn/ui |

### Key Differentiators

- **Binary criteria only** — if a criterion can't be answered yes or no, it isn't ready. No fuzzy scores, no vibes.
- **External evaluators** — the skill under test never judges itself. Deterministic checks first, LLM judges second.
- **Sacred regressions** — a change that improves average score but breaks a sacred case is rejected. Period.
- **One change at a time** — the optimizer proposes exactly one atomic change per experiment. No multi-variable confusion.
- **Baseline gating** — if the base model already does the job without the skill, the skill gets flagged for obsolete review.
- **Model-aware** — Haiku, Sonnet, and Opus are tested independently. Model variance is product reality, not noise.
- **Evidence-backed rollout** — every ship/no-ship decision comes with a structured evidence trail.

---

## Operator-Grade System Analysis

### Architecture (Seven Layers)

```
┌─────────────────────────────────────────────────┐
│                   CLI / CI / API                 │  Layer 7: Surfaces
├─────────────────────────────────────────────────┤
│                 Evidence Layer                   │  Layer 6: Persistence
├─────────────────────────────────────────────────┤
│               Optimization Layer                 │  Layer 5: Experiments
├─────────────────────────────────────────────────┤
│                Judgment Layer                    │  Layer 4: Scoring
├─────────────────────────────────────────────────┤
│              Observation Layer                   │  Layer 3: Capture
├─────────────────────────────────────────────────┤
│               Execution Layer                    │  Layer 2: Harness
├─────────────────────────────────────────────────┤
│                  Spec Layer                      │  Layer 1: Contracts
└─────────────────────────────────────────────────┘
```

| Layer | Responsibility | Key Entities |
|-------|---------------|-------------|
| **Spec** | Human-authored YAML eval contracts, criteria, test cases | `eval_specs`, `criteria`, `test_cases` |
| **Execution** | Runs skills against trigger, functional, regression, adversarial, baseline cases | `runs`, `skill_versions` |
| **Observation** | Captures outputs, artifacts, cost, latency, timing, observed outcomes | `observed_outcomes`, `outputs` |
| **Judgment** | Deterministic checks first, external LLM judges second, calibration, disagreement handling | `criterion_results` |
| **Optimization** | Failure clustering, weakest-criterion targeting, single atomic changes, accept/reject/revert | `experiments` |
| **Evidence** | Stores runs, scores, artifacts, diffs, regressions, baselines, launch reports | `regressions`, `baselines`, `launch_reports` |
| **CLI/CI/API** | Local author workflows, PR gating, team reporting, dashboard | — |

### Epic Roadmap (10 Epics, Sequential)

| # | Epic | Scope |
|---|------|-------|
| 01 | Repo Foundation | Workspace skeleton, governance, CI |
| 02 | Spec Layer | YAML eval contracts, criteria schema, test case format |
| 03 | Package Integrity | Deterministic structure/metadata validation |
| 04 | Evidence Layer | SQLite persistence, run lifecycle, evidence serialization |
| 05 | Trigger Harness | Roster builder, trigger simulation, precision/recall |
| 06 | Functional Execution | Skill invocation, context injection, artifact capture |
| 07 | Judgment Layer | Binary judge engine, calibration, per-model matrix |
| 08 | Regression/CLI/CI | Regression comparison, baseline gating, score aggregation, CLI, PR gate |
| 09 | Optimizer | Failure clustering, one-change proposals, experiment runner |
| 10 | Team Product | Dashboard, eval packs, drift reevaluation, obsolete-review |

### Non-Negotiable Design Principles

1. **Criteria must be binary** — yes or no, no gradients
2. **Evaluator is always separate** — the skill never judges itself
3. **Observed behavior outranks claimed behavior** — grade what happened, not what the skill says it does
4. **Regression tests are sacred** — a regression on a sacred case blocks release regardless of average improvement
5. **One change at a time** — optimizer proposes exactly one atomic change per experiment
6. **Blockers block release** — a blocker failure cannot be averaged out
7. **Baseline value matters** — if the naked model matches the skill, flag for obsolete review
8. **Model-aware testing is required** — Haiku/Sonnet/Opus differences are product reality

### Reference Library (32 files)

Self-contained library of templates, reference standards, agent patterns, and workflow diagrams under [`000-docs/`](000-docs/000-INDEX.md):

| Directory | Contents |
|-----------|----------|
| `templates/skill-templates/` | 6 SKILL.md structural patterns |
| `templates/eval-schemas/` | Eval JSON schemas |
| `references/skill-standards/` | AgentSkills.io spec, source-of-truth, frontmatter, validation rules |
| `references/eval-patterns/` | Eval methodology, workflows, output patterns |
| `references/agents/` | Grader, comparator, analyzer agent patterns |
| `references/enterprise-standards/` | 100-point rubric, production validator schema registry |
| `references/drift-and-consistency/` | Drift categories, source-of-truth hierarchy |
| `references/epic-workflows/` | 10 ASCII workflow diagrams (one per epic) |

### Current Status

**Phase:** Epic 01 complete (repo foundation). Ready for Epic 02 (Spec Layer).

pnpm monorepo with four workspace packages (`@j-rig/core`, `@j-rig/cli`, `@j-rig/db`, `@j-rig/dashboard`), TypeScript baseline (tsup builds), quality guardrails (ESLint, Prettier, Vitest), and CI/CD workflows.

---

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

**Jeremy Longshore** — [jeremylongshore](https://github.com/jeremylongshore) · Intent Solutions
