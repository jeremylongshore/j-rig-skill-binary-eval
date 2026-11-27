#!/usr/bin/env python3
"""Offline process-level replay of the Claude adapter; requires a pinned upstream verifier."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "scripts/skill-gates-claude.py"
PROVIDER = Path(os.environ.get("IEP_SKILL_GATE_PROVIDER", ROOT / ".ci-skill-gates-provider/scripts/skill-gates.py"))


class ClaudeGates(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PROVIDER.is_file(), "checkout the reviewed audit-harness provider before running this suite")
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "private-state"
        self.policy_path = self.root / "gates.json"
        self.policy = {"schema": "audit-harness/skill-gates/v1", "mode": "observe", "skill": "verify-pilot",
                       "inputs": ["check.py"], "must_read": ["instructions.md"], "checklist": ["tests", "freshness"],
                       "deny_tools": ["WebFetch"], "must_run": [{"id": "unit", "argv": [sys.executable, "check.py"],
                                                                 "timeout_ms": 2000, "min_tests": 2}]}
        (self.root / "instructions.md").write_text("Read all these bytes.\n")
        self.source = self.root / "check.py"
        self.source.write_text('print(\'{"tests_passed": 2, "tests_failed": 0}\')\n')
        self.write_policy()
        self.env = dict(os.environ, IEP_SKILL_GATE_PROVIDER=str(PROVIDER),
                        IEP_SKILL_GATE_PROVIDER_SHA256=hashlib.sha256(PROVIDER.read_bytes()).hexdigest(),
                        IEP_SKILL_GATE_STATE=str(self.state))

    def write_policy(self):
        self.policy_path.write_text(json.dumps(self.policy))

    def invoke(self, action, item=None, session="one", event=None):
        args = [sys.executable, str(ADAPTER), action]
        if item:
            args.append(item)
        args += ["--policy", str(self.policy_path), "--root", str(self.root), "--session", session]
        return subprocess.run(args, env=self.env, input=json.dumps(event) if event else None,
                              capture_output=True, text=True, timeout=8)

    def hook(self, name, session="one", **extra):
        return self.invoke("hook", event={"hook_event_name": name, "session_id": session,
                                          "cwd": str(self.root), **extra})

    def begin(self, mode="observe"):
        self.policy["mode"] = mode
        self.write_policy()
        out = self.hook("UserPromptSubmit", prompt="/verify-pilot")
        self.assertEqual(out.returncode, 0, out.stderr)

    def satisfy(self):
        self.assertEqual(self.invoke("read", "instructions.md").returncode, 0)
        run = self.invoke("run", "unit")
        self.assertEqual(run.returncode, 0, run.stderr + run.stdout)
        report = self.invoke("report")
        self.assertEqual(report.returncode, 0, report.stderr + report.stdout)
        self.assertEqual(json.loads(report.stdout)["result"], "PASS")

    def test_observe_enforce_denial_and_fresh_happy_path(self):
        self.begin()
        self.assertEqual(self.hook("Stop").returncode, 0)
        self.assertEqual(self.hook("PreToolUse", tool_name="WebFetch").returncode, 2)
        self.assertEqual(self.hook("PreToolUse", tool_name="Bash").returncode, 0)
        self.satisfy()
        self.assertEqual(self.hook("Stop").returncode, 0)
        self.begin("enforce")
        self.assertEqual(self.hook("Stop").returncode, 2)
        self.assertEqual(self.hook("Stop", stop_hook_active=True).returncode, 2)
        self.satisfy()
        self.assertEqual(self.hook("Stop", stop_hook_active=True).returncode, 0)

    def test_unrelated_session_and_prompt_have_no_gate(self):
        self.assertEqual(self.hook("UserPromptSubmit", prompt="ordinary prompt").stdout, "")
        self.assertEqual(self.hook("Stop").returncode, 0)
        self.begin("enforce")
        self.assertEqual(self.hook("Stop", session="two").returncode, 0)
        self.assertEqual(self.invoke("report", session="two").returncode, 2)

    def test_edit_invalidates_read_check_and_report_then_recovery(self):
        self.begin("enforce")
        self.satisfy()
        self.source.write_text(self.source.read_text() + "# changed\n")
        self.assertEqual(self.hook("Stop").returncode, 2)
        self.assertEqual(self.invoke("run", "unit").returncode, 2)
        self.satisfy()
        self.assertEqual(self.hook("Stop").returncode, 0)

    def test_failed_zero_malformed_output_timeout_and_overflow_are_not_passes(self):
        cases = ["raise SystemExit(1)\n", 'print(\'{"tests_passed":0,"tests_failed":0}\')\n',
                 'print("claimed success")\n', "import time; time.sleep(3)\n", 'print("x" * 1100000)\n']
        for code in cases:
            with self.subTest(code=code):
                self.source.write_text(code)
                self.policy["must_run"][0]["timeout_ms"] = 150
                self.begin("enforce")
                self.assertEqual(self.invoke("read", "instructions.md").returncode, 0)
                self.assertEqual(self.invoke("run", "unit").returncode, 1)
                self.assertEqual(self.invoke("report").returncode, 1)
                self.assertEqual(self.hook("Stop").returncode, 2)

    def test_failed_rerun_revokes_previous_success_before_launch(self):
        # Output can vary without a source edit (external state); latest completion must win.
        self.source.write_text('import os\nprint(\'{"tests_passed":2,"tests_failed":0}\')\n'
                               'raise SystemExit(int(os.environ.get("PILOT_FAILURE", "0")))\n')
        self.begin("enforce")
        self.satisfy()
        self.env["PILOT_FAILURE"] = "1"
        self.assertEqual(self.invoke("run", "unit").returncode, 1)
        self.assertEqual(self.hook("Stop").returncode, 2)

    def test_malformed_policy_provider_and_state_fail_visibly(self):
        self.begin("enforce")
        self.env["IEP_SKILL_GATE_PROVIDER_SHA256"] = "0" * 64
        self.assertEqual(self.hook("Stop").returncode, 2)
        self.env["IEP_SKILL_GATE_PROVIDER_SHA256"] = hashlib.sha256(PROVIDER.read_bytes()).hexdigest()
        self.policy_path.write_text("[]")
        self.assertEqual(self.hook("Stop").returncode, 2)
        self.write_policy()
        next(self.state.glob("*/state.json")).write_text("null")
        self.assertEqual(self.hook("Stop").returncode, 2)

    def test_policy_edit_replay_and_private_content_free_logs(self):
        self.begin("enforce")
        self.satisfy()
        self.policy["checklist"].append("another-check")
        self.write_policy()
        self.assertEqual(self.hook("Stop").returncode, 2)
        self.satisfy()
        for path in self.state.rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o077, 0, str(path))
        text = next(self.state.glob("*/gate.log")).read_text()
        self.assertNotIn("Read all these bytes", text)
        self.assertNotIn('"prompt"', text)
        self.assertNotIn('"stdout"', text)

    def test_post_tool_does_not_accept_tool_success_as_command_evidence(self):
        self.begin("enforce")
        self.assertEqual(self.hook("PostToolUse", tool_name="Bash", tool_response={"exit_code": 0}).returncode, 0)
        self.assertEqual(self.hook("Stop").returncode, 2)

    def test_interruption_kills_child_and_retains_incomplete_evidence(self):
        self.source.write_text('import os, time\nopen("child.pid", "w").write(str(os.getpid()))\ntime.sleep(30)\n')
        self.policy["must_run"][0]["timeout_ms"] = 60000
        self.begin("enforce")
        self.assertEqual(self.invoke("read", "instructions.md").returncode, 0)
        process = subprocess.Popen([sys.executable, str(ADAPTER), "run", "unit", "--policy", str(self.policy_path),
                                    "--root", str(self.root), "--session", "one"],
                                   env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / "child.pid").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.root / "child.pid").exists())
            pid = int((self.root / "child.pid").read_text())
            process.terminate()
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, 2)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            self.assertEqual(self.hook("Stop").returncode, 2)
        finally:
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
