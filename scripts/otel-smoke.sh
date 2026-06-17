#!/usr/bin/env bash
# otel-smoke.sh — end-to-end smoke for the iaj-E08 OTel emitter.
#
# Runs a full j-rig eval (stub providers, J_RIG_OTEL=1) and asserts that every
# event name the 067 taxonomy binds j-rig to emit
# (intent-eval-lab/000-docs/067-AT-SPEC-runtime-event-taxonomy-2026-06-12.md
# §§ 1.1, 1.2, 2.2) actually fires across the execution path, that each carries
# the required eval.run_id correlation key (067 § 4.2), and that the
# gate.decision.emitted spelling matches the audit-harness iah-E07 emitter.
#
# Stub mode is sufficient HERE: this lane verifies the telemetry PLUMBING (names
# + payloads + correlation), not eval correctness. The real-provider behavioral
# dogfood is a separate concern (iaj-E10 / scripts/dogfood.sh).
#
# Exit codes:
#   0 — all expected event names emitted with required correlation metadata
#   1 — a required event name was missing, or an event lacked eval.run_id
#   2 — the eval invocation itself failed unexpectedly

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CLI="packages/cli/dist/index.js"
SKILL="packages/core/fixtures/packages/valid-skill"
SPEC="packages/core/fixtures/valid/eval-spec.yaml"

if [[ ! -f "$CLI" ]]; then
  echo "otel-smoke: CLI not built at $CLI — run 'pnpm run build' first" >&2
  exit 2
fi

TMPDB="$(mktemp -u --suffix=.db)"
ERRLOG="$(mktemp)"
trap 'rm -f "$TMPDB" "$ERRLOG"' EXIT

# Run the eval. Stub mode is opt-in (J_RIG_ALLOW_STUB=1); OTel stderr emission
# is opt-in (J_RIG_OTEL=1). The eval's own exit status is allowed to be nonzero
# (stub deterministic checks legitimately fail) — we only care that it RAN and
# emitted telemetry, so we capture stderr and don't `set -e`-abort on the run.
set +e
J_RIG_ALLOW_STUB=1 J_RIG_OTEL=1 node "$CLI" eval "$SKILL" \
  --spec "$SPEC" --models sonnet --db "$TMPDB" >/dev/null 2>"$ERRLOG"
set -e

# Pull the emitted [OTEL] event names + assert every line carries eval.run_id.
python3 - "$ERRLOG" <<'PY'
import json, sys

errlog = sys.argv[1]
EXPECTED = {
    "runtime.run.started",
    "runtime.run.finished",
    "runtime.criterion.evaluated",
    "judge.invoked",
    "judge.verdict",
    "gate.decision.emitted",
}

seen = set()
missing_run_id = []
with open(errlog, encoding="utf-8") as fh:
    for line in fh:
        if not line.startswith("[OTEL] "):
            continue
        try:
            ev = json.loads(line[len("[OTEL] "):])
        except json.JSONDecodeError:
            print(f"otel-smoke: FAIL — non-JSON [OTEL] line: {line!r}", file=sys.stderr)
            sys.exit(1)
        name = ev.get("name")
        seen.add(name)
        run_id = ev.get("attributes", {}).get("eval.run_id")
        if not run_id:
            missing_run_id.append(name)

missing = EXPECTED - seen
if missing:
    print(f"otel-smoke: FAIL — expected event names never emitted: {sorted(missing)}",
          file=sys.stderr)
    print(f"otel-smoke: events seen: {sorted(seen)}", file=sys.stderr)
    sys.exit(1)

if missing_run_id:
    print(f"otel-smoke: FAIL — events missing required eval.run_id (067 § 4.2): "
          f"{sorted(set(missing_run_id))}", file=sys.stderr)
    sys.exit(1)

# Spot-check the gate.decision.emitted payload spelling matches iah-E07.
gate_ok = False
with open(errlog, encoding="utf-8") as fh:
    for line in fh:
        if not line.startswith("[OTEL] "):
            continue
        ev = json.loads(line[len("[OTEL] "):])
        if ev.get("name") == "gate.decision.emitted":
            a = ev.get("attributes", {})
            for key in ("gate.name", "gate.decision", "gate.policy_ref"):
                if key not in a:
                    print(f"otel-smoke: FAIL — gate.decision.emitted missing {key}",
                          file=sys.stderr)
                    sys.exit(1)
            gate_ok = True
if not gate_ok:
    print("otel-smoke: FAIL — gate.decision.emitted never emitted", file=sys.stderr)
    sys.exit(1)

print(f"otel-smoke: PASS — all {len(EXPECTED)} j-rig event names emitted with eval.run_id")
print(f"otel-smoke: events: {', '.join(sorted(seen & EXPECTED))}")
PY
