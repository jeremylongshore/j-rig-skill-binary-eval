# Skill compliance pilot

This opt-in example connects the deterministic audit-harness verifier to Claude
Code. Nothing installs globally or changes rollout policy. Explicitly invoking the installed skill activates enforcement for that session.
The tool deny list applies while the pilot is active.

## Prepare

Use Linux or macOS, Python 3.9+, Node 20+, and a reviewed checkout of
`jeremylongshore/intent-audit-harness` containing `scripts/skill-gates.py`.
The verifier is not part of the older vendored harness in this repository.
The initial reviewed provider is commit
`25c476e1b5e192442ecd19c6e6df75c3e7de16ab`, with source digest
`239e0b10dc486d35296a7520150cb347d02ee65216ac1d2c09adc7ccf8fa6da4`.
Set an absolute provider path and its independently reviewed SHA256 before
starting Claude Code from this repository root. Keep the verifier inside its
checkout because the report reads the adjacent repository package metadata:

```bash
export IEP_SKILL_GATE_PROVIDER=/absolute/reviewed/audit-harness/scripts/skill-gates.py
export IEP_SKILL_GATE_PROVIDER_SHA256=REVIEWED_SHA256
pnpm run test:skill-gates
```

Merge `hooks.json` into your project `.claude/settings.local.json`, preserving
existing hook arrays. Copy `verify-skill-gates/` into
`.claude/skills/verify-skill-gates/`. Restart Claude and verify the four handlers
with `/hooks`. These are opt-in installation instructions, not an installer.
Keep the installed skill byte-identical to the reviewed example; the gate binds
the example bytes, not arbitrary installed skill files. Review changes together.
The hook command receives `CLAUDE_PROJECT_DIR` from Claude Code.

## Execute

Explicitly invoke `/verify-skill-gates`. The prompt hook creates a new receipt
and supplies the session ID. Automatic skill invocation and skill calls through
the Skill tool do not activate this bounded pilot. Follow the skill's read, run
and report actions with that session ID. For an offline manual session:

```bash
python3 scripts/skill-gates-claude.py begin --policy examples/skill-gates/gates.json --session manual
python3 scripts/skill-gates-claude.py read examples/skill-gates/README.md --policy examples/skill-gates/gates.json --session manual
python3 scripts/skill-gates-claude.py read examples/skill-gates/verify-skill-gates/SKILL.md --policy examples/skill-gates/gates.json --session manual
python3 scripts/skill-gates-claude.py run adapter-replay --policy examples/skill-gates/gates.json --session manual
python3 scripts/skill-gates-claude.py report --policy examples/skill-gates/gates.json --session manual
```

`read` emits all required file bytes and records the digest. It does not prove
understanding. `run` executes the declared argv without a shell, retaining
completion, exit code, actual test counts and a stdout hash. The command must
emit one JSON object with integer `tests_passed` and `tests_failed` fields.
The provided runner counts real unittest results and excludes skips. Timeout,
output overflow, nonzero exit, malformed counts and changed inputs never pass.
`report` emits the existing unsigned `gate-result/v1` row and checklist receipt;
it does not inspect or certify the assistant's final prose.

The collector revokes prior success before each run. Changing a declared input,
policy, executable or implementation invalidates old evidence. On the next read
or run, it resets the receipt; repeat all required actions. Include every
relevant source, lockfile and configuration in `inputs`; undeclared files and
external services are outside the freshness guarantee. Inputs must be regular
workspace files at most 1 MiB. The test process inherits the environment, so
environment-sensitive behavior must be covered by an authored input/config or
treated as unbound. No live model call is required by this example.

## Observe, review, enforce

Private receipts and `gate.log` live under
`~/.local/state/iep-skill-gates/<scope>/`; `IEP_SKILL_GATE_STATE` selects another
private directory. Scope binds workspace, policy path and session. Files are
0600, directories 0700, and writes are locked and atomic. Logs contain events,
finding codes, mode and block decisions; no prompts, file bodies or command
output. Archive a log before it exceeds 1 MiB. Explicitly invoking the skill
again starts fresh. A clean Stop deactivates the gate for later tasks. State is trusted local evidence and can be modified by the
same OS user; this is not an independent execution attestation or sandbox.

Count evaluated `Stop` events as opportunities and those with findings as unmet
opportunities. Count `begin` events separately. Review chronological outcomes
within each scope for retries and recovery. Label false blocks and missed
violations by independent replay; logs cannot infer those labels. Measure hook
latency separately. Repeated stops are correlated observations, not independent
weekly samples; never present a raw skip count without its denominator.

The reviewed policy uses `enforce`. To trial a different task or host, start
with a reviewed `observe` policy and repeat the controls before promotion.
To roll this skill back to observation, change only `mode` in `gates.json` to
`observe` and begin a fresh session. Missing positive evidence
then blocks `Stop` with exit 2. `PostToolUse` observes but never converts a tool's
claimed success into evidence. PreToolUse denies exact listed tool names even
in observe mode. This is a workflow deny list, not a shell or network sandbox:
another tool can have equivalent capabilities. Runtime/configuration failures
return exit 2 visibly in either mode; Claude's event-specific failure/timeout
semantics still apply. Missing hook scripts or disabled hooks cannot protect you.

Repeated `Stop` requests remain blocked while evidence is incomplete, including
`stop_hook_active`; each invocation is bounded and the host controls its retry
limit. Interruptions may skip `Stop`. Remove only these pilot handlers and the
installed pilot skill to roll back; retain private receipts for diagnosis. Do
not remove or replace other project hooks.
