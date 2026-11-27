---
name: verify-skill-gates
description: Verify the offline skill gate adapter when asked to test skill compliance, replay gate failures, or verify skill gates.
disable-model-invocation: true
---

Verify the local skill-gates pilot. The prompt hook supplies this session's ID.
Use the existing pinned verifier environment. From the J-Rig repository root,
invoke `python3 scripts/skill-gates-claude.py` with these common arguments:
`--policy examples/skill-gates/gates.json --root "$PWD" --session SESSION_ID`.

1. Run `read examples/skill-gates/README.md` and read its complete output.
2. Run `read examples/skill-gates/verify-skill-gates/SKILL.md` and read its output.
3. Run `run adapter-replay`. Check the actual exit status and measured counts.
4. Run `report`. Report its result, checklist and validation limitations to the user.

Every action above takes the common arguments. If source, policy or tool bytes
change, repeat the reads, run and report. A failed command is evidence of failure;
repair it and rerun. Never substitute a statement that tests passed for the run.

The pilot checks byte access and local process evidence. It cannot establish
understanding, independently attest execution, or prove the final prose is true.
