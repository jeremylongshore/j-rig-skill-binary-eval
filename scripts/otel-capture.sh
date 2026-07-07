#!/usr/bin/env bash
# otel-capture.sh — run a j-rig command with OTel event capture.
#
# The OTel emitter's stderr transport prints one "[OTEL] {json}" line per
# event when J_RIG_OTEL=1 — but nothing scrapes it by default, so every
# event (judge samples, agreement fractions, gate decisions) dies with the
# terminal scrollback (observability review, BUILD-NOW #3: "give the signal
# a home before you enrich it"). This wrapper appends the JSON payloads to
# an append-only NDJSON file while leaving stderr fully visible.
#
# Usage:
#   scripts/otel-capture.sh OUT.ndjson node packages/cli/dist/index.js eval ./skill --provider deepseek
#
# Query later with jq, e.g. agreement per criterion:
#   jq -r 'select(.name=="runtime.criterion.evaluated") | .attributes' OUT.ndjson
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 OUT.ndjson CMD [ARGS...]" >&2
  exit 2
fi

out=$1
shift

J_RIG_OTEL=1 "$@" 2> >(while IFS= read -r line; do
  case $line in
    "[OTEL] "*) printf '%s\n' "${line#\[OTEL\] }" >>"$out" ;;
  esac
  printf '%s\n' "$line" >&2
done)
