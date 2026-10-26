#!/usr/bin/env python3
"""mdbx-recovery-validator-stage/r3 offline tests (PREPARED; NOT run by Claude). Needs jobs/reuse-and-test.sh's own user+mount+net namespace
(unshare -Urnm): every database is exposed through a REAL read-only bind mount (mount --bind + remount,bind,ro), so libmdbx's
EROFS -> without-lck path is the one exercised. Small fixtures only (built with the official libmdbx API); no device, no network.
MDBX_BIN = the job's build dir (mdbx_chk, mk_fixture); MDBX_CHK_SHA256 = the built mdbx_chk's sha256."""
import json, os, shutil, signal, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, f"{STAGE}/src")
sys.dont_write_bytecode = True
import mdbx_check as M  # noqa: E402

BIN = os.environ.get("MDBX_BIN", "")
CHK, MK = f"{BIN}/mdbx_chk", f"{BIN}/mk_fixture"
CHK_SHA = os.environ.get("MDBX_CHK_SHA256", "")
PAGE = 4096


def ro_mount(src, dst):
    os.makedirs(dst, exist_ok=True)
    subprocess.run(["mount", "--bind", src, dst], check=True, capture_output=True)
    subprocess.run(["mount", "-o", "remount,bind,ro", dst], check=True, capture_output=True)
    assert os.statvfs(dst).f_flag & os.ST_RDONLY, dst


def corrupt(path, offset, length):
    with open(path, "r+b") as f:
        f.seek(offset); f.write(b"\xa5" * length)


class Validator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.access(CHK, os.X_OK) and os.access(MK, os.X_OK) and len(CHK_SHA) == 64, "MDBX_BIN/MDBX_CHK_SHA256 from jobs/tests.sh"
        cls.tmp = tempfile.mkdtemp(prefix="mdbxv", dir=os.environ.get("TEST_TMP"))
        cls.mounts = []
        src = f"{cls.tmp}/src/pristine"; os.makedirs(src)
        subprocess.run([MK, src, "20000"], check=True, capture_output=True)
        with open(f"{src}/database.version", "w") as f:
            f.write("2")                                            # reth DB_VERSION file, as in a reth db/ directory
        for name in ("bad-meta", "bad-tree", "truncated"):
            shutil.copytree(src, f"{cls.tmp}/src/{name}")
        dat = lambda n: f"{cls.tmp}/src/{n}/mdbx.dat"
        corrupt(dat("bad-meta"), 0, 3 * PAGE)                       # all three meta pages
        corrupt(dat("bad-tree"), 3 * PAGE, 32 * PAGE)               # the first data (B-tree) pages after the metas
        os.truncate(dat("truncated"), 16 * PAGE)
        cls.size = os.path.getsize(dat("pristine"))
        assert cls.size > 64 * PAGE, cls.size
        for name in ("pristine", "bad-meta", "bad-tree", "truncated"):
            ro_mount(f"{cls.tmp}/src/{name}", f"{cls.tmp}/ro/{name}"); cls.mounts.append(f"{cls.tmp}/ro/{name}")
        cls.ident = {n: M.identity(f"{cls.tmp}/src/{n}") for n in ("pristine", "bad-meta", "bad-tree", "truncated")}

    @classmethod
    def tearDownClass(cls):
        for m in reversed(cls.mounts):
            subprocess.run(["umount", m], capture_output=True)
        shutil.rmtree(cls.tmp, True)

    def tearDown(self):                                             # nothing may ever change the databases (incl. lock files)
        for n, ident in self.ident.items():
            self.assertEqual(M.identity(f"{self.tmp}/src/{n}"), ident, n)

    def chk(self, *args):
        return subprocess.run([CHK, *args], capture_output=True, text=True, timeout=300)

    def wrap(self, db, *extra):
        out = f"{self.tmp}/report-{len(os.listdir(self.tmp))}.json"
        rc = M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", CHK_SHA, "--db-dir", db, "--out", out, *extra])
        if not os.path.exists(out):
            return rc, None
        with open(out) as f:                                        # r3: closed report reads (root 1676 ResourceWarning)
            return rc, json.load(f)

    def test_the_build_is_the_pinned_libmdbx(self):
        r = self.chk("-V")
        self.assertIn(M.LIBMDBX_DESCRIBE, r.stdout + r.stderr)

    def test_the_pristine_fixture_is_clean_readonly_and_unchanged(self):
        rc, rep = self.wrap(f"{self.tmp}/ro/pristine")
        self.assertEqual(rc, 0, rep)
        self.assertEqual((rep["rc"], rep["structurallyClean"], rep["unchangedIdentity"], rep["preflight"]["databaseVersion"]), (0, True, True, "2"))
        self.assertNotIn("-w", rep["argv"]); self.assertEqual(rep["argv"][1:], ["-v", f"{self.tmp}/ro/pristine"])

    def test_each_meta_page_checks_readonly_and_the_newest_is_clean(self):
        import struct
        with open(f"{self.tmp}/src/pristine/mdbx.dat", "rb") as f:
            head = f.read(3 * PAGE)
        txn = [struct.unpack_from("<Q", head, i * PAGE + 20 + 8)[0] for i in range(3)]     # page header 20 B, then magic, txnid
        newest = txn.index(max(txn))
        for meta in (0, 1, 2):
            rc, rep = self.wrap(f"{self.tmp}/ro/pristine", "--meta", str(meta))
            self.assertIn(rep["rc"], (0, 1, 2), (meta, rep["outputTail"][-500:]))           # checked, never an MDBX/system error
            self.assertTrue(rep["unchangedIdentity"])
            if meta == newest:
                self.assertEqual((rc, rep["rc"]), (0, 0), rep["outputTail"][-500:])

    def test_corrupted_meta_pages_are_not_clean(self):
        self.assertNotIn(self.chk(f"{self.tmp}/ro/bad-meta").returncode, (0, 5))
        rc, rep = self.wrap(f"{self.tmp}/ro/bad-meta")
        self.assertEqual(rc, 2); self.assertFalse(rep["structurallyClean"])

    def test_corrupted_btree_pages_are_not_clean(self):
        self.assertNotIn(self.chk(f"{self.tmp}/ro/bad-tree").returncode, (0, 5))
        rc, rep = self.wrap(f"{self.tmp}/ro/bad-tree")
        self.assertEqual(rc, 2); self.assertFalse(rep["structurallyClean"])

    def test_a_truncated_file_is_not_clean(self):
        self.assertNotIn(self.chk(f"{self.tmp}/ro/truncated").returncode, (0, 5))
        rc, rep = self.wrap(f"{self.tmp}/ro/truncated")
        self.assertEqual(rc, 2); self.assertFalse(rep["structurallyClean"])

    def test_a_writable_view_is_refused_before_anything_runs(self):
        rc, rep = self.wrap(f"{self.tmp}/src/pristine")
        self.assertEqual((rc, rep), (1, None))                     # no report: mdbx_chk never ran on the writable view

    def test_even_mdbx_chk_w_cannot_change_the_readonly_view(self):
        r = self.chk("-w", f"{self.tmp}/ro/pristine")              # the wrapper never passes -w; the read-only mount is the guard
        self.assertNotEqual(r.returncode, 0)

    def test_wrong_binary_and_bad_meta_selection_are_refused(self):
        self.assertEqual(M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", "0" * 64, "--db-dir", f"{self.tmp}/ro/pristine"]), 1)
        self.assertEqual(M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", CHK_SHA, "--db-dir", f"{self.tmp}/ro/pristine", "--meta", "3"]), 1)

    def test_a_symlinked_or_empty_db_dir_is_refused(self):
        os.symlink(f"{self.tmp}/ro/pristine", f"{self.tmp}/link")
        self.assertEqual(self.wrap(f"{self.tmp}/link")[0], 1)
        os.makedirs(f"{self.tmp}/empty")
        self.assertEqual(self.wrap(f"{self.tmp}/empty")[0], 1)

    def test_sigterm_during_the_check_run_kills_the_owned_group_and_writes_no_report(self):
        cancel_wrapper(self, f"{self.tmp}/ro/pristine", signal.SIGTERM, hang_on_version=False)   # tearDown: databases unchanged


def alive(pid):
    """True if pid exists and is not a zombie"""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


def gone_within(pid, sec=10.0):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return False


PY = sys.executable
BOUND = M.EOF_GRACE + M.KILL_GRACE + 3.0          # what bounded_run may take beyond its own timeout


def make_fake_chk(test, body):
    d = tempfile.mkdtemp(prefix="fakechk", dir=os.environ.get("TEST_TMP")); test.addCleanup(shutil.rmtree, d, True)
    p = f"{d}/mdbx_chk"
    with open(p, "w") as f:
        f.write(f"#!{PY} -I\n{body}\n")
    os.chmod(p, 0o755)
    return p, M.file_sha256(p)


def cancel_wrapper(test, db_dir, sig, hang_on_version):
    """r3: the REAL wrapper (python3 -I -B src/mdbx_check.py, its own process) is signalled while its owned fake mdbx_chk - and an
    in-group grandchild holding its stdout - hang. Required: exit 128+sig, 'CANCELLED', both processes gone, no report file."""
    pidfile = f"{tempfile.mkdtemp(prefix='cancel', dir=os.environ.get('TEST_TMP'))}/pids"
    test.addCleanup(shutil.rmtree, os.path.dirname(pidfile), True)
    hang = (f"import os, subprocess, time\ng = subprocess.Popen(['/usr/bin/sleep', '120'])\n"
            f"with open({pidfile + '.tmp'!r}, 'w') as f:\n    f.write(f'{{os.getpid()}} {{g.pid}}')\n"
            f"os.rename({pidfile + '.tmp'!r}, {pidfile!r})\ntime.sleep(120)")
    body = hang if hang_on_version else f"import sys\nif '-V' in sys.argv:\n    print('mdbx_chk {M.LIBMDBX_DESCRIBE}'); sys.exit(0)\n{hang}"
    p, sha = make_fake_chk(test, body)
    out = f"{os.path.dirname(pidfile)}/report.json"
    w = subprocess.Popen([PY, "-I", "-B", f"{STAGE}/src/mdbx_check.py", "--chk", p, "--chk-sha256", sha, "--db-dir", db_dir, "--out", out],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    pids = []

    def cleanup():                                     # only on a failed assertion: our own wrapper / its processes, by pid
        if w.poll() is None:
            w.kill(); w.wait()
        w.stderr.close()
        for pid in pids:
            if alive(pid):
                os.kill(pid, signal.SIGKILL)
    test.addCleanup(cleanup)
    end = time.monotonic() + 30
    while not os.path.exists(pidfile) and time.monotonic() < end and w.poll() is None:
        time.sleep(0.05)
    test.assertTrue(os.path.exists(pidfile), "the fake mdbx_chk never started")
    with open(pidfile) as f:
        pids.extend(int(x) for x in f.read().split())
    t0 = time.monotonic(); w.send_signal(sig)
    _out, err = w.communicate(timeout=BOUND + 5)
    test.assertLess(time.monotonic() - t0, BOUND)
    test.assertEqual(w.returncode, 128 + sig, err)
    test.assertIn(b"CANCELLED", err)
    for pid in pids:
        test.assertTrue(gone_within(pid, 5.0), f"owned process {pid} survived the cancellation")
    test.assertFalse(os.path.lexists(out), "a report was written after the cancellation")


class Runner(unittest.TestCase):
    """r2 (root review blocker): real child processes against bounded_run - silent hang, output flood, stdout held after the child's
    exit (inside and outside its process group), -V rc, timeout validation. No database involved."""

    def test_a_silent_child_cannot_defeat_the_timeout(self):
        t0 = time.monotonic(); r = M.bounded_run([PY, "-c", "import time; time.sleep(120)"], 1.0)
        self.assertLess(time.monotonic() - t0, 1.0 + BOUND)
        self.assertTrue(r["timedOut"]); self.assertLess(r["rc"], 0); self.assertFalse(M.run_clean(r))
        self.assertTrue(gone_within(r["pid"]))

    def test_an_output_flood_is_capped_and_killed(self):
        t0 = time.monotonic()
        r = M.bounded_run([PY, "-c", "import sys\nwhile True: sys.stdout.buffer.write(b'x' * 65536)"], 60.0, cap=1 << 16)
        self.assertLess(time.monotonic() - t0, BOUND + 5)
        self.assertTrue(r["cut"]); self.assertLessEqual(len(r["text"]), 1 << 16); self.assertFalse(M.run_clean(r))
        self.assertTrue(gone_within(r["pid"]))

    def test_a_grandchild_holding_stdout_in_the_group_is_killed_not_waited_for(self):
        code = ("import subprocess, sys\ng = subprocess.Popen(['/usr/bin/sleep', '120'])\nprint(g.pid, flush=True)\n")   # inherits stdout
        t0 = time.monotonic(); r = M.bounded_run([PY, "-c", code], 60.0)
        self.assertLess(time.monotonic() - t0, BOUND)
        self.assertEqual(r["rc"], 0); self.assertTrue(r["heldOpen"]); self.assertFalse(r["escaped"]); self.assertFalse(M.run_clean(r))
        self.assertTrue(gone_within(int(r["text"].split()[0])), "the in-group holder survived")

    def test_a_holder_that_escaped_the_group_is_reported_and_never_waited_for(self):
        code = ("import subprocess, sys\ng = subprocess.Popen(['/usr/bin/setsid', '/usr/bin/sleep', '120'])\nprint(g.pid, flush=True)\n")
        t0 = time.monotonic(); r = M.bounded_run([PY, "-c", code], 60.0)
        gpid = int(r["text"].split()[0])
        self.addCleanup(lambda: os.kill(gpid, 9) if alive(gpid) else None)       # the test's own escaped process, by its pid
        self.assertLess(time.monotonic() - t0, BOUND)
        self.assertTrue(r["heldOpen"]); self.assertTrue(r["escaped"]); self.assertFalse(M.run_clean(r))

    def test_a_normal_child_is_clean_and_fully_reaped(self):
        r = M.bounded_run(["/usr/bin/echo", "hi"], 10.0)
        self.assertEqual((r["rc"], r["text"], M.run_clean(r)), (0, "hi\n", True)); self.assertFalse(alive(r["pid"]))

    def fake_chk(self, body):
        return make_fake_chk(self, body)

    def test_sigterm_or_sighup_during_the_version_probe_kills_the_owned_group(self):
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(sig=sig):
                cancel_wrapper(self, "/nonexistent", sig, hang_on_version=True)

    def test_version_needs_rc_zero_and_the_exact_describe(self):
        p, sha = self.fake_chk(f"import sys\nprint('mdbx_chk {M.LIBMDBX_DESCRIBE}')\nsys.exit(3)")
        self.assertEqual(M.main(["mdbx_check.py", "--chk", p, "--chk-sha256", sha, "--db-dir", "/nonexistent"]), 1)
        p, sha = self.fake_chk("print('mdbx_chk v0.13.11-0-gdeadbee')")
        self.assertEqual(M.main(["mdbx_check.py", "--chk", p, "--chk-sha256", sha, "--db-dir", "/nonexistent"]), 1)

    def test_a_hanging_version_probe_is_bounded(self):
        p, sha = self.fake_chk("import time\ntime.sleep(120)")
        old = M.VERSION_TIMEOUT; M.VERSION_TIMEOUT = 1.0; self.addCleanup(setattr, M, "VERSION_TIMEOUT", old)
        t0 = time.monotonic()
        self.assertEqual(M.main(["mdbx_check.py", "--chk", p, "--chk-sha256", sha, "--db-dir", "/nonexistent"]), 1)
        self.assertLess(time.monotonic() - t0, 1.0 + BOUND)

    def test_a_non_positive_or_absurd_timeout_is_refused(self):
        for t in ("0", "-5", str(7 * 86400 + 1)):
            self.assertEqual(M.main(["mdbx_check.py", "--chk", CHK, "--chk-sha256", CHK_SHA, "--db-dir", "/nonexistent", "--timeout", t]), 1, t)
        for t in (0, -1, 0.0, True):
            with self.assertRaises(M.Refused):
                M.bounded_run(["/usr/bin/true"], t)


if __name__ == "__main__":
    unittest.main()
