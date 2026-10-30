#!/usr/bin/env python3
"""Self-test of taplog.py on synthetic node --test TAP samples (no implementation code runs)."""
import json, os, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
def summary(tests, p, f, c=0, s=0, t=0): return f"# tests {tests}\n# suites 0\n# pass {p}\n# fail {f}\n# cancelled {c}\n# skipped {s}\n# todo {t}\n"
OK = "ok 1 - a\n  ---\n  duration_ms: 1\n  ...\nok 2 - b\n  ---\n  duration_ms: 1\n  ...\n"
ASSERT_FAIL = ("ok 1 - a\n  ---\n  duration_ms: 1\n  ...\nnot ok 2 - b\n  ---\n  duration_ms: 1\n  failureType: 'testCodeFailure'\n"
               "  error: 'The validation function is expected to return \"true\". Received false'\n  code: 'ERR_ASSERTION'\n  ...\n")
LOAD_FAIL = ("# SyntaxError: Unexpected token ')'\nnot ok 1 - test/a1-recheck.test.mjs\n  ---\n  duration_ms: 30\n  failureType: 'testCodeFailure'\n"
             "  exitCode: 1\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n")
TIMEOUT = ("ok 1 - a\n  ---\n  duration_ms: 1\n  ...\nnot ok 2 - b\n  ---\n  duration_ms: 1\n  failureType: 'testTimeoutFailure'\n  code: 'ERR_TEST_FAILURE'\n  ...\n")
NONASSERT = ("ok 1 - a\n  ---\n  duration_ms: 1\n  ...\nnot ok 2 - b\n  ---\n  duration_ms: 1\n  failureType: 'testCodeFailure'\n  error: 'boom'\n  code: 'ERR_OTHER'\n  ...\n")
def run(mode, text, rc, base=None):
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".tap") as f: f.write(text)
    a = [sys.executable, os.path.join(HERE, "taplog.py"), mode, f.name, str(rc)] + ([str(base)] if base is not None else [])
    r = subprocess.run(a, capture_output=True, text=True); os.unlink(f.name)
    return r.returncode, json.loads(r.stdout)
class T(unittest.TestCase):
    def test_baseline_clean(self): self.assertEqual(run("baseline", OK + summary(2, 2, 0), 0), (0, run("baseline", OK + summary(2, 2, 0), 0)[1])); self.assertEqual(run("baseline", OK + summary(2, 2, 0), 0)[1]["verdict"], "baseline-clean")
    def test_baseline_refuses_skip_fail_rc(self):
        for text, rc in ((OK + summary(2, 1, 0, s=1), 0), (ASSERT_FAIL + summary(2, 1, 1), 1), (OK + summary(2, 2, 0), 1), (OK + summary(2, 2, 0, t=1), 0)):
            self.assertEqual(run("baseline", text, rc)[0], 1)
    def test_genuine_assertion_kill(self): self.assertEqual(run("killed", ASSERT_FAIL + summary(2, 1, 1), 1, 2)[1]["verdict"], "killed")
    def test_syntax_load_failure_is_not_a_kill(self):
        rc, v = run("killed", LOAD_FAIL + summary(1, 0, 1), 1, 2); self.assertEqual((rc, v["verdict"]), (1, "invalid-kill")); self.assertIn("SyntaxError", v["badMarkers"])
    def test_timeout_and_rc124_are_not_kills(self):
        self.assertEqual(run("killed", TIMEOUT + summary(2, 1, 1), 1, 2)[1]["verdict"], "invalid-kill")
        self.assertEqual(run("killed", ASSERT_FAIL + summary(2, 1, 1), 124, 2)[1]["verdict"], "invalid-kill")
    def test_non_assertion_failure_and_fewer_tests_are_not_kills(self):
        self.assertEqual(run("killed", NONASSERT + summary(2, 1, 1), 1, 2)[1]["verdict"], "invalid-kill")
        self.assertEqual(run("killed", ASSERT_FAIL + summary(2, 1, 1), 1, 3)[1]["verdict"], "invalid-kill")
    def test_survivor_and_unparsable(self):
        self.assertEqual(run("killed", OK + summary(2, 2, 0), 0, 2)[1]["verdict"], "survived")
        self.assertEqual(run("killed", "garbage", 1, 2)[1]["verdict"], "unparsable")
if __name__ == "__main__": unittest.main()
