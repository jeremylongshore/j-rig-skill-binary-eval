#!/usr/bin/env bash
# dogfood.sh — iaj-E10 real behavioral dogfood.
#
# Runs the j-rig seven-layer eval against j-rig's OWN skill (skill/SKILL.md)
# with a REAL provider, then emits the run's rollout decision as a
# signed-capable in-toto Evidence Bundle (gate-result/v1) and verifies it
# round-trips. This is the dogfood the prior pass faked with stub providers:
# here the trigger / execution / judge layers all hit a real model API and the
# output IS ground truth.
#
# The default provider is DeepSeek (the Anthropic external-API credit is
# exhausted; DeepSeek credits are live). DeepSeek, Kimi/Moonshot, and OpenRouter
# are all OpenAI-Chat-Completions-compatible, so any of them works via the same
# provider — just point --provider at it.
#
# ONE-COMMAND RUN
#   bash scripts/dogfood.sh --sops --smoke
#   # decrypts the matching key (default DEEPSEEK_API_KEY) from the lab
#   # .env.sops to a memory var (never disk) and runs a tiny real eval.
#
# FLAGS
#   --provider NAME Provider to use: deepseek (default) | kimi | moonshot |
#                   openrouter | anthropic. Selects which key --sops decrypts and
#                   which endpoint the eval hits.
#   --sops          Decrypt the provider's key from the lab .env.sops to a memory
#                   var (never written to disk) before running.
#   --models LIST   Comma-separated model list. Default is provider-specific
#                   (deepseek-chat / sonnet / …); override to pin a snapshot.
#   --smoke         Tiny run: a single core test case, no adversarial layer, for
#                   a cheap end-to-end ground-truth check (1-2 model calls).
#   --sign          Sign the Evidence Bundle via cosign (keyless). Off by
#                   default (unsigned Statement still round-trips + verifies).
#   --out DIR       Output directory for the bundle + run json (default:
#                   evidence/dogfood).
#
# EXIT CODES
#   0  real eval ran + Evidence Bundle emitted + round-trip verified
#   1  no real API key available (refuses to fake the dogfood with stubs)
#   2  the eval invocation failed unexpectedly
#   3  Evidence Bundle emission or round-trip verification failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PROVIDER="deepseek"
MODELS=""
USE_SOPS=0
SMOKE=0
SIGN=0
OUT_DIR="evidence/dogfood"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --sops)   USE_SOPS=1; shift ;;
    --models) MODELS="$2"; shift 2 ;;
    --smoke)  SMOKE=1; shift ;;
    --sign)   SIGN=1; shift ;;
    --out)    OUT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "dogfood: unknown flag $1" >&2; exit 1 ;;
  esac
done

# Normalize the provider + resolve which key env var it needs and a sensible
# default model. moonshot is an alias for kimi (same vendor).
PROVIDER="$(echo "$PROVIDER" | tr '[:upper:]' '[:lower:]')"
case "$PROVIDER" in
  deepseek)            KEY_ENV="DEEPSEEK_API_KEY";   DEFAULT_MODEL="deepseek-chat" ;;
  kimi|moonshot)       KEY_ENV="MOONSHOT_API_KEY";   DEFAULT_MODEL="kimi-k2-0711-preview" ;;
  openrouter)          KEY_ENV="OPENROUTER_API_KEY"; DEFAULT_MODEL="deepseek/deepseek-chat" ;;
  anthropic)           KEY_ENV="ANTHROPIC_API_KEY";  DEFAULT_MODEL="sonnet" ;;
  *) echo "dogfood: unknown --provider '$PROVIDER' (deepseek|kimi|moonshot|openrouter|anthropic)" >&2; exit 1 ;;
esac
[[ -z "$MODELS" ]] && MODELS="$DEFAULT_MODEL"

CLI="packages/cli/dist/index.js"
SKILL_DIR="skill"
SPEC="skill/eval.yaml"
SMOKE_SPEC="skill/eval.smoke.yaml"

if [[ ! -f "$CLI" ]]; then
  echo "dogfood: CLI not built at $CLI — run 'pnpm run build' first" >&2
  exit 2
fi

# --- Resolve the provider's real key (memory only, never disk) ---------------
# We decrypt/read ONLY the key the chosen provider needs. The eval CLI selects
# the matching OpenAI-compatible endpoint from that key's presence (DeepSeek /
# Kimi / OpenRouter), or the Anthropic path for ANTHROPIC_API_KEY.
if [[ "$USE_SOPS" == "1" ]]; then
  LAB_SOPS="${REPO_ROOT}/../intent-eval-lab/.env.sops"
  if [[ ! -f "$LAB_SOPS" ]]; then
    echo "dogfood: --sops requested but lab .env.sops not found at $LAB_SOPS" >&2
    exit 1
  fi
  if ! command -v sops >/dev/null 2>&1; then
    echo "dogfood: --sops requested but 'sops' is not on PATH" >&2
    exit 1
  fi
  # Decrypt ONLY the one key we need, to a shell var. The decrypted plaintext
  # never touches disk (no temp file); sops writes to stdout, captured in-proc.
  DECRYPTED_KEY="$(sops -d --input-type dotenv --output-type dotenv "$LAB_SOPS" \
    | sed -nE "s/^${KEY_ENV}=(.*)\$/\1/p" | tr -d '"'"'"'')"
  if [[ -z "$DECRYPTED_KEY" ]]; then
    echo "dogfood: --sops decrypted no $KEY_ENV from $LAB_SOPS (is it set for provider '$PROVIDER'?)" >&2
    exit 1
  fi
  export "${KEY_ENV}=${DECRYPTED_KEY}"
fi

# Confirm the chosen provider's key is present (from --sops or the ambient env).
if [[ -z "${!KEY_ENV:-}" ]]; then
  echo "dogfood: REFUSED — no $KEY_ENV available for provider '$PROVIDER'." >&2
  echo "dogfood: this is the REAL behavioral dogfood; it will not fake ground truth with stubs." >&2
  echo "dogfood: set $KEY_ENV, or run with --sops to decrypt the lab key to memory." >&2
  exit 1
fi

# --- Build the smoke spec on the fly (single core case, no adversarial) ------
ACTIVE_SPEC="$SPEC"
if [[ "$SMOKE" == "1" ]]; then
  MODELS="$MODELS" python3 - "$SPEC" "$SMOKE_SPEC" <<'PY'
import os, sys
try:
    import yaml
except ImportError:
    print("dogfood: --smoke needs PyYAML (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)
src, dst = sys.argv[1], sys.argv[2]
with open(src) as fh:
    spec = yaml.safe_load(fh)
# Keep a single core test case so the smoke is 1-2 model calls.
core = [tc for tc in spec.get("test_cases", []) if tc.get("tier") == "core"]
spec["test_cases"] = core[:1]
# Keep only the criteria the kept case references + their dependencies.
kept_ids = set()
for tc in spec["test_cases"]:
    kept_ids.update(tc.get("criteria_ids", []))
spec["criteria"] = [c for c in spec.get("criteria", []) if c["id"] in kept_ids]
# Reflect the runtime model list (the CLI reads --models, this is advisory).
spec["models"] = [m.strip() for m in os.environ.get("MODELS", "").split(",") if m.strip()]
with open(dst, "w") as fh:
    yaml.safe_dump(spec, fh, sort_keys=False)
print(f"dogfood: wrote smoke spec {dst} ({len(spec['test_cases'])} case, "
      f"{len(spec['criteria'])} criteria)", file=sys.stderr)
PY
  ACTIVE_SPEC="$SMOKE_SPEC"
fi

mkdir -p "$OUT_DIR"
RUN_JSON="$OUT_DIR/run.json"
BUNDLE="$OUT_DIR/evidence-bundle.json"

echo "dogfood: running REAL eval — provider=$PROVIDER skill=$SKILL_DIR spec=$ACTIVE_SPEC models=$MODELS" >&2

# --- Run the real eval -------------------------------------------------------
# The provider's key env var is set, so eval.ts selects the matching real
# provider automatically (no J_RIG_ALLOW_STUB needed). --provider pins the exact
# vendor. Capture --json to stdout; J_RIG_OTEL=1 so the run also emits the OTel
# signals.
TMPDB="$(mktemp -u --suffix=.db)"
trap 'rm -f "$TMPDB"' EXIT

set +e
J_RIG_OTEL=1 node "$CLI" eval "$SKILL_DIR" --spec "$ACTIVE_SPEC" \
  --provider "$PROVIDER" --models "$MODELS" --db "$TMPDB" --json \
  >"$RUN_JSON" 2>"$OUT_DIR/eval.stderr.log"
EVAL_EXIT=$?
set -e

if [[ ! -s "$RUN_JSON" ]]; then
  echo "dogfood: eval produced no JSON output (exit $EVAL_EXIT). stderr:" >&2
  tail -20 "$OUT_DIR/eval.stderr.log" >&2 || true
  exit 2
fi

# --- Extract decision + compute hashes; build the Evidence Bundle ------------
# We derive a gate-result envelope from the real run: the first model's rollout
# decision becomes the gate.decision (mapped to the gate-result/v1 enum), the
# skill SHA is the subject input_hash, the spec SHA is the policy_hash.
FIRST_MODEL="$(echo "$MODELS" | cut -d, -f1 | tr -d ' ')"

EMIT_ARGS_JSON="$(RUN_JSON="$RUN_JSON" FIRST_MODEL="$FIRST_MODEL" \
  SKILL_MD="$SKILL_DIR/SKILL.md" SPEC_FILE="$ACTIVE_SPEC" python3 - <<'PY'
import json, os, hashlib, sys

with open(os.environ["RUN_JSON"]) as fh:
    run = json.load(fh)

model = os.environ["FIRST_MODEL"]
block = run.get(model)
if block is None:
    # Single-model runs sometimes key by the alias as given; take the first.
    block = next(iter(run.values()), {})

ground_truth = bool(block.get("ground_truth"))
if not ground_truth:
    sys.stderr.write("dogfood: run was NOT ground truth (stub provider). Refusing to "
                     "emit a dogfood bundle from synthetic output.\n")
    sys.exit(3)

decision = (block.get("report") or {}).get("decision", "warn")
# Map RolloutDecision -> gate-result/v1 verdict enum.
mapping = {"ship": "pass", "block": "fail", "warn": "advisory", "obsolete_review": "advisory"}
gate_decision = mapping.get(decision, "advisory")

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        h.update(fh.read())
    return "sha256:" + h.hexdigest()

input_hash = sha256_file(os.environ["SKILL_MD"])
policy_hash = sha256_file(os.environ["SPEC_FILE"])

reasons = []
for b in (block.get("report") or {}).get("blockers", []) or []:
    reasons.append(str(b))
for w in (block.get("report") or {}).get("warnings", []) or []:
    reasons.append(str(w))
if not reasons:
    reasons = [f"j-rig rollout decision: {decision} (all criteria satisfied)"]

print(json.dumps({
    "gate_decision": gate_decision,
    "decision": decision,
    "input_hash": input_hash,
    "policy_hash": policy_hash,
    "reasons": reasons,
}))
PY
)"

GATE_DECISION="$(echo "$EMIT_ARGS_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['gate_decision'])")"
INPUT_HASH="$(echo "$EMIT_ARGS_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['input_hash'])")"
POLICY_HASH="$(echo "$EMIT_ARGS_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['policy_hash'])")"
DECISION="$(echo "$EMIT_ARGS_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['decision'])")"

echo "dogfood: real eval decision=$DECISION → gate-result/v1 verdict=$GATE_DECISION" >&2

# Build a reason flag array for emit-evidence.
mapfile -t REASONS < <(echo "$EMIT_ARGS_JSON" | python3 -c "import json,sys;[print(r) for r in json.load(sys.stdin)['reasons']]")
REASON_ARGS=()
for r in "${REASONS[@]}"; do
  REASON_ARGS+=("--gate-reason" "$r")
done

# Pin the gate version to the package version (no inline literal).
GATE_VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"

# gate_id is <tool>:<side>:<gate-id> where side is a fixed enum
# (client|server|ci|sandbox|local) per Blueprint B § 7.3. The dogfood runs
# locally, so the side is `local`.
EMIT_FLAGS=(
  --gate-id "j-rig:local:j-rig-eval-dogfood"
  --gate-decision "$GATE_DECISION"
  --gate-name "j-rig-rollout-gate"
  --gate-version "$GATE_VERSION"
  --coverage-evaluated trigger
  --coverage-evaluated functional
  --coverage-evaluated judgment
  --policy-ref "${POLICY_HASH}:${ACTIVE_SPEC}"
  --input-hash "$INPUT_HASH"
  --policy-hash "$POLICY_HASH"
  "${REASON_ARGS[@]}"
  --output "$BUNDLE"
)

if [[ "$SIGN" == "1" ]]; then
  # Keyless signing + artifact binding (the artifact is the evaluated SKILL.md).
  EMIT_FLAGS+=(--sign --keyless --artifact "$SKILL_DIR/SKILL.md")
fi

echo "dogfood: emitting Evidence Bundle → $BUNDLE" >&2
if ! node "$CLI" emit-evidence "${EMIT_FLAGS[@]}"; then
  echo "dogfood: emit-evidence failed" >&2
  exit 3
fi

# --- Round-trip verification -------------------------------------------------
BUNDLE="$BUNDLE" INPUT_HASH="$INPUT_HASH" GATE_DECISION="$GATE_DECISION" python3 - <<'PY'
import json, os, sys

with open(os.environ["BUNDLE"]) as fh:
    stmt = json.load(fh)

errs = []
if stmt.get("_type") != "https://in-toto.io/Statement/v1":
    errs.append(f"_type is {stmt.get('_type')!r}, expected in-toto Statement v1")
if stmt.get("predicateType") != "https://evals.intentsolutions.io/gate-result/v1":
    errs.append(f"predicateType is {stmt.get('predicateType')!r}, expected gate-result/v1")

subj = (stmt.get("subject") or [{}])[0]
input_hash = os.environ["INPUT_HASH"]
want_digest = input_hash.split(":", 1)[1]
if subj.get("digest", {}).get("sha256") != want_digest:
    errs.append(f"subject digest {subj.get('digest', {}).get('sha256')!r} != skill input_hash {want_digest!r}")

pred = stmt.get("predicate") or {}
if pred.get("gate_decision") != os.environ["GATE_DECISION"]:
    errs.append(f"predicate.gate_decision {pred.get('gate_decision')!r} != {os.environ['GATE_DECISION']!r}")

if errs:
    print("dogfood: ROUND-TRIP FAILED", file=sys.stderr)
    for e in errs:
        print(f"  - {e}", file=sys.stderr)
    sys.exit(3)

print("dogfood: ROUND-TRIP OK — Evidence Bundle is a valid gate-result/v1 in-toto Statement")
print(f"  predicateType: {stmt['predicateType']}")
print(f"  subject:       {subj.get('name')} (sha256:{subj.get('digest',{}).get('sha256','')[:16]}...)")
print(f"  gate_decision: {pred.get('gate_decision')}")
print(f"  runner:        {pred.get('runner')}")
PY

echo "dogfood: DONE — real eval ground truth → signed-capable Evidence Bundle → verified round-trip" >&2
echo "dogfood: artifacts in $OUT_DIR/ (run.json, evidence-bundle.json, eval.stderr.log)" >&2
