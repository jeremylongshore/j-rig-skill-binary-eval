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

## Grade the saved output

Set `RUN_ID` to the `run.id` from either JSON response above:

```bash
RUN_ID=raw_replace_with_your_run_id
node ../../packages/cli/dist/index.js grade \
  --run-id "$RUN_ID" --grader ./grader.yaml --db ./runs.db --json
node ../../packages/cli/dist/index.js grade \
  --run-id "$RUN_ID" --grader ./grader-v2.yaml --db ./runs.db --regrade --json
```

The first command checks the fixture's answer. The second adds a metadata
check and stores a new Grade; the original Grade and raw Run stay unchanged.
Repeating either identical command returns `created: false` without another
judge call. Changing the grader without `--regrade` is rejected before grading.

This example uses a deterministic local harness and no API keys or model
tokens. It demonstrates storage, reuse, and grading mechanics, not the quality
of a real model or agent. Replace the harness with your trusted workflow and
write checks for its actual outputs when evaluating a real system. The runner
is a local process boundary, not a sandbox for untrusted code.

The generated `runs.db` is local evidence and is intentionally ignored by
Git. Delete it when the example run is no longer needed.
