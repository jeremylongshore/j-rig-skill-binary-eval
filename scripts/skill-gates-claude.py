#!/usr/bin/env python3
"""Opt-in Claude Code skill-gates pilot. No global configuration or package runtime changes."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

MAX_OUTPUT = 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def provider():
    path = Path(os.environ["IEP_SKILL_GATE_PROVIDER"]).resolve()
    expected = os.environ["IEP_SKILL_GATE_PROVIDER_SHA256"]
    if len(expected) != 64 or sha(path.read_bytes()) != expected:
        raise ValueError("pinned verifier unavailable or changed")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("skill_gate_provider", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def atomic(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, sort_keys=True, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def storage(root, policy_path, session):
    base = Path(os.environ.get("IEP_SKILL_GATE_STATE", Path.home() / ".local/state/iep-skill-gates"))
    if base.is_symlink():
        raise ValueError("state directory is linked")
    base.mkdir(parents=True, mode=0o700, exist_ok=True)
    if base.stat().st_uid != os.getuid() or base.stat().st_mode & 0o077:
        raise ValueError("state directory must be private and owned by this user")
    scope = sha((str(root) + "\0" + str(policy_path) + "\0" + session).encode())
    directory = base / scope
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise ValueError("invalid session directory")
    fd = os.open(directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield directory


def fresh(gate, current, session):
    return {"schema": gate.RECEIPT, "session": session, "identity": current,
            "reads": {}, "commands": {}, "report": None}


def log(directory, event, mode, errors, blocked):
    path = directory / "gate.log"
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as handle:
        # Keep bounded local telemetry; rotation is explicit and does not change the receipt.
        if handle.tell() > MAX_OUTPUT:
            raise ValueError("gate log full; archive it before continuing")
        handle.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "event": event,
                                 "mode": mode, "findings": errors, "blocked": blocked}) + "\n")


def completed(command, executable, root):
    """Bound disk output and kill the entire POSIX process group on timeout/overflow."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen([executable] + command["argv"][1:], cwd=root,
                                   stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
        deadline = time.monotonic() + command["timeout_ms"] / 1000
        status = "completed"
        try:
            while True:
                code = process.poll()
                if os.fstat(out.fileno()).st_size > MAX_OUTPUT or os.fstat(err.fileno()).st_size > MAX_OUTPUT:
                    status = "output_limit"
                elif time.monotonic() >= deadline:
                    status = "timed_out"
                if status != "completed" or code is not None:
                    break
                time.sleep(0.01)
        finally:
            # Also remove inherited-output descendants after the leader exits/interruption.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        out.seek(0)
        raw = out.read(MAX_OUTPUT + 1)
    tests = {}
    try:
        tests = json.loads(raw)
        if not isinstance(tests, dict):
            tests = {}
    except (ValueError, UnicodeError):
        pass
    return {"status": status, "exit_code": process.returncode,
            "tests_passed": tests.get("tests_passed"), "tests_failed": tests.get("tests_failed"),
            "stdout_sha256": sha(raw)}


def context(message):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": message}}))


def operate(args, event):
    gate = provider()
    root = Path(args.root).resolve()
    policy_path = Path(args.policy).resolve()
    policy, policy_hash = gate.policy_at(policy_path)
    # Policy outside the workspace would create an easy accidental cross-project invocation.
    if root not in policy_path.parents:
        raise ValueError("policy must be inside workspace")
    session = sha(args.session.encode())
    action = event.get("hook_event_name") if event else args.action
    with storage(root, policy_path, session) as directory:
        state_path = directory / "state.json"
        state = gate.load(state_path)[0] if state_path.exists() else {"active": False, "receipt": None}
        activate = action == "begin" or (action == "UserPromptSubmit"
                    and event.get("prompt", "").split(maxsplit=1)[:1] == ["/" + policy["skill"]])
        if activate:
            current = gate.identity(root, policy, policy_hash, __file__)
            state = {"active": True, "receipt": fresh(gate, current, session)}
            atomic(state_path, state)
            log(directory, "begin", policy["mode"], [], False)
            message = ("Skill gate active in " + policy["mode"] + ". Session: " + args.session
                       + ". Use the pilot collector read/run/report commands; evidence is local and unsigned.")
            context(message) if event else print(message)
            return 0
        if not state["active"]:
            if event:
                return 0
            raise ValueError("no active pilot; begin this session first")
        if action == "PreToolUse":
            blocked = event.get("tool_name") in policy["deny_tools"]
            log(directory, action, policy["mode"], ["tool:denied"] if blocked else [], blocked)
            if blocked:
                print("Pilot policy denies this tool", file=sys.stderr)
            return 2 if blocked else 0
        if action not in ("read", "run", "report", "Stop", "PostToolUse", "UserPromptSubmit"):
            raise ValueError("unsupported hook event")
        current = gate.identity(root, policy, policy_hash, __file__)
        receipt = state["receipt"]
        if action in ("read", "run", "report") and receipt["identity"] != current:
            receipt = fresh(gate, current, session)
            state["receipt"] = receipt
        binding = sha(gate.canonical(current))
        if action == "read":
            if args.item not in policy["must_read"]:
                raise ValueError("undeclared read")
            raw = gate.file_path(root, args.item).read_bytes()
            sys.stdout.buffer.write(raw)
            sys.stdout.buffer.flush()
            receipt["reads"][args.item] = sha(raw)
            receipt["report"] = None
        elif action == "run":
            command = next((c for c in policy["must_run"] if c["id"] == args.item), None)
            if command is None:
                raise ValueError("undeclared command")
            if any(receipt["reads"].get(p) != current["inputs"][p] for p in policy["must_read"]):
                raise ValueError("read current required files before running checks")
            receipt["report"] = None
            # Clear prior success durably BEFORE launch: interruption cannot preserve an old pass.
            receipt["commands"][args.item] = {"status": "running"}
            atomic(state_path, state)
            result = completed(command, current["tools"][args.item]["path"], root)
            if gate.identity(root, policy, policy_hash, __file__) != current:
                result["status"] = "inputs_changed"
            result["identity_sha256"] = binding
            receipt["commands"][args.item] = result
            print(json.dumps(result, sort_keys=True))
        elif action == "report":
            receipt["report"] = {"checklist": policy["checklist"], "identity_sha256": binding}
        errors = gate.assess(policy, receipt, current, session)
        if action in ("read", "run", "report"):
            atomic(state_path, state)
        blocked = bool(errors) and action == "Stop" and policy["mode"] == "enforce"
        log(directory, action, policy["mode"], errors, blocked)
        if action == "Stop" and not errors:
            state["active"] = False
            atomic(state_path, state)
        if action == "report":
            print(json.dumps(gate.row(policy_hash, receipt, errors, policy["mode"] == "enforce"), sort_keys=True))
        if action == "Stop" and errors:
            print("Skill gate evidence incomplete: " + ", ".join(errors), file=sys.stderr)
        if action == "run":
            return int("run:" + args.item in errors)
        return 2 if blocked else (int(bool(errors)) if action == "report" else 0)


def main():
    def interrupted(_signal, _frame):
        raise InterruptedError("collector interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("begin", "read", "run", "report", "hook"))
    parser.add_argument("item", nargs="?")
    parser.add_argument("--policy", required=True)
    parser.add_argument("--root", default=os.getcwd())
    parser.add_argument("--session")
    args = parser.parse_args()
    event = None
    try:
        if args.action == "hook":
            raw = sys.stdin.buffer.read(MAX_OUTPUT + 1)
            if len(raw) > MAX_OUTPUT:
                raise ValueError("hook input exceeds limit")
            event = json.loads(raw)
            if not isinstance(event, dict):
                raise ValueError("invalid hook input")
            args.session = event.get("session_id")
            if Path(event.get("cwd", "")).resolve() != Path(args.root).resolve():
                raise ValueError("hook workspace mismatch")
        if not isinstance(args.session, str) or not 1 <= len(args.session) <= 256:
            raise ValueError("session ID required")
        return operate(args, event)
    except (ValueError, OSError, KeyError, TypeError, AttributeError, RecursionError):
        # Runtime failures cannot masquerade as positive evidence. Host failure semantics still apply.
        print("Skill gate unavailable: check policy, pinned provider and private state", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
