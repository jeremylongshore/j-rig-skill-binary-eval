#!/usr/bin/env python3
"""Run the actual offline hook-adapter suite and publish counts, never a claimed pass."""
import json
import sys
import unittest

sys.dont_write_bytecode = True
suite = unittest.defaultTestLoader.discover("tests/skill-gates", pattern="test_*.py")
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(suite)
failed = len(result.failures) + len(result.errors)
print(json.dumps({"tests_passed": result.testsRun - failed - len(result.skipped), "tests_failed": failed}))
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)
