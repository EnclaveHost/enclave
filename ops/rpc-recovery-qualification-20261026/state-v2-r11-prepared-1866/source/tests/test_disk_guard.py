#!/usr/bin/env python3
"""base-state-readonly-stage/r5 disk-guard tests (PREPARED by Claude 1728; root runs them). The REAL jobs/disk_guard.py runs as a
subprocess through tests/guard_wrapper.py with a SYNTHETIC mountinfo (the test dir's real maj:min, a fake source) and a synthetic
free-space sequence; commands are harmless dummy writers (<= 4 MiB) and sleepers. Nothing outside the test dir is written, and only
the test's own processes are signalled."""
import glob, json, os, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUARD, WRAP = str(HERE.parent / "jobs" / "disk_guard.py"), str(HERE / "guard_wrapper.py")
PY = sys.executable


def alive(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(") ")[1][0] != "Z"
    except (OSError, IndexError):
        return False


class Guard(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(dir=os.environ.get("TEST_TMP")); self.pids = []
        st = os.stat(self.d)
        self.mm = f"{os.major(st.st_dev)}:{os.minor(st.st_dev)}"
        self.mi = os.path.join(self.d, "mountinfo")
        with open(self.mi, "w") as f:
            f.write(f"36 25 {self.mm} / / rw,relatime shared:1 - ext4 /dev/mapper/testvm rw\n")
        self.base = os.path.join(self.d, "build")

    def tearDown(self):
        for p in self.pids:
            try:
                os.kill(p, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def args(self, *cmd, **kw):
        a = ["--base", kw.get("base", self.base), "--mount-majmin", self.mm, "--mount-source", kw.get("source", "/dev/mapper/testvm"),
             "--mount-fstype", "ext4", "--min-start-gib", "64", "--floor-gib", "40", "--max-scratch-gib", str(kw.get("cap", 20)),
             "--interval", "0.2", "--timeout", str(kw.get("timeout", 60))]
        return a + ["--"] + list(cmd)

    def guard(self, cfg, args, timeout=90):
        r = subprocess.run([PY, "-I", "-B", WRAP, GUARD, json.dumps({"mountinfo": self.mi, **cfg}), *args], capture_output=True, text=True,
                           timeout=timeout, stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout + r.stderr

    def runs(self):
        return glob.glob(os.path.join(self.base, "run-*"))

    def receipt(self):
        with open(os.path.join(self.runs()[0], "guard-receipt.json")) as f:
            return json.load(f)

    def test_refuses_symlink_or_file_base_and_bad_args(self):
        target = os.path.join(self.d, "elsewhere"); os.mkdir(target)
        os.symlink(target, self.base)
        self.assertEqual(self.guard({"free": [100]}, self.args("true"))[0], 3)
        self.assertEqual(os.listdir(target), [])                          # nothing created through the symlink
        os.unlink(self.base)
        with open(self.base, "w"):
            pass
        self.assertEqual(self.guard({"free": [100]}, self.args("true"))[0], 3)
        os.unlink(self.base)
        self.assertEqual(self.guard({"free": [100]}, self.args("true", base="relative/build"))[0], 3)
        a = self.args("true"); a[a.index("--floor-gib") + 1] = "64"
        self.assertEqual(self.guard({"free": [100]}, a)[0], 3)               # floor must be < min start
        self.assertEqual(self.guard({"free": [100]}, self.args())[0], 3)     # no command
        self.assertFalse(os.path.lexists(self.base))

    def test_refuses_wrong_mount_before_creating_anything(self):
        rc, out = self.guard({"free": [100]}, self.args("true", source="/dev/sda2"))
        self.assertEqual(rc, 3, out); self.assertFalse(os.path.lexists(self.base))

    def test_refuses_low_start_free(self):
        rc, out = self.guard({"free": [63.9]}, self.args("true"))
        self.assertEqual(rc, 3, out); self.assertEqual(self.runs(), [])

    def test_runs_in_new_private_run_dir_and_keeps_it(self):
        code = "import os; open('marker','w').write(os.environ['BSRO_RUN_DIR'] + '|' + os.getcwd())"
        rc, out = self.guard({"free": [100]}, self.args(PY, "-c", code))
        self.assertEqual(rc, 0, out)
        (run,) = self.runs()
        self.assertEqual(os.stat(run).st_mode & 0o777, 0o700); self.assertEqual(os.stat(self.base).st_mode & 0o777, 0o700)
        with open(os.path.join(run, "marker")) as f:
            self.assertEqual(f.read(), f"{run}|{run}")
        r = self.receipt(); self.assertIsNone(r["reason"]); self.assertTrue(r["scratchKept"]); self.assertEqual(r["childRc"], 0)

    def test_propagates_child_rc(self):
        self.assertEqual(self.guard({"free": [100]}, self.args(PY, "-c", "raise SystemExit(7)"))[0], 7)

    def test_floor_stops_whole_own_group_only(self):
        sib = subprocess.Popen(["sleep", "300"], start_new_session=True); self.pids.append(sib.pid)    # unrelated: must survive
        code = ("import os, subprocess, time; c = subprocess.Popen(['sleep', '300']); "
                "open('pids', 'w').write(f'{os.getpid()} {c.pid}'); time.sleep(300)")
        rc, out = self.guard({"free": [100] * 11 + [39]}, self.args(PY, "-c", code))
        self.assertEqual(rc, 70, out)
        (run,) = self.runs()
        with open(os.path.join(run, "pids")) as f:
            pids = [int(x) for x in f.read().split()]
        self.pids += pids
        self.assertFalse(any(alive(p) for p in pids), "the guarded group survived")
        self.assertTrue(alive(sib.pid), "an unrelated process was signalled")
        r = self.receipt(); self.assertEqual(r["reason"], "diskFloor"); self.assertFalse(r["groupLeftAlive"])
        sib.kill(); sib.wait()

    def test_scratch_cap_real_tiny_writer(self):
        code = "import time; open('blob', 'wb').write(b'x' * (4 << 20)); time.sleep(300)"
        rc, out = self.guard({"free": [100]}, self.args(PY, "-c", code, cap=0.001))         # 0.001 GiB ~ 1 MiB
        self.assertEqual(rc, 71, out)
        self.assertTrue(os.path.exists(os.path.join(self.runs()[0], "blob")))                 # scratch kept for review
        self.assertGreater(self.receipt()["samples"][-1][2], (1 << 30) * 0.001)

    def test_timeout(self):
        t0 = time.monotonic()
        rc, out = self.guard({"free": [100]}, self.args("sleep", "300", timeout=1))
        self.assertEqual(rc, 72, out); self.assertLess(time.monotonic() - t0, 30)

    def test_sigterm_cancels_and_stops_group(self):
        code = "import os, time; open('pid', 'w').write(str(os.getpid())); time.sleep(300)"
        g = subprocess.Popen([PY, "-I", "-B", WRAP, GUARD, json.dumps({"mountinfo": self.mi, "free": [100]}), *self.args(PY, "-c", code)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 20
        while time.monotonic() < end and not (self.runs() and os.path.exists(os.path.join(self.runs()[0], "pid"))):
            time.sleep(0.1)
        with open(os.path.join(self.runs()[0], "pid")) as f:
            child = int(f.read())
        self.pids.append(child)
        g.send_signal(signal.SIGTERM)
        self.assertEqual(g.wait(timeout=30), 73)
        self.assertFalse(alive(child)); self.assertEqual(self.receipt()["reason"], "cancelled")

    def test_preexisting_base_kept_and_only_a_new_run_dir_created(self):
        os.mkdir(self.base, 0o700)
        with open(os.path.join(self.base, "keep-me"), "w"):
            pass
        self.assertEqual(self.guard({"free": [100]}, self.args("true"))[0], 0)
        self.assertTrue(os.path.exists(os.path.join(self.base, "keep-me")))                    # nothing deleted
        self.assertEqual(len(self.runs()), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
