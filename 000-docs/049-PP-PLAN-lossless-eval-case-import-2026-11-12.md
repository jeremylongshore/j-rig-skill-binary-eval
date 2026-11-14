# Authored eval-case import and bound grading

Status: Implemented locally; real producer interoperability, full workspace check
and native coverage passed. Ordinary PR delivery remains pending.
Bead: `bd_000-projects-dn6j.8`. Kernel promotion remains the separate
`bd_000-projects-6fwn` decision.

## Contract and scope

The importer supports the Whiteglove authored-script dialect through J-Rig's
existing executable Run and deterministic Grade interfaces. It does not translate
shell assertions into model prompts or promote a new kernel schema. Core document
012 and J-Rig document 030 retain the kernel/profile ownership distinction.

`import-evals` reads an explicitly selected repository and Python invocation path,
then writes a new private directory containing `task.json`, `config.json` and
`import.json`. Import never executes the authored commands. Running the generated
configuration is a separate, explicit authorization to execute that trusted Python
runner. It preserves virtualenv interpreter invocation paths rather than replacing
them with their symlink targets.

The package retains exact source bytes as canonical base64, the parsed source,
source/runner SHA-256 digests and ordered fixture identities. All 14 cases and 29
ordered assertions remain in one request so the authored runner preserves shared
output state and assertion order. Descriptive prompts, scenarios, expectations
and expected-output prose remain exact source data; they are **not graded** as a
model oracle. Fixture files are verified inputs to the authored runner, not an
inert context hint or a claim that model adapters hydrate arbitrary files.

Source admission rejects duplicate JSON keys, duplicate case IDs, unknown fields,
empty required descriptive strings, unsupported skill names and unsafe paths.
The accepted profile requires ordinary expected process exits 0–255; signal
expectations are unsupported. Signalled children are infrastructure failures,
not fabricated completed assertions. Whitespace or shell glob characters in the
repository or interpreter invocation path are rejected because the authored
runner's shell expansion cannot preserve those paths safely.

The importer bounds source, runner and fixture reads before allocation, uses a
single regular-file descriptor for each read and creates output without replacing
an existing directory. Failure removes only files it created. This does not claim
isolation from hostile writers controlling filesystem ancestors. Serialized request
and result limits are 4 MiB. Request admission measures UTF-8 JSON bytes, including
escaping and fixture identities, before starting the process.

Task identity binds imported data. Configuration identity additionally binds the
complete normalized execution settings, including interpreter path, runner path,
cwd and timeout. Same inputs/settings are deterministic; different execution
settings cannot silently reuse a Run identity.

## Execution and grading

The existing executable adapter launches fixed Python argv with `shell: false`;
the authored Python runner retains responsibility for its existing shell commands.
The POSIX runner requires its own process group and keeps descendants in that
group. Timeouts, overflow and cancellation cannot produce a complete passing
receipt. The only accepted completed outer exits are 0 and 1; infrastructure
refusal is an error or signal, not an assertion result.

The `whiteglove-scripted-results/v1` receipt contains exact persisted request
identity, source/runner/fixture bindings and ordered case/assertion observations.
Grading loads the persisted Run request and compares all bindings, array lengths,
order, command strings, expected exits and optional stdout predicates. Missing,
extra, duplicate or reordered observations fail. Each observed exit and stdout
predicate is checked independently with existing deterministic graders; a reported
`passed: true` cannot override contradictory observations. The outer process must
also exit 0 for a passing Grade. Grader identity includes the bound request, and
repeat grading retains the existing idempotence contract.

The legacy `--grader` command remains supported, including rejecting an invalid
grader before opening its database. `--grader` and `--scripted-import` are mutually
exclusive. Existing generic CLI exit semantics are unchanged: a successfully
created failing Grade can still return command exit 0. CI must inspect its verdict.

## Reproduction and enforceable CI gate

Use a reviewed authored runner, a compatible Python environment and a fresh output
directory. The built CLI example below performs no model/provider calls:

```sh
node packages/cli/dist/index.js import-evals \
  --root "$WHITEGLOVE_ROOT" --python "$PYTHON" \
  --output "$IMPORT_DIR" --timeout-ms 1800000
node packages/cli/dist/index.js run \
  --task "$IMPORT_DIR/task.json" --config "$IMPORT_DIR/config.json" \
  --db "$RUN_DB" --sample-index 0 --json > run.json
# Set RUN_ID to run.json's run.id, then grade that persisted Run.
node packages/cli/dist/index.js grade \
  --run-id "$RUN_ID" --scripted-import "$IMPORT_DIR/import.json" \
  --db "$RUN_DB" --json > grade.json
node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(value.grade?.verdict!=="pass")process.exit(1);' grade.json
```

Use normal shell failure propagation for the commands as well as the final verdict
assertion. Missing/invalid JSON fails parsing; an absent or non-passing verdict
exits nonzero. The exact assertion was exercised against retained outputs: the
real passing Grade exited 0, stale-replay Grade exited 1 and tampered-observation
Grade exited 1. This proves failure blocks this gate without changing legacy CLI
semantics or rerunning the authored workload.

## Measured qualification

The initial J-Rig baseline was `95ef682d34c4278ef5c9321a661ee9d85664bc04`.
The candidate then fast-forwarded without conflict to
`5cb7b98bb881a1680cd4073860de583ea212b463`, incorporating PR449 profile-ID
uniqueness before final interoperability. The Whiteglove producer worktree is
based on `5dea575d51ac18ae855050cbdbddaa3ebce1a919` with qualified staged tree
`5909bb769742d4a765ab3157f26b78c14604902a`. Producer commit
`4ac88e85adfe0200601cd95c8dda11d13a5adebc` retains the measured source and adds
qualification documentation; its authored runner digest is unchanged.

- Source SHA-256: `c4eacbf88966eeedf6b7943918d298dc4b8ec8aee45c6368da6619f8f09c8e49`.
- Producer SHA-256: `7a61638da5e084661db7c36bdc94257a1d47131f1d69a3297bc3a578c56432f2`.
- Fresh core and CLI builds, targeted lint and 42 focused tests in four files passed.
- Actual CLI import → Run → Grade completed all 14 cases and 29 assertions, with
  observed child exits 0, 1 and 2 and all 48 required grading checks passing.
- A repeat Grade reused its existing identity. Separate negative databases rejected
  stale receipt replay and a contradictory observed exit despite a reported pass.
- Changing source bytes after import produced `runner_error`, outer exit 2 and no
  complete receipt. The original successful database remained unchanged.
- Final qualification assertions verified source/runner hashes, exact raw imported
  bytes, ordered fixture bytes, import files and frozen J-Rig source hashes.

The complete local interoperability chain took 98.405 seconds; the actual Run
stage took 51.323 seconds. These are correctness observations, not evidence of a
causal speed improvement. The producer's independent legacy comparator passed
all 14 cases/29 assertions within its 720-test suite (three existing opt-in skips).
Legacy execution used coverage instrumentation; structured execution did not.
Both used the same authored source, pinned tools and fresh output state, while the
generic adapter deliberately inherits only PATH/LANG/LC_ALL rather than the full
legacy environment. No paid provider calls were made.

Earlier failures are retained: an initial 33/34 focused run exposed legacy grader
validation ordering; the corrected 38-test run then stopped only on two lint
spellings. Neither failure was hidden or addressed by weakening assertions.
The 42-test real-interoperability preflight supersedes those narrow proofs.

Private raw evidence, databases, logs, wrappers and the verdict-gate receipt are
retained in the repository's common Git directory under
`task-receipts/dn6j8-scripted-import`. Raw authored stdout and local filesystem
paths are not published as repository documentation. Final `pnpm run check` and canonical `pnpm run test:coverage` both passed on
unchanged frozen source: 174 files, 2,663 passing tests and one existing skip in
each run. Native coverage was 93.15% statements/lines, 88.41% branches and 95.6%
functions, above the unchanged 73/73/84/80 floors respectively. The check took
498.442 seconds and coverage took 442.908 seconds under a 4 CPU / 4 GiB cap and
one worker. This results-only documentation update follows that frozen proof;
it does not claim a second exact-head full run.

## Adoption and rollback

The authored producer change and J-Rig importer must both be adopted to use this
lane. Existing SkillEvalSpec execution, legacy authored eval invocation and the
kernel contract remain unchanged. No release, provider activation or kernel
promotion is included in this local qualification.

Rollback is to stop invoking the new import/run lane and revert its ordinary
commits; existing persisted Runs/Grades remain evidence and must not be rewritten.
Keep imported packages and their databases together for replay. A source, runner,
fixture or execution-setting change requires a new import/configuration rather
than editing a previously graded artifact. The independent kernel/profile
consolidation decision remains open even when this authored lane is delivered.
