#!/usr/bin/env python3
"""Unprivileged tests of root_scan_supervisor.py (cold-scan v3 = v2 tests with the 1615 fixture fix; prepared by Claude; NOT run by
Claude). v2 (1607) failed 7 pass / 1 error in root's run: gone() caught only FileNotFoundError, but reading an already-open
/proc/<pid>/stat after the process vanished raises ProcessLookupError (ESRCH); files are now closed by context managers. Standard library only.
Fixtures only: a fake /proc/meminfo file, a heartbeat file, /bin/sh children (sleep), all inside a fresh temporary directory. No root,
no network, no real scan. Asserts EXACT termination: the supervised child and its own process group die; an unrelated process lives."""
import os, signal, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
import root_scan_supervisor as S  # noqa: E402

GIB_KB = 1024 * 1024


def gone(pid, within=5.0):
    """the pid no longer runs (absent, or a zombie awaiting its reaper)"""
    end = time.monotonic() + within
    while time.monotonic() < end:
        try:
            with open(f"/proc/{pid}/stat") as f:
                state = f.read().rsplit(")", 1)[1].split()[0]
        except (FileNotFoundError, ProcessLookupError):        # absent at open (ENOENT) or vanished while open (ESRCH)
            return True
        if state == "Z":
            return True
        time.sleep(0.05)
    return False


def read_pid(path, within=5.0):
    end = time.monotonic() + within
    while time.monotonic() < end:
        try:
            with open(path) as f:
                return int(f.read().strip())
        except (FileNotFoundError, ValueError):
            time.sleep(0.02)
    raise AssertionError(f"no pid in {path}")


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="supervisor-")
        self.mem = os.path.join(self.d, "meminfo"); self.set_mem(20 * 1024)
        self.hb = os.path.join(self.d, "heartbeat"); open(self.hb, "w").close()                # closed at once
        self.beat = True
        self._t = threading.Thread(target=self._beat, daemon=True); self._t.start()
        self.addCleanup(setattr, self, "beat", False)
        self.unrelated = subprocess.Popen(["sleep", "60"])            # same uid, NOT in the supervised group
        self.addCleanup(self.unrelated.wait); self.addCleanup(self.unrelated.kill)

    def _beat(self):
        while True:
            if self.beat:
                try: os.utime(self.hb)
                except FileNotFoundError: pass
            time.sleep(0.2)

    def set_mem(self, mib):
        tmp = self.mem + ".tmp"
        with open(tmp, "w") as f:
            f.write(f"MemTotal:       {64 * GIB_KB} kB\nMemFree:        1 kB\nMemAvailable:   {mib * 1024} kB\n")
        os.replace(tmp, self.mem)

    def child(self, body):
        """a /bin/sh child that records its pid and starts a grandchild in its own group"""
        return ["/bin/sh", "-c", f'echo $$ > {self.d}/cpid; sleep 60 & echo $! > {self.d}/gpid; {body}']

    def run_sup(self, argv, **kw):
        return S.supervise(argv, heartbeat=self.hb, meminfo=self.mem, poll=0.05, grace=1, log=lambda m: None, **kw)

    def assert_group_gone(self):
        self.assertTrue(gone(read_pid(f"{self.d}/cpid")), "the supervised child still runs")
        self.assertTrue(gone(read_pid(f"{self.d}/gpid")), "a member of its process group still runs")
        self.assertIsNone(self.unrelated.poll(), "an unrelated process was signalled")


class Supervisor(Base):
    def test_normal_exit_returns_the_child_rc_and_leaves_no_member_of_its_group(self):
        rc = self.run_sup(self.child("echo out > " + self.d + "/out; exit 3"))
        self.assertEqual(rc, 3)
        with open(f"{self.d}/out") as f:
            self.assertEqual(f.read(), "out\n")
        self.assert_group_gone()

    def test_memory_floor_stops_the_scan_group_exactly(self):
        threading.Timer(0.5, self.set_mem, [16383]).start()             # one MiB under the 16 GiB floor
        t0 = time.monotonic(); rc = self.run_sup(self.child("wait"))
        self.assertEqual(rc, S.STOP["floor"]); self.assertLess(time.monotonic() - t0, 5)
        self.assert_group_gone()

    def test_unreadable_meminfo_fails_closed_and_start_bound_refuses_to_start(self):
        threading.Timer(0.5, os.unlink, [self.mem]).start()
        self.assertEqual(self.run_sup(self.child("wait")), S.STOP["floor"]); self.assert_group_gone()
        self.set_mem(16384 + 1023)                                        # under the 17408 MiB start bound: nothing starts
        self.assertEqual(self.run_sup(["/bin/sh", "-c", f"touch {self.d}/ran"]), S.STOP["floor"])
        self.assertFalse(os.path.exists(f"{self.d}/ran"))

    def test_bounded_timeout(self):
        t0 = time.monotonic(); rc = self.run_sup(self.child("wait"), timeout_sec=1)
        self.assertEqual(rc, S.STOP["timeout"]); self.assertLess(time.monotonic() - t0, 5)
        self.assert_group_gone()

    def test_lost_owner_heartbeat_stops_the_scan(self):
        def stale():
            self.beat = False; old = time.time() - 60; os.utime(self.hb, (old, old))
        threading.Timer(0.5, stale).start()
        self.assertEqual(self.run_sup(self.child("wait"), heartbeat_max_age=2), S.STOP["heartbeat"])
        self.assert_group_gone()

    def test_missing_or_symlinked_heartbeat_never_starts_and_is_never_followed(self):
        self.beat = False; os.unlink(self.hb)
        self.assertEqual(self.run_sup(["/bin/sh", "-c", f"touch {self.d}/ran"]), S.STOP["heartbeat"])
        fifo = os.path.join(self.d, "fifo"); os.mkfifo(fifo); os.symlink(fifo, self.hb)   # lstat only: a FIFO target cannot block
        self.assertEqual(self.run_sup(["/bin/sh", "-c", f"touch {self.d}/ran"]), S.STOP["heartbeat"])
        self.assertFalse(os.path.exists(f"{self.d}/ran"))

    def test_signal_to_the_supervisor_and_its_sudden_death_both_end_the_child(self):
        code = ("import sys; sys.path.insert(0, sys.argv[1]); import root_scan_supervisor as m; "
                "sys.exit(m.supervise(['/bin/sh', '-c', 'echo $$ > ' + sys.argv[2] + '/cpid; exec sleep 60'], heartbeat=sys.argv[3], "
                "meminfo=sys.argv[4], poll=0.05, grace=1))")
        for sig, want in ((signal.SIGTERM, S.STOP["signal"]), (signal.SIGKILL, -signal.SIGKILL)):
            try: os.unlink(f"{self.d}/cpid")
            except FileNotFoundError: pass
            p = subprocess.Popen([sys.executable, "-I", "-B", "-c", code, HERE, self.d, self.hb, self.mem], stderr=subprocess.DEVNULL)
            pid = read_pid(f"{self.d}/cpid"); p.send_signal(sig)
            self.assertEqual(p.wait(timeout=10), want)
            self.assertTrue(gone(pid), f"the child survived its supervisor's {signal.Signals(sig).name} (PR_SET_PDEATHSIG)")
        self.assertIsNone(self.unrelated.poll())

    def test_root_entry_accepts_only_the_staged_shape_and_starts_nothing_otherwise(self):
        for argv in ([], ["/tmp/x", "/c", self.hb], ["/run/nvme-cold-wc10.AAAAAAAA", "rel/config", self.hb],
                     ["/run/nvme-cold-wc10.AAAAAAAA/../x", "/c", self.hb], ["/run/nvme-cold-wc10.AAAA", "/c", self.hb]):
            self.assertEqual(S.main(argv), 2, argv)
        self.assertEqual((S.FLOOR_MIB, S.START_MIB, S.TIMEOUT_SEC, S.HEARTBEAT_MAX_AGE_SEC), (16384, 17408, 3600, 15))


if __name__ == "__main__":
    unittest.main()
