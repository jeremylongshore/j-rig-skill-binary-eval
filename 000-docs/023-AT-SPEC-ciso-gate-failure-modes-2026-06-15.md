# CISO PASS/FAIL Gate Failure-Mode Reference

**Date:** 2026-06-15
**Epic:** 06 — Functional Execution Harness and Observation Layer (iaj-E06)
**Scope:** Failure-mode documentation for the two CISO security gates (G-1, G-2)
**Source of truth:** `packages/core/src/providers/ciso-gates/` + PB-7 measurement protocol § 6 (`000-docs/018-AT-SPEC-pb7-adapter-measurement-protocol-2026-05-12.md`)

---

## Purpose

The CISO gates are PASS/FAIL security checks run against a provider adapter during a real
invocation. They do not score quality — they answer one binary question each: did the adapter
leak the credential it was handed? Both gates return a structured result (never throw) so a
caller can record evidence and route a FAIL to a blocking outcome.

This document enumerates every failure mode each gate can report, what produces it, and how a
caller should interpret it. It is a companion to the gate source, not a replacement: the
`reason` string each gate returns is authored to be self-describing at the call site.

Public API (`@j-rig/core`, `providers/ciso-gates/index.ts`):

```ts
import { runCisoGateG1, type G1Result } from "@j-rig/core";
import { runCisoGateG2, type G2Result } from "@j-rig/core";
```

Both gates take a caller-supplied `invokeProvider: () => Promise<void>` that MUST trigger at
least one model call, plus a high-entropy synthetic `testKey` (NOT a real credential), plus an
optional `timeoutMs` (default 30 000 ms). The caller is responsible for wiring the `testKey`
into the adapter's environment/config before invoking — the gates never inject it themselves.

---

## Gate G-1 — credential redaction

**Question:** does any 8+-character contiguous substring of the test key appear in anything the
adapter emitted during the invocation?

**Channels captured during the harness window:**

1. `process.stdout.write` / `process.stderr.write` (teed into the capture buffer).
2. Local log-file writes via the `fs` module — `writeFileSync`, `appendFileSync`,
   `createWriteStream` (every `.write` on the returned stream), and the `fs/promises` +
   callback forms of `writeFile`/`appendFile`.
3. OpenTelemetry spans — an `InMemorySpanExporter` is installed as the global tracer provider's
   delegate for the harness window; after the adapter runs, every recorded span name, attribute
   value, and event (name + attributes) is appended to the buffer.

All intercepts and the tracer-provider delegate are reverted in a `finally` block, so a
panicking adapter cannot leave process I/O, the `fs` module, or telemetry permanently rerouted.

### G-1 result modes

| `pass` | `reason` shape | Trigger | Caller action |
| --- | --- | --- | --- |
| `false` | `testKey is shorter than the leak-detection window (8 chars); cannot evaluate redaction` | Caller passed a `testKey` under 8 chars. **Misconfiguration, not an adapter verdict.** | Fix the test harness — supply a high-entropy key (`sk-test-G1-` + 32 random alphanumerics). |
| `false` | `invocation exceeded timeoutMs=<n>; cannot evaluate redaction on a hung adapter` | `invokeProvider()` did not settle before the timeout. A hung adapter cannot be evaluated, so timeout is treated as FAIL. | Investigate the adapter hang. Re-run with a longer `timeoutMs` only if the hang is a known-slow path, not a defect. |
| `false` | `<n> substring(s) of the test key appeared in captured stdout+stderr+log-file+OTel-span output; redaction failed` | One or more 8+-char substrings of the key were found in captured output. **This is the real leak verdict.** `leakedSubstrings` + truncated `capturedOutput` (4000 chars) are present for debugging. | BLOCK. The adapter leaks credentials on some channel. Use `leakedSubstrings` + `capturedOutput` to locate the leak (log line, span attribute, error message). |
| `true` | `zero key substrings (≥8 chars) found in captured stdout+stderr+log-file+OTel-span output` | No leak detected. `capturedOutput` is truncated to 200 chars on PASS. | PASS. |
| `true` | `…output (note: invokeProvider threw '<message>'; not a gate failure)` | The adapter threw, but no leak was detected. **The throw does not fail the gate** — G-1 is about redaction, not call success. | PASS for redaction. Separately decide whether the underlying throw matters for your run. |

**Key interpretation rule:** an `invokeProvider` throw is surfaced in the `reason` suffix but is
NOT a G-1 failure. Only a substring match or a timeout fails G-1. The short-key case is a
harness misconfiguration that the gate refuses to evaluate rather than silently passing.

---

## Gate G-2 — env-var spillover

**Question:** does the test key leak into the environment of any child process the adapter
spawns?

**Mechanism:** the runner monkey-patches `child_process.{spawn, spawnSync, exec, execSync,
fork}` for the duration of `invokeProvider()` and inspects the `env` passed to (or inherited by)
each spawned child. This catches the leak vector before the child can print or write the key —
strictly stronger than a `/proc/<pid>/environ` snapshot, which has race-window blind spots. As
defense-in-depth it also reads `/proc/<child-pid>/environ` for any child that lives long enough
(matching the PB-7 spec verbatim). Patched functions are restored in `finally`.

### G-2 result modes

| `pass` | `reason` shape | Trigger | Caller action |
| --- | --- | --- | --- |
| `false` | `testKey shorter than 8 chars; cannot evaluate spillover` | Caller passed a `testKey` under 8 chars. **Misconfiguration, not an adapter verdict.** | Fix the harness — supply a high-entropy key. |
| `false` | `invocation exceeded timeoutMs=<n>; cannot evaluate spillover on a hung adapter` | `invokeProvider()` did not settle before the timeout. | Investigate the hang; same posture as G-1 timeout. |
| `false` | `<n> subprocess(es) had the test key in their environment` | The key was found in one or more spawned children's environments. **This is the real spillover verdict.** `spawnedPids` + `perChildLeaks` (pid, command, leaked env vars, detection source) are present. | BLOCK. The adapter forwards credentials into subprocess environments. Use `perChildLeaks` to identify which spawn (`spawn-hook` vs `proc-environ` source) carried the key. |
| `true` | `<n> subprocess(es) inspected; no test-key spillover detected` | No child env contained the key (including the zero-spawn case — an adapter that spawns nothing passes). | PASS. |
| `true` | `…detected (note: invokeProvider threw '<message>'; not a gate failure)` | The adapter threw, but no spillover detected. The throw does not fail the gate. | PASS for spillover. Decide separately on the throw. |

**Zero-spawn note:** an adapter that performs completions over an in-process HTTP client and
never spawns a child process passes G-2 trivially (`0 subprocess(es) inspected`). That is a
correct PASS, not a gap — there is no spillover surface.

---

## Cross-gate rules

1. **Gates never throw.** Every code path returns a structured result. A caller can always
   record a verdict and route a FAIL to a blocking outcome.
2. **Short key ⇒ refuse, not pass.** Below the 8-char leak-detection window, neither gate can
   reliably detect a substring; both FAIL with a "cannot evaluate" reason rather than passing
   a check they could not actually run.
3. **Timeout ⇒ FAIL.** A hung adapter is treated as a failure because an un-settled invocation
   cannot be evaluated and would otherwise leave interceptors installed.
4. **Adapter throw ⇒ not a gate failure.** Each gate is scoped to its one security question.
   An invocation error is surfaced in the `reason` suffix for the caller to interpret, but does
   not, on its own, flip the gate to FAIL.
5. **Restore is always in `finally`.** I/O intercepts (G-1), the tracer-provider delegate
   (G-1), and the `child_process` patches (G-2) are unconditionally reverted, so a panicking
   adapter cannot corrupt the host process for subsequent gates or runs.

---

## Where this runs in CI

Both gate runners are exercised by the vitest suite
(`g1-credential-redaction.test.ts`, `g2-env-var-spillover.test.ts`) against the
`clean-provider` and `leaky-provider` fixtures in
`packages/core/src/providers/test-fixtures/`. That suite runs inside the required **Test** CI
job (`.github/workflows/ci.yml`), so a regression in either gate's failure-mode behavior blocks
merge to `main`.
