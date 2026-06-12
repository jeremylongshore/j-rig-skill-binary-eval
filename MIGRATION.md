# Migration Guide: j-rig v1.x → v2.0.0

Driven by ISEDC DR-018 (iaj-E02). All 5 workspace packages (`@j-rig/core`,
`@j-rig/cli`, `@j-rig/db`, `@j-rig/dashboard`, and the root private workspace)
bump to v2.0.0 simultaneously.

## Breaking change: predicate body (the primary migration)

The gate-result predicate body moves from j-rig's local v0.1.0-draft shape to
the kernel `@intentsolutions/core` `gate-result/v1` shape. The kernel is now the
canonical schema authority (DR-018 Option α).

### Field mapping: v1 → v2

| v1 field (v0.1.0-draft) | v2 field (gate-result/v1) | Notes |
|---|---|---|
| `result` | `gate_decision` | Values change: PASS→pass, FAIL→fail, ADVISORY→advisory. NOT_APPLICABLE is retired — see routing section below. |
| `timestamp` | `evaluated_at` | Field RENAME only — the value format is unchanged. RFC 3339 with timezone offset; the `Z` suffix (UTC) remains valid and is what the writer emits by default (`new Date().toISOString()` — lossless, preserves milliseconds). No `Z`→`+00:00` conversion is needed or correct. |
| _(new)_ | `gate_name` | Human-readable gate name in lowercase kebab-case. Required. |
| _(new)_ | `gate_version` | SemVer of the gate implementation. Required. |
| _(new)_ | `gate_reasons` | String array — decision rationale. Required (may be empty). |
| _(new)_ | `coverage` | Object: `{ dimensions_evaluated: string[], dimensions_skipped: string[] }`. Required. |
| _(new)_ | `policy_ref` | String in format `sha256:<64-hex>:<path>`. Required. |
| `policy_hash` | `policy_hash` | Unchanged. |
| `input_hash` | `input_hash` | Unchanged. |
| `runner` | `runner` | Unchanged (tool@semver format). |
| `commit_sha` | `commit_sha` | Unchanged. |
| `metadata?` | `metadata?` | Optional — unchanged. |
| `failure_mode?` | `failure_mode?` | Optional — unchanged. |
| `advisory_severity?` | `advisory_severity?` | Optional (required when gate_decision=advisory). |

New optional fields available in v2 (from kernel):
- `cost_record_ref` (UUIDv7) — reference to a CostRecord entity.
- `replay_fidelity_level` (RF-0..RF-4) — replay fidelity classification.
- `extensions` (Record<string, unknown>) — non-normative experimental fields on the Statement
  envelope (outside the predicate body; never used for ship/no-ship decisions).

Note: `gate_name` (a human-readable lowercase kebab-case label, e.g. `"coverage-check"`) is
intentionally distinct from the 3rd segment of `gate_id`'s mixed-case `tool:side:GATE` format
(e.g. `MM-1` in `j-rig:server:MM-1`). `gate_name` is the human label; `gate_id` is the
structural triple used for subject naming and pipeline-hop qualification.

### NOT_APPLICABLE routing (DR-018 §279)

`NOT_APPLICABLE` is no longer a valid `gate_decision` value. A gate dimension
that cannot be evaluated is represented via `coverage.dimensions_skipped`.

**v1 pattern (deprecated):**
```json
{ "result": "NOT_APPLICABLE", ... }
```

**v2 pattern:**
```json
{
  "gate_decision": "pass",
  "coverage": {
    "dimensions_evaluated": [],
    "dimensions_skipped": ["<dimension-name>"]
  },
  ...
}
```

The CLI `--result NOT_APPLICABLE` (or `--gate-decision NOT_APPLICABLE`) flag is
preserved for backward compatibility and routes automatically to this pattern:

- `gate_decision` is set to `"pass"`.
- The reserved token `"__not_applicable__"` is added to `coverage.dimensions_skipped`
  (non-colliding — a real dimension name passed via `--coverage-skipped` can never
  shadow this token since dimension names are caller-chosen and the token uses a
  reserved `__dunder__` form).
- A self-describing reason is appended to `gate_reasons`:
  `"routed from NOT_APPLICABLE per DR-018 §279 — non-verdict, not a pass"`.

**Important for verifiers**: a row with `gate_decision="pass"` AND
`coverage.dimensions_evaluated=[]` AND `coverage.dimensions_skipped=["__not_applicable__"]`
is a **non-verdict** — it does NOT indicate a passing gate. `intent-rollout-gate` MUST
inspect `coverage.dimensions_skipped` before treating any `pass` row as a positive signal.

### Predicate URI — UNCHANGED

The predicate URI is immutable per ISEDC CISO binding (DR-004 + DR-010 §10):

```
https://evals.intentsolutions.io/gate-result/v1
```

The `v1` suffix refers to the URI version slot (a standards commitment), not
the j-rig package version. The URI does not change when j-rig bumps to v2.0.0.

### In-toto statement type — UNCHANGED

```
https://in-toto.io/Statement/v1
```

## ComposeStatementInput (TypeScript API)

### v1 input

```typescript
interface ComposeStatementInput {
  gateId: string;
  result: "PASS" | "FAIL" | "ADVISORY" | "NOT_APPLICABLE";
  policyHash: string;
  inputHash: string;
  timestamp?: string;
  runner: string;
  commitSha: string;
  metadata?: Record<string, unknown>;
  failureMode?: string;
  advisorySeverity?: "info" | "warn" | "error";
}
```

### v2 input

```typescript
interface ComposeStatementInput {
  gateId: string;
  gateDecision: "pass" | "fail" | "advisory" | "error";
  gateName: string;        // NEW required — lowercase kebab-case
  gateVersion: string;     // NEW required — SemVer
  gateReasons: string[];   // NEW required — may be empty for clean pass
  coverage: {              // NEW required
    dimensionsEvaluated: string[];
    dimensionsSkipped: string[];
  };
  policyRef: string;       // NEW required — sha256:<hex>:<path>
  policyHash: string;
  inputHash: string;
  evaluatedAt?: string;    // was: timestamp (now uses offset format)
  runner: string;
  commitSha: string;
  metadata?: Record<string, unknown>;
  failureMode?: string;
  advisorySeverity?: "info" | "warn" | "error";
}
```

## CLI surface changes

### New required flags (direct mode)

| New flag | Description |
|---|---|
| `--gate-name <name>` | Gate name in lowercase kebab-case |
| `--gate-version <ver>` | Gate SemVer |
| `--policy-ref <ref>` | Policy reference `sha256:<hex>:<path>` |

### Renamed flag

| v1 flag | v2 flag | Notes |
|---|---|---|
| `--result <r>` | `--gate-decision <d>` | Values lowercase: `pass\|fail\|advisory\|error`. `NOT_APPLICABLE` still accepted for backward compat (routes to `coverage.dimensions_skipped`). |

### New optional flags (direct mode)

| New flag | Description |
|---|---|
| `--gate-reason <reason>` | Decision reason string (repeatable; appended to `gate_reasons`) |
| `--coverage-evaluated <dim>` | Dimension name added to `coverage.dimensions_evaluated` (repeatable) |
| `--coverage-skipped <dim>` | Dimension name added to `coverage.dimensions_skipped` (repeatable) |

## EvidenceBundleSchema (v2 wire format)

The v2 `"array"` container format is a **plain JSON array** (kernel
`EvidenceBundlePayload`), replacing the v1 `{ bundle_format: "json-array", rows: [...] }`
container.

**v2 emit:**
```json
[
  { "_type": "...", "subject": [...], "predicateType": "...", "predicate": {...} },
  ...
]
```

The reader still understands the v1 CONTAINER WRAPPER form
(`{ bundle_format: "json-array", rows: [...] }`) for backward-compatible reading.
However, **v1 PREDICATE BODIES** (rows using `result`/`timestamp` instead of
`gate_decision`/`evaluated_at`, and lacking the 5 new required fields) are validated
against the v2 schema and will be reported as row-level errors. The reader does not
silently accept v1-bodied rows. To consume a legacy v1 bundle, re-emit each row via
the gate that produced it using the current `j-rig emit-evidence` with the new flags.

Do not emit new bundles in the v1 container form — use the plain array.

## Downstream consumers (e.g. intent-rollout-gate)

Any consumer parsing the predicate body must update its parsing:

1. Replace `predicate.result` reads with `predicate.gate_decision`.
2. Replace `predicate.timestamp` reads with `predicate.evaluated_at`.
3. Add parsing for the 5 new required fields if needed.
4. Replace NOT_APPLICABLE decision handling with `coverage.dimensions_skipped` inspection.
5. The predicate URI stays the same — no routing changes needed.

## Schema authority (Option α)

Per DR-018, j-rig's `EvidenceStatementSchema` is now:

```
KernelEvidenceStatementSchema    ← structural authority (cross-field invariants I1 + I2)
  .superRefine(jRigSecondaryCheck)  ← belt-and-suspenders (same invariants, one-cycle retention)
```

The secondary check will be REMOVED in v3.0.0 per the one-cycle retention rule.
If the kernel and secondary check ever disagree (which should never happen by
design), the kernel wins — the secondary check is advisory only.

## Option α kernel imports

Available from `@intentsolutions/core@0.5.0`:

```typescript
import {
  EvidenceStatementSchema,
  EvidenceBundlePayloadSchema,
  IN_TOTO_STATEMENT_V1_TYPE,
  type EvidenceStatement,
  type EvidenceBundlePayload,
} from "@intentsolutions/core/validators/v1/evidence-statement";

import {
  GateResultV1Schema,
  GateDecisionSchema,
  AdvisorySeveritySchema,
  GATE_RESULT_V1_URI,
  type GateResultV1,
} from "@intentsolutions/core/validators/v1/gate-result-v1";
```
