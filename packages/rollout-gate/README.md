# @intentsolutions/rollout-gate

Thin, fail-closed rollout decision logic. Consumes a `gate-result/v1` Evidence
Bundle plus a rollout policy and returns an `allow` / `block` decision with
per-gate detail. This is the decision library the
[`intent-rollout-gate`](https://github.com/jeremylongshore/intent-rollout-gate)
GitHub Action delegates to (DR-018 / intent-rollout-gate DR-002 § 6).

## Naming

Internal workspace siblings use the `@j-rig/*` prefix and are private; this is
the only published package, so it ships under the `@intentsolutions/*` scope.

## API

```ts
import { decide, parsePolicy } from "@intentsolutions/rollout-gate";

const policy = parsePolicy({
  required_gates: ["audit-harness:ci:*"], // gate_id patterns; `*` is the only wildcard
  forbid_decisions: ["fail", "error"],    // default: both
  advisory_blocks: false,                 // default: false
  allow_unknown_gates: true,              // default: true
});

const result = decide(bundle, policy);
// result.decision  → "allow" | "block"
// result.reasons   → every blocking reason (empty exactly when "allow")
// result.evaluated → { required_gates: [...], rows: [...] } per-gate detail
```

`bundle` accepts both Evidence Bundle wire forms:

1. v2 plain array of in-toto Statements (kernel `EvidenceBundlePayload`)
2. v1 legacy container `{ "bundle_format": "json-array", "rows": [...] }`

Row validation reuses `@j-rig/core`'s `EvidenceStatementSchema` (the kernel
`@intentsolutions/core` gate-result/v1 statement schema plus j-rig's secondary
cross-field invariants) — no schema is re-declared here.

## Fail-closed semantics

`allow` requires ALL of the following; anything else blocks, with every
contributing reason listed:

| Condition | Outcome |
| --- | --- |
| Malformed bundle (not array, not known container) | block |
| Empty bundle (zero rows) | block |
| Schema-invalid row | block, citing the row index |
| Required gate pattern matches no row | block |
| Required gate matched but any matched row is not `pass` | block |
| Any row with a forbidden decision (`fail` + `error` by default) | block |
| Advisory row when `advisory_blocks: true` | block |
| Row matching no required pattern when `allow_unknown_gates: false` | block |
| Invalid policy passed to `decide()` | block (no throw) |

`parsePolicy()` throws on garbage instead — callers must not fall back to a
default policy on parse failure.

## License

Apache-2.0
