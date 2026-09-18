# Generic non-skill runner example

This directory is a complete, non-skill evaluation input for the generic
`j-rig run` substrate. The task is data, each YAML configuration selects a
model-shaped run plus harness parameters, and `harness.mjs` receives the
request as JSON on stdin.

From this directory, build the workspace once and run both configurations:

```bash
pnpm --dir ../.. run build
node ../../packages/cli/dist/index.js run \
  --task ./task.yaml \
  --config ./config-fast.yaml \
  --db ./runs.db \
  --sample-index 0 \
  --json
node ../../packages/cli/dist/index.js run \
  --task ./task.yaml \
  --config ./config-explanatory.yaml \
  --db ./runs.db \
  --sample-index 0 \
  --json
```

The two configuration files produce separate raw-run identities because their
model/config lineage differs. Re-running either command returns the sealed
row with `reused: true`; a non-zero harness exit or timeout is retained as a
runner outcome rather than being interpreted as a model-quality grade.

The generated `runs.db` is local evidence and is intentionally ignored by
Git. Delete it when the example run is no longer needed.
