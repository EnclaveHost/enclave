#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r5 admission-guard tests (prepared by Claude 1792; NOT run by Claude). 4 tests, no FUSE, no mount:
the argv classifier; a REAL live dummy session script refuses (PID / start time / argv logged); a process that only MENTIONS the
names is admitted and only its argv[0] basename is logged; the guard never counts itself or its own ancestors. Every dummy process
is our own child, ended and reaped. Environment: COMPOSITE_TEST_TMP."""
import json, os, subprocess, sys, tempfile, time, unittest

TMP = os.environ.get("COMPOSITE_TEST_TMP", "")
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("COMPOSITE_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP
STAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD = os.path.join(STAGE, "jobs", "session_guard.py")
sys.path.insert(0, os.path.join(STAGE, "jobs"))
import session_guard as G  # noqa: E402

SLEEPER = "import time\ntime.sleep(120)\n"


def guard():
    return subprocess.run([sys.executable, "-I", "-B", GUARD], capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin"})


class Guard(unittest.TestCase):
    def setUp(self):
        self.d, self.kids = tempfile.mkdtemp(prefix="g", dir=TMP), []

    def tearDown(self):
        for c in self.kids:
            if c.poll() is None:
                c.kill()
            c.wait(timeout=30)
            for f in (c.stdout, c.stderr):
                if f:
                    f.close()

    def spawn(self, argv, **kw):
        c = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
        self.kids.append(c); time.sleep(0.5)
        self.assertIsNone(c.poll(), argv)
        return c

    def script(self, name, body=SLEEPER):
        p = os.path.join(self.d, name)
        with open(p, "w") as f:
            f.write(body)
        return p

    def test_1_only_a_real_python_script_invocation_is_a_session(self):
        yes = [["/usr/bin/python3", "-I", "-B", "/w/recovery-multipart-stage/r3/orchestrate.py", "run", "--mode", "copy"],
               ["python3.14", "-u", "/w/r9/run/overlay_session.py", "--plan-dir", "x"],
               ["/usr/bin/python3", "-I", "-B", "-u", "-W", "always::ResourceWarning", "/w/composite_session.py", "--view-dir", "v"],
               ["python3", "-IB", "composite_session.py"], ["python3", "-Wdefault", "./orchestrate.py"], ["python3", "--", "orchestrate.py"]]
        no = [["bash", "-c", "pgrep -af orchestrate.py"], ["python3", "-c", "print('orchestrate.py')"], ["python3", "-Ic", "x", "orchestrate.py"],
              ["python3", "-m", "pytest", "overlay_session.py"], ["grep", "-n", "orchestrate.py", "f"], ["sed", "-n", "1p", "/w/composite_session.py"],
              ["/usr/bin/python3", "-I", "-B", "/w/jobs/root-multipart-batches-1773.py", "batch", "--mode", "copy"],
              ["python3", "/w/orchestrate.py.bak"], ["python3", "-"], ["python3", "-I"], [], ["/usr/bin/orchestrate.py"]]
        for a in yes:
            self.assertTrue(G.is_session(a), a)
        for a in no:
            self.assertFalse(G.is_session(a), a)

    def test_2_a_live_session_script_refuses_and_is_logged_with_pid_start_and_argv(self):
        c = self.spawn(["/usr/bin/python3", "-I", "-B", self.script("orchestrate.py"), "run", "--mode", "copy"])
        r = guard()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        live = [json.loads(l.split(": ", 1)[1]) for l in r.stdout.splitlines() if l.startswith("## guard LIVE session process: ")]
        me = [x for x in live if x["pid"] == c.pid]
        self.assertEqual(len(me), 1, r.stdout)
        self.assertEqual(me[0]["argv"][3:5], [os.path.join(self.d, "orchestrate.py"), "run"]); self.assertIsInstance(me[0]["startTime"], int)
        c.kill(); c.wait(timeout=30)
        self.assertEqual(guard().returncode, 0)                              # gone: admitted again

    def test_3_a_text_mention_is_admitted_and_only_its_argv0_basename_is_logged(self):
        c = self.spawn(["/usr/bin/bash", "-c", "/usr/bin/sleep 120; :", "SECRETLIKE-orchestrate.py", "overlay_session.py"])
        r = guard()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        info = [json.loads(l.split(": ", 1)[1]) for l in r.stdout.splitlines() if l.startswith("## guard INFO (text mention only, not refusing): ")]
        self.assertIn(c.pid, [x["pid"] for x in info])
        self.assertEqual([x["argv0"] for x in info if x["pid"] == c.pid], ["bash"])
        self.assertNotIn("SECRETLIKE", r.stdout)                            # arguments of unrelated processes are never logged

    def test_4_the_guard_never_counts_itself_or_its_own_ancestors(self):
        parent = self.script("composite_session.py", "import subprocess, sys\n"
                             f"sys.exit(subprocess.run([sys.executable, '-I', '-B', {GUARD!r}], stdout=subprocess.DEVNULL).returncode)\n")
        r = subprocess.run(["/usr/bin/python3", "-I", "-B", parent], capture_output=True, timeout=60, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 0)                                    # its session-looking parent is its own ancestor
        self.assertEqual(G.ancestors(os.getpid()) >= {os.getpid(), os.getppid()}, True)


if __name__ == "__main__":
    unittest.main()
