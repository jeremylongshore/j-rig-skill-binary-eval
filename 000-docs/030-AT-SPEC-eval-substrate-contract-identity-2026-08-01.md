# J-Rig eval-substrate contract identity

**Status:** IMPLEMENTATION APPLICATION OF `IEP-EVAL-EVOLUTION-001`
**Date:** 2026-08-01
**Master bead:** `bd_000-projects-htjt`
**Repo bead:** `bd_000-projects-htjt.2`
**Implementation bead:** `bd_000-projects-htjt.10.2`

## Boundary

The YAML file currently named `eval-spec.yaml` remains a supported user-facing
filename for backwards compatibility, but its J-Rig schema is a skill profile
named `SkillEvalSpec`. It is not the canonical kernel `EvalSpec` exported by
`@intentsolutions/core`.

The rename is deliberate:

- `SkillEvalSpecSchema` validates criteria, test cases, trigger expectations,
  model targets, judge settings, and sibling skill context.
- the kernel `EvalSpec` identifies a canonical declarative evaluation entity
  with its own version, assertions, composition DAG, runtime limits, and
  content hash;
- the J-Rig adapter maps a validated `SkillEvalSpec` to that canonical identity
  before shared Evidence Bundle or rollout claims are made.

J-Rig owns the skill profile because its criteria and test-case semantics are
execution-product concerns. The kernel remains the source of truth for the
canonical entity and does not absorb J-Rig's runtime schema.

## Migration rules

1. Existing `eval-spec.yaml` and `eval-spec.yml` paths remain readable.
2. Code and exports use `SkillEvalSpec` / `SkillEvalSpecSchema`; new code must
   not import or export the skill profile under the name `EvalSpec`.
3. Error messages and CLI help may say “eval spec” for user familiarity, but
   implementation references must identify the profile when the distinction
   matters.
4. The profile-to-kernel adapter must persist source-profile hash, profile
   version, mapping revision, kernel version, and canonical spec hash.
5. A failed profile validation cannot create a partial canonical spec, Run, or
   report.

## Currency baseline

All active J-Rig package pins and the CI evidence emitter consume
`@intentsolutions/core@0.10.0`. `@intentsolutions/refiner-core` also exposes
`CONSUMED_KERNEL_VERSION = "0.10.0"`; its baseline supersession logic uses
that value as the current kernel surface.

## Adapter implementation

`adaptSkillEvalSpec` is the explicit profile-to-kernel boundary. It validates
the profile first, emits a strict canonical `EvalSpec`, and returns a separate
lineage envelope containing the source-profile hash, profile version, mapping
revision, consumed kernel version, canonical content hash, criterion identity
and blocker policy, plus evaluated/skipped test-case coverage. The canonical
object uses the kernel's extension assertion slot for J-Rig criterion detail;
the lineage envelope is required alongside it for shared evidence or rollout
claims.

The adapter hashes the normalized, validated profile rather than the raw YAML
mapping so schema defaults are part of the recorded source identity. It
requires the caller to provide canonical identity, timestamp,
actor, runtime limits, and provider constraints. It uses a deterministic
sorted-key JSON hash and rejects both invalid profiles and invalid canonical
output without returning a partial result. `eval-spec.yaml` remains the
user-facing profile filename; it is not itself a kernel `EvalSpec`.
