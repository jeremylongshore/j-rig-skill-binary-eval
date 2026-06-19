# 018-AT-SPEC — PB-7 provider adapter measurement protocol

| Field                                 | Value                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Date**                              | 2026-05-12                                                                                               |
| **Status**                            | Normative — gating doc per ISEDC v1 Q5 CTO binding constraint                                            |
| **Plan reference**                    | Milestone 4 of `~/.claude/plans/se-the-council-bubbly-frog.md`                                           |
| **Source decisions**                  | `intent-eval-platform/intent-eval-lab/000-docs/004-AT-DECR-isedc-council-record-2026-05-10.md` § Q5      |
| **Locks (when measurement complete)** | A new Decision Record `0NN-AT-DECR-provider-adapter-choice-<date>.md` in this same `000-docs/` directory |

---

## 1. Why this document exists

ISEDC Session 1 (2026-05-10) deliberated provider-adapter choice for j-rig and concluded with a deliberately-deferred decision: rather than pick LiteLLM or Vercel AI SDK by argument, the choice is **punted to in-prototype measurement**. The CTO seat's binding constraint accompanying that punt was:

> A measurement protocol — specifying what we measure, how, and what counts as a winning verdict — must be committed to the repo BEFORE either prototype is written. Picking a winner after-the-fact by inspecting prototypes that already exist is the failure mode this binding prevents. Future readers must be able to verify the lock was determined by the rubric, not the rubric retro-fitted to the lock.

This document is that protocol. It is normative. The subsequent Decision Record that locks the choice MUST cite the data this protocol produces.

## 2. Scope

### 2.1 In scope

- The eval cases each prototype runs to produce measurable signal (§ 4)
- The rubric dimensions, with explicit pass/fail or comparison semantics (§ 5)
- The CISO non-negotiable PASS/FAIL gates that BOTH prototypes MUST satisfy (§ 6)
- The CMO launch-leaderboard requirement that constrains the choice (§ 7)
- The GC license-audit procedure that runs before the lock (§ 8)
- The tiebreaker dimension when the primary rubric is inconclusive (§ 9)

### 2.2 Out of scope

- Whether to ship a provider-adapter abstraction at all (already decided: yes, M4)
- The Provider interface signature itself (separate doc / source file)
- Provider selection beyond the LiteLLM-vs-Vercel-AI-SDK punt (e.g., adding a third candidate would re-trigger this protocol against the expanded set)
- Production runtime tuning (cost, latency caps) — addressed downstream in M5 dogfood

## 3. Conformance keywords

The keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used per RFC 2119.

## 4. Eval cases

The prototype for each candidate adapter (LiteLLM, Vercel AI SDK) **MUST** implement and execute the following five eval cases. Each case is a real j-rig eval flow exercising one slice of the Provider surface. The cases are intentionally cross-cutting so the rubric in § 5 has signal across the surface, not on a single dimension.

### EC-1 — Single completion, structured output

**Setup:** A j-rig eval run that asks the model to evaluate one criterion against one observed outcome. Expected response shape: a structured JSON object with `verdict: yes|no|unsure` and `reasoning: string`.

**Models exercised:** Anthropic Claude Sonnet, OpenAI GPT-4o (or equivalent current model), Google Gemini Pro. **Three providers** so we exercise the adapter's multi-provider abstraction, not just one.

**Verdict surface:** Did the adapter return parseable structured output for all three? Did it require model-specific request-shape handling (JSON mode flags, system-prompt placement, response-schema validation)? Record the answer to each.

### EC-2 — Streaming completion

**Setup:** Same prompt as EC-1 but request streaming output. The adapter MUST expose a streaming API surface.

**Verdict surface:** Does the adapter expose streaming as first-class, or is it bolted on? Does the stream surface emit token-level events, chunk-level events, or both? Does it propagate provider-specific event types (Anthropic's content-block-start/stop, OpenAI's chunk objects, Gemini's stream parts) into a normalized shape?

### EC-3 — Tool calling

**Setup:** A j-rig eval where the model is given a tool schema (one function with three parameters) and asked to call it correctly given a prompt. Test both legal tool-call generation and a case where the model should decline to call.

**Verdict surface:** Does the adapter normalize tool-call format across providers (Anthropic's `tool_use` content blocks vs OpenAI's `tool_calls` array vs Gemini's function-call parts)? Does the normalization lose information? How does the adapter surface partial tool-call streams?

### EC-4 — Error category enumeration

**Setup:** Deliberately trigger the following error categories per provider and observe the adapter's emitted error type/shape:

- Authentication failure (bad API key)
- Rate-limit hit (rapid-fire requests)
- Model not found (typo in model name)
- Content-policy refusal (model returns a refusal not an error)
- Network timeout (configurable provider-side timeout)

**Verdict surface:** Does the adapter expose a unified error taxonomy that maps provider-specific errors to a common shape? Or do callers have to handle provider-specific error types? How does it distinguish "model refused" (legitimate outcome) from "provider errored" (infrastructure issue)?

### EC-5 — Concurrent request batching

**Setup:** Send 10 concurrent requests through the adapter against the same provider, measure aggregate latency vs serial sequential.

**Verdict surface:** Does the adapter expose a batching primitive? Does it respect provider-specific concurrency limits? How does it propagate per-request errors when some succeed and some fail in a batch?

## 5. Rubric — four primary dimensions

The five eval cases (§ 4) feed four scoring dimensions. The candidate with the higher score across the four wins; ties go to § 9.

### R5.1 — Type safety

| Score | Criterion                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 3     | Full TypeScript types across all 5 eval cases; `tsc --strict` clean; tool-call schemas type-narrow correctly |
| 2     | Types cover the public API but some internals use `any` or `unknown`; `tsc --strict` clean                   |
| 1     | Types are partial or `tsc --strict` produces warnings                                                        |
| 0     | Untyped; `any` pervasive                                                                                     |

### R5.2 — Lines of code (LOC) for the adapter implementation

| Score | Criterion                                             |
| ----- | ----------------------------------------------------- |
| 3     | Adapter implementation < 300 LOC for the 5 eval cases |
| 2     | 300-600 LOC                                           |
| 1     | 600-1000 LOC                                          |
| 0     | > 1000 LOC                                            |

Counted via `cloc packages/cli/src/providers/{candidate}.ts` excluding tests and fixtures (matches the existing naming convention in that directory: `anthropic.ts`, `openai.ts`, etc.). LOC is a proxy for the SDK's level of abstraction; a low-LOC wrapper indicates the underlying SDK already normalizes most of the surface.

### R5.3 — Request-side feature coverage

For each of the 5 eval cases, score:

| Score | Criterion                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 3     | Adapter handles the case for ALL three providers (Anthropic, OpenAI, Gemini) with identical caller-side code |
| 2     | Handles 2 of 3 providers identically; one requires provider-specific caller code                             |
| 1     | Handles 1 of 3; or all 3 with significant per-provider divergence in caller-side code                        |
| 0     | Does not handle the case at all                                                                              |

Total possible: 15. Reported as a fraction of 15 in the Decision Record.

### R5.4 — Runtime error categories

For the 5 error categories in EC-4, score:

| Score | Criterion                                                                         |
| ----- | --------------------------------------------------------------------------------- |
| 3     | Maps to a unified error type with category and provider both surfaced; documented |
| 2     | Maps to a unified error type but category boundaries unclear                      |
| 1     | Surfaces a provider-specific error class; caller must switch on provider          |
| 0     | Throws a generic Error; category not recoverable                                  |

Total possible: 15.

## 6. CISO non-negotiable PASS/FAIL gates

These gates are **independent of the four-dimensional rubric**. They are pass/fail. BOTH prototypes MUST satisfy BOTH gates before either can be considered for the lock. A prototype that fails one of these gates is **disqualified**, regardless of how well it scores on the rubric.

### G-1 — Credential redaction

**Test:** Run the prototype against the EC-1 eval case at debug verbosity (`AUDIT_HARNESS_OTEL=1`, `DEBUG=*`). Capture every line emitted to stdout, stderr, OTel telemetry, and any local log files. Grep the captured output for any substring of the API key used (any contiguous 8+ characters of the key value).

**Pass criterion:** Zero substring matches across the entire captured output. The key value MUST NOT appear in any debug/log/telemetry output.

**Source ref:** ISEDC v1 Q5 CISO binding.

### G-2 — Environment-variable spillover

**Test:** Set provider API keys via environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENAI_API_KEY`). Invoke the adapter to make one request. While the request is in flight, snapshot `/proc/<adapter-process-pid>/environ` and `/proc/<adapter-subprocess-pid>/environ` for any child process the adapter spawns.

**Pass criterion:** No child-process environment contains the API key value. The adapter MUST sanitize the environment before any subprocess spawn (or simply not spawn subprocesses).

**Source ref:** ISEDC v1 Q5 CISO binding.

### G-3 — Multi-tenant routing isolation (FUTURE.md trigger)

Not gated for Phase B v1 lock. Becomes required when the gateway / federated MCP server work fires per `intent-eval-lab/000-docs/FUTURE.md` "Gateway / Universal MCP Server" entry. Listed here so future readers see the full CISO surface.

## 7. CMO launch-leaderboard commitment

The Decision Record locking the provider-adapter choice **MUST** name at least **3 specific providers** the chosen adapter ships with first-class support for. The launch leaderboard for the chosen adapter is one of the items measured (§ 4 EC-1 explicitly uses 3 providers for this reason).

**Source ref:** ISEDC v1 Q5 CMO binding.

## 8. GC license audit

Before the Decision Record locks the choice, run a license audit:

- For Vercel AI SDK candidate: `npm-license-checker --summary` against the prototype's transitive deps tree.
- For LiteLLM candidate: `pip-licenses` against the prototype's transitive deps tree (note: LiteLLM is Python-native; the Node-side adapter would wrap it via a subprocess or HTTP proxy, so this audit includes the Python deps too).

**Pass criterion:** No GPL-family license (GPLv2, GPLv3, AGPL) in the transitive tree. MIT, Apache 2.0, BSD-2, BSD-3, ISC, Unlicense, MPL-2.0 are acceptable. Anything else MUST be discussed in the Decision Record with explicit GC sign-off.

**NOTICE file update:** the chosen adapter's deps that require attribution (Apache 2.0, BSD families) MUST be enumerated in this repo's `NOTICE` file (created if absent) per their license terms.

**Source ref:** ISEDC v1 Q5 GC binding.

## 9. Tiebreaker dimension

If the four-dimensional rubric (§ 5) produces a tie (sum-of-scores within ±1 across candidates), the tiebreaker is **adoption velocity**:

- Measure the adapter's package-manager install count over the trailing 30 days (npm registry weekly downloads × 4.3, or PyPI download stats).
- Higher recent adoption wins.

**Why this is the tiebreaker:** adoption velocity is a proxy for which SDK the surrounding ecosystem (LangChain, Mastra, Continue, etc.) integrates against. A provider-adapter SDK whose downstream consumers shrink during the prototype window is a leading indicator of obsolescence. This is the rubric of last resort — the other four dimensions should resolve the choice in nearly all cases.

If adoption velocity is also within ±10% across candidates, the choice falls to the CTO seat (in-house judgment) and is documented as such in the Decision Record.

## 10. Reporting format — Decision Record acceptance

The Decision Record that locks the choice **MUST**:

1. Cite this document by docno (`018-AT-SPEC`).
2. For each of the 5 eval cases (§ 4): include the actual measured outcome for both prototypes.
3. For each of the 4 rubric dimensions (§ 5): include the actual score for both prototypes with one-sentence justification.
4. For each of the 2 CISO gates (§ 6 G-1, G-2): explicit PASS or FAIL with the captured-output excerpt or `/proc` snapshot as evidence.
5. The chosen 3+ launch-leaderboard providers per § 7.
6. The license-audit output per § 8 plus the diff applied to `NOTICE`.
7. If tiebreaker invoked: § 9 measurement.
8. The chosen adapter, the rationale anchored in the data above, and the dissent surface (any seat that voted against the choice in the locking ISEDC session, by name, with their one-line position).

## 11. Process — what runs when

| Step | Owner                | Deliverable                                                                                                              | Source ref             |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 1    | engineering          | This protocol committed to repo                                                                                          | This doc (Milestone 4) |
| 2    | engineering          | LiteLLM prototype implementing the 5 eval cases + 2 CISO gates                                                           | Phase 2 of M4          |
| 3    | engineering          | Vercel AI SDK prototype implementing the 5 eval cases + 2 CISO gates                                                     | Phase 2 of M4          |
| 4    | engineering          | Score-card spreadsheet (the actual data per § 5)                                                                         | Phase 3 of M4          |
| 5    | GC seat              | License audit per § 8                                                                                                    | Phase 3 of M4          |
| 6    | acting head of board | Decision Record convened, evaluating the data per § 10 acceptance                                                        | Phase 4 of M4          |
| 7    | engineering          | Loser-prototype deletion; winner-adapter promoted to `packages/cli/src/providers/`; CISO gate test suite committed to CI | Phase 5 of M4          |

Steps 2 + 3 can run in parallel. Steps 4 + 5 gate Step 6.

## 12. Anti-patterns — refuse on sight

- **Retro-fitting the rubric to the result.** If during measurement one rubric dimension produces an outcome that "feels wrong," do NOT adjust the dimension's scoring. File a separate concern in the Decision Record dissent section and have the council deliberate it. This binding is the CTO seat's central reason for requiring the protocol up-front.
- **Skipping a CISO gate "because the rubric is close."** A CISO gate failure DISQUALIFIES a candidate. Not "downgrades to second place."
- **Locking the choice without 3 named providers in the leaderboard.** This is a hard CMO binding.
- **Inviting "let's just go with what the team already uses" reasoning.** That violates the punt's whole purpose.

## 13. Cross-references

- ISEDC v1 record: `intent-eval-platform/intent-eval-lab/000-docs/004-AT-DECR-isedc-council-record-2026-05-10.md` § Q5
- Phase B scope refinement plan: `intent-eval-platform/intent-eval-lab/000-docs/003-PP-PLAN-phase-b-scope-refinement.md` (PB-7)
- Build journey master plan: `~/.claude/plans/se-the-council-bubbly-frog.md` (Milestone 4)
- Evidence Bundle SPEC v0.1.0-draft (which the chosen adapter ultimately emits against): `intent-eval-platform/intent-eval-lab/specs/evidence-bundle/v0.1.0-draft/SPEC.md`
- /exec-decision-council skill (which adjudicates the lock): `~/.claude/skills/exec-decision-council/`

## 14. License

Apache 2.0 — this repo's root LICENSE.
