#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r3 tests (prepared by Claude 1782/1785/1787; NOT run by Claude). 12 tests (r1's 7 with test 7
extended for m2; 8: an INJECTED unmount timeout, 9: a REAL busy-mount unmount failure, 10: stale output refusal; r3: 11 a previous
run's work dir / socket / mount / live session are never touched, 12 an unmount program that cannot even start still ends and reaps
both children), REAL tools end to end:
a tiny REAL MDBX (the pinned mk_fixture, libmdbx v0.13.12) -> its mdbx.dat split into REAL recovery-multipart r3 records (the
pinned r3 CLI: plan / copy / verify, fixture kind) -> a REAL r6 records view (fixture kind) -> composite_session.py as a subprocess
(the pinned qemu-nbd --read-only, nbdfuse -r -o ro, the pinned r4 wrapper + mdbx_chk). Unprivileged, NOT under unshare (FUSE needs
the host fusermount3). Environment (jobs/tests.sh): COMPOSITE_TEST_TMP, MDBX_BIN (mk_fixture)."""
import contextlib, glob, hashlib, io, json, os, signal, subprocess, sys, tempfile, time, unittest

TMP = os.environ.get("COMPOSITE_TEST_TMP", "")
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("COMPOSITE_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP
STAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, STAGE)
import composite_session as C  # noqa: E402

TOOL = os.path.join(STAGE, "composite_session.py")
R3 = os.path.join(C.W, "recovery-multipart-stage/r3/multipart.py")
MK = os.path.join(os.environ["MDBX_BIN"], "mk_fixture")
BS, PART = 4096, 65536
sys.path.insert(0, os.path.dirname(C.PINS["r6Importer"][0]))
PI = C.load_pinned("r6Importer", "r6_production_import")
R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")


def r3cli(*args):
    r = subprocess.run([sys.executable, "-I", "-B", R3, *args], capture_output=True, text=True, timeout=300, env={"PATH": "/usr/bin:/bin"})
    assert r.returncode == 0, r.stderr
    return r


class Fx:
    """a real MDBX -> real r3 records (two targets) -> a real r6 fixture view"""
    def __init__(self, corrupt=False):
        self.d = tempfile.mkdtemp(prefix="cx", dir=TMP)
        j = lambda *x: os.path.join(self.d, *x)
        os.mkdir(j("src-db"), 0o700)
        subprocess.run([MK, j("src-db"), "3000"], check=True, capture_output=True, timeout=300)
        with open(j("src-db", "mdbx.dat"), "rb") as f:
            data = bytearray(f.read())
        assert data and len(data) % BS == 0, len(data)
        if corrupt:
            data[:3 * BS] = bytes(3 * BS)                                # all three meta pages zeroed: not an openable MDBX
        self.bytes, self.src = bytes(data), j("source.img")
        with open(self.src, "wb") as f:
            f.write(self.bytes)
        L, n = len(self.bytes), -(-len(self.bytes) // PART)
        with open(j("map.json"), "w") as f:
            json.dump({"format": "ext4-recovery-checksum-r1/v1", "map": {"extentList": [[0, L // BS, 900, False]], "extents": 1}}, f)
        with open(j("journal.bin"), "wb") as f:
            f.write(b"j" * 65536)
        with open(j("original.qcow2"), "wb") as f:
            f.write(b"q" * 12345)
        with open(j("plan.json"), "w") as f:
            json.dump({"format": "recovery-overlay-plan/v1", "mode": "fixture", "inputs": {"captureSha256": "00" * 32},
                       "target": {"size": L, "path": "/data/db/mdbx.dat"}, "map": {"extents": 1},
                       "patches": [{"kind": "inode", "fsBlock": 7, "byteOffset": 1024, "length": 256, "sha256": "ab" * 32, "source": "000.bin"}]}, f)
        ta, tb = j("target-a"), j("target-b")
        os.mkdir(ta, 0o700); os.mkdir(tb, 0o700)
        k = max(1, n // 2)
        assign = ["--assign", f"a:0-{k - 1}"] + (["--assign", f"b:{k}-{n - 1}"] if n > k else [])
        self.manifest = j("manifest.json")
        r = r3cli("plan", "--original", j("original.qcow2"), "--map", j("map.json"), "--overlay-plan", j("plan.json"), "--journal",
                  j("journal.bin"), "--out", self.manifest, "--target", f"a={ta}", "--target", f"b={tb}", *assign, "--logical-size", str(L),
                  "--part-size", str(PART), "--chunk-bytes", "8192", "--checkpoint-bytes", "16384")
        self.msha = json.loads(r.stdout)["manifestSha256"]
        m = ["--manifest", self.manifest, "--manifest-sha256", self.msha, "--source-file", self.src]
        r3cli("copy", *m); r3cli("verify", *m)
        self.parts = [os.path.join(ta if i < k else tb, f"part-{i:04d}.bin") for i in range(n)]
        self.view = j("view")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = PI.main(["import", "--manifest", self.manifest, "--manifest-sha256", self.msha, "--out-dir", self.view, "--expect-kind", "fixture"])
        assert rc == 0
        self.n = 0

    def run_dir(self):
        self.n += 1
        d = os.path.join(self.d, f"run{self.n}"); os.mkdir(d, 0o700)
        return d

    def idents(self):
        return [(os.lstat(p).st_ino, os.lstat(p).st_mode, os.lstat(p).st_ctime_ns, os.lstat(p).st_mtime_ns) for p in self.parts]


def receipt(run):
    with open(os.path.join(run, "receipt.json")) as f:
        return json.load(f)


def refused_receipt(run):
    """r3: a run dir this session did not claim gets ONLY its own receipt-refused-<ns>.json (no receipt.json taken)"""
    names = glob.glob(os.path.join(run, "receipt-refused-*.json"))
    assert len(names) == 1, names
    with open(names[0]) as f:
        return json.load(f)


class Composite(unittest.TestCase):
    def session(self, fx, run, *extra, kind=("--expect-kind", "fixture"), timeout=900):
        return subprocess.run([sys.executable, "-I", "-B", TOOL, "--view-dir", fx.view, "--run-dir", run, *kind, *extra],
                              capture_output=True, text=True, timeout=timeout, env={"PATH": "/usr/bin:/bin"})

    def clean_after(self, run, r):
        """the always-required end state: receipt present, cleanup complete, our mount gone, nothing names the work dir"""
        self.assertTrue(r["cleanupComplete"], r)
        db = os.path.join(run, "work", "db")
        self.assertFalse(R9.mounted(db))
        self.assertEqual(r.get("leftoverProcesses", []), [])
        self.assertFalse(r.get("mountLeft", False))

    def test_1_real_mdbx_chk_on_the_composite_view_is_clean_and_retained(self):
        fx = Fx(); before = fx.idents(); run = fx.run_dir()
        p = self.session(fx, run, "--validator-timeout", "600")
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (0, "CLEAN"), p.stdout + p.stderr)
        self.clean_after(run, r)
        for k in ("preUseRecheck", "socketOurs", "qemu-nbdBound", "heldBeforeMount", "nbdfuseForeground", "nbdfuseBound", "mountReadOnly",
                  "onlyMdbxDat", "logicalSize", "writeRefused", "heldBeforeExec", "postUseRecheck"):
            self.assertTrue(r["checks"][k]["ok"], k)
        with open(os.path.join(run, "mdbx-report.json")) as f:
            rep = json.load(f)
        self.assertEqual((rep["rc"], rep["structurallyClean"], rep["preflight"]["mdbxDatBytes"]), (0, True, len(fx.bytes)))
        with open(os.path.join(run, "mdbx-report.json"), "rb") as f:
            self.assertEqual(r["reportSha256"], hashlib.sha256(f.read()).hexdigest())
        self.assertTrue(os.path.exists(os.path.join(run, "validator.out")))
        self.assertEqual(r["view"]["kind"], "fixture"); self.assertEqual(fx.idents(), before)          # no part touched

    def test_2_production_is_the_default_kind_and_fixture_exec_is_fixture_only(self):
        fx = Fx(); run = fx.run_dir()
        p = self.session(fx, run, kind=())
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (3, "REFUSED")); self.assertFalse(os.path.exists(os.path.join(run, "work")))
        run = fx.run_dir()
        p = self.session(fx, run, "--fixture-exec", "/usr/bin/true", kind=("--expect-kind", "production"))
        self.assertEqual((p.returncode, receipt(run)["outcome"]), (3, "REFUSED"))

    def test_3_a_changed_part_refuses_before_use_and_voids_a_result_during_use(self):
        fx = Fx(); run = fx.run_dir()
        os.utime(fx.parts[0], ns=(1, 1))
        p = self.session(fx, run)
        self.assertEqual((p.returncode, receipt(run)["outcome"]), (3, "REFUSED")); self.assertFalse(os.path.exists(os.path.join(run, "work")))
        fx = Fx(); run = fx.run_dir()
        code = f"import os; os.utime({fx.parts[-1]!r}, ns=(2, 2))"            # the validator 'passes' but the view changed under it
        p = self.session(fx, run, "--exec-timeout", "60", "--fixture-exec", "/usr/bin/python3", "-I", "-c", code)
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (8, "VOID"), r)
        self.assertFalse(r["checks"]["postUseRecheck"]["ok"]); self.clean_after(run, r)

    def test_4_validator_failures_are_reported_never_clean(self):
        fx = Fx(corrupt=True); run = fx.run_dir()
        p = self.session(fx, run, "--validator-timeout", "600")
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (2, "PROBLEMS"), r)
        self.assertIn(r["validatorReport"]["rc"], (1, 2, 3)); self.assertFalse(r["validatorReport"]["structurallyClean"])
        self.clean_after(run, r)
        fx = Fx(); run = fx.run_dir()
        p = self.session(fx, run, "--exec-timeout", "60", "--fixture-exec", "/usr/bin/false")
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (6, "EXEC-FAILED")); self.clean_after(run, r)

    def test_5_sigterm_while_the_validator_and_an_escaped_holder_hold_the_view(self):
        fx = Fx(); run = fx.run_dir(); mark = os.path.join(run, "holding")
        code = ("import os, subprocess, time\n"
                "db = os.environ['RECOVERY_TARGET_DB']\n"
                "f = open(os.path.join(db, 'mdbx.dat'), 'rb')\n"
                "subprocess.Popen(['/usr/bin/setsid', '/usr/bin/sleep', '300'], stdin=f)\n"     # escapes our group, holds the file
                f"open({mark!r}, 'w').close()\n"
                "time.sleep(300)\n")
        s = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "--view-dir", fx.view, "--run-dir", run, "--expect-kind", "fixture",
                              "--exec-timeout", "600", "--fixture-exec", "/usr/bin/python3", "-I", "-c", code],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        try:
            end = time.monotonic() + 120
            while not os.path.exists(mark):
                self.assertIsNone(s.poll(), "the session ended before the holder was in place"); self.assertLess(time.monotonic(), end)
                time.sleep(0.2)
            s.send_signal(signal.SIGTERM)                                   # our own child only
            s.communicate(timeout=300)
        finally:
            if s.poll() is None:
                s.kill(); s.communicate(timeout=60)
        r = receipt(run)
        self.assertEqual((s.returncode, r["outcome"]), (5, "CANCELLED"), r)
        self.clean_after(run, r); self.assertTrue(r["adoptedKilled"])        # the escaped holder ended before the unmount

    def test_6_timeout_or_leftover_descendants_are_inconclusive(self):
        fx = Fx(); run = fx.run_dir()
        p = self.session(fx, run, "--exec-timeout", "3", "--fixture-exec", "/usr/bin/sleep", "300")
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (7, "INCONCLUSIVE")); self.assertTrue(r["exec"]["timedOut"]); self.clean_after(run, r)
        run = fx.run_dir()
        p = self.session(fx, run, "--exec-timeout", "60", "--fixture-exec", "/usr/bin/sh", "-c", "/usr/bin/sleep 300 & exit 0")
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"]), (7, "INCONCLUSIVE"), r); self.clean_after(run, r)

    def test_7_classification_never_turns_a_timeout_or_a_missing_report_into_clean_or_corrupt(self):
        ok = {"rc": 0, "timedOut": False, "groupLeftovers": [], "escapedKilled": 0, "groupEmpty": True, "orphansGone": True}
        rep = {"rc": 0, "structurallyClean": True, "timedOut": False, "outputTruncated": False, "stdoutHeldAfterExit": False,
               "escapedHolder": False, "unchangedIdentity": True, "result": "ok", "preflight": {"mdbxDatBytes": 4096}}
        cases = [
            (ok, rep, True, "CLEAN"), (ok, rep, False, "VOID"),
            (ok, {**rep, "timedOut": True, "rc": -9, "structurallyClean": False}, True, "INCONCLUSIVE"),
            ({**ok, "rc": 2}, {**rep, "rc": 2, "structurallyClean": False, "result": "major-problems"}, True, "PROBLEMS"),
            ({**ok, "rc": 2}, {**rep, "rc": 3, "structurallyClean": False}, True, "PROBLEMS"),
            ({**ok, "rc": 2}, {**rep, "rc": 4, "structurallyClean": False}, True, "INCONCLUSIVE"),
            ({**ok, "rc": 2}, {**rep, "rc": 5, "structurallyClean": False}, True, "INCONCLUSIVE"),
            (ok, {**rep, "outputTruncated": True}, True, "INCONCLUSIVE"), (ok, {**rep, "unchangedIdentity": False}, True, "INCONCLUSIVE"),
            ({**ok, "rc": 1}, None, True, "INCONCLUSIVE"), ({**ok, "timedOut": True}, rep, True, "INCONCLUSIVE"),
            ({**ok, "escapedKilled": 1}, rep, True, "INCONCLUSIVE"), ({**ok, "rc": 143}, rep, True, "INCONCLUSIVE"),
        ]
        for e, report, post, want in cases:
            self.assertEqual(C.classify(e, report, post, False, 4096)[0], want, (e, report, post))
        # m2: a clean report that did not cover the whole view (or with no expected size) is never CLEAN
        self.assertEqual(C.classify(ok, rep, True, False, 8192)[0], "INCONCLUSIVE")
        self.assertEqual(C.classify(ok, rep, True, False, None)[0], "INCONCLUSIVE")
        self.assertEqual(C.classify(ok, {**rep, "preflight": {}}, True, False, 4096)[0], "INCONCLUSIVE")
        self.assertEqual(C.classify(ok, None, True, True)[0], "EXEC-OK")
        self.assertEqual(C.classify({**ok, "rc": 1}, None, True, True)[0], "EXEC-FAILED")

    def ended(self, r):
        """A2: every owned child ended and reaped, nothing alive or mounted, whatever failed"""
        for name in ("qemu-nbd", "nbdfuse"):
            self.assertIsNotNone(r["children"][name]["returncode"], name)
            self.assertFalse(os.path.exists(f"/proc/{r['children'][name]['pid']}/fd"), name)   # reaped (no zombie entry with fds)
        self.assertEqual(r["childrenAlive"], []); self.assertFalse(r["mountLeft"]); self.assertEqual(r["leftoverProcesses"], [])

    def test_8_an_injected_unmount_timeout_still_ends_every_owned_child_and_fails_closed(self):
        fx = Fx(); run = fx.run_dir()
        fake = os.path.join(fx.d, "hung-fusermount")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\nexec /usr/bin/sleep 60\n")
        os.chmod(fake, 0o700)
        p = self.session(fx, run, "--exec-timeout", "60", "--fixture-unmount-exe", fake, "--fixture-exec", "/usr/bin/true")
        r = receipt(run)
        self.assertEqual((p.returncode, r["outcome"], r["cleanupComplete"]), (4, "CLEANUP-INCOMPLETE", False), r)
        self.assertEqual(r["unmount"]["normal"], "timeout")
        self.ended(r); self.assertFalse(R9.mounted(os.path.join(run, "work", "db")))
        run = fx.run_dir()                                                   # the injection is fixture-only
        p = self.session(fx, run, "--fixture-unmount-exe", fake, kind=("--expect-kind", "production"))
        self.assertEqual((p.returncode, receipt(run)["outcome"]), (3, "REFUSED"))

    def test_9_a_real_busy_mount_unmount_failure_still_ends_every_owned_child_and_fails_closed(self):
        fx = Fx(); run = fx.run_dir(); mark, go = os.path.join(run, "ready"), os.path.join(fx.d, "go")
        code = (f"import os, time\nopen({mark!r}, 'w').close()\nend = time.monotonic() + 120\n"
                f"while not os.path.exists({go!r}) and time.monotonic() < end:\n    time.sleep(0.1)\n")
        s = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "--view-dir", fx.view, "--run-dir", run, "--expect-kind", "fixture",
                              "--exec-timeout", "300", "--fixture-exec", "/usr/bin/python3", "-I", "-c", code],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        held = None
        try:
            end = time.monotonic() + 120
            while not os.path.exists(mark):
                self.assertIsNone(s.poll()); self.assertLess(time.monotonic(), end); time.sleep(0.2)
            held = os.open(os.path.join(run, "work", "db", "mdbx.dat"), os.O_RDONLY)   # NOT the session's child: the unmount is busy
            open(go, "w").close()
            s.communicate(timeout=300)
        finally:
            if s.poll() is None:
                s.kill(); s.communicate(timeout=60)
            if held is not None:
                os.close(held)
        r = receipt(run)
        self.assertEqual((s.returncode, r["outcome"], r["cleanupComplete"]), (4, "CLEANUP-INCOMPLETE", False), r)
        self.assertNotEqual(r["unmount"]["normal"], 0); self.assertEqual(r["unmount"].get("lazy"), 0)     # our dead mount detached
        self.ended(r); self.assertFalse(R9.mounted(os.path.join(run, "work", "db")))

    def test_10_a_run_dir_with_any_previous_output_is_refused_and_left_untouched(self):
        fx = Fx()
        for name in ("mdbx-report.json", "validator.out", "session.pid", "receipt-1.json"):
            run = fx.run_dir()
            with open(os.path.join(run, name), "w") as f:
                f.write('{"rc": 2, "structurallyClean": false}')            # a stale "PROBLEMS" report must never be read
            p = self.session(fx, run, "--validator-timeout", "60")
            r = refused_receipt(run)
            self.assertEqual((p.returncode, r["outcome"]), (3, "REFUSED"), name)
            self.assertEqual(os.path.exists(os.path.join(run, "receipt.json")), name == "receipt.json")
            self.assertFalse(os.path.exists(os.path.join(run, "work")), name)
            with open(os.path.join(run, name)) as f:
                self.assertEqual(f.read(), '{"rc": 2, "structurallyClean": false}')

    def test_11_a_previous_runs_work_socket_mount_and_live_session_are_never_touched(self):
        fx = Fx(); run = fx.run_dir()                                       # (a) a stale work dir with a socket marker
        work = os.path.join(run, "work"); os.mkdir(work, 0o700); os.mkdir(os.path.join(work, "db"), 0o700)
        for n in ("nbd.sock", "qemu-nbd.log"):
            with open(os.path.join(work, n), "w") as f:
                f.write("prior")
        p = self.session(fx, run)
        self.assertEqual((p.returncode, refused_receipt(run)["outcome"]), (3, "REFUSED"))
        for n in ("nbd.sock", "qemu-nbd.log"):
            with open(os.path.join(work, n)) as f:
                self.assertEqual(f.read(), "prior", n)
        self.assertEqual(sorted(os.listdir(work)), ["db", "nbd.sock", "qemu-nbd.log"]); self.assertFalse(os.path.exists(os.path.join(run, "receipt.json")))
        run = fx.run_dir(); mark, go = os.path.join(run, "ready"), os.path.join(fx.d, "go11")   # (b) a LIVE session A in the run dir
        code = (f"import os, time\nopen({mark!r}, 'w').close()\nend = time.monotonic() + 120\n"
                f"while not os.path.exists({go!r}) and time.monotonic() < end:\n    time.sleep(0.1)\n")
        a = subprocess.Popen([sys.executable, "-I", "-B", TOOL, "--view-dir", fx.view, "--run-dir", run, "--expect-kind", "fixture",
                              "--exec-timeout", "300", "--fixture-exec", "/usr/bin/python3", "-I", "-c", code],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        try:
            end = time.monotonic() + 120
            while not os.path.exists(mark):
                self.assertIsNone(a.poll()); self.assertLess(time.monotonic(), end); time.sleep(0.2)
            db, sock = os.path.join(run, "work", "db"), os.path.join(run, "work", "nbd.sock")
            self.assertTrue(R9.mounted(db)); self.assertTrue(os.path.exists(sock))
            b = self.session(fx, run)                                        # B on A's run dir: refused, and must touch NOTHING of A
            self.assertEqual((b.returncode, refused_receipt(run)["outcome"]), (3, "REFUSED"))
            self.assertTrue(R9.mounted(db)); self.assertTrue(os.path.exists(sock)); self.assertIsNone(a.poll())
            self.assertFalse(os.path.exists(os.path.join(run, "receipt.json")))
            open(go, "w").close()
            a.communicate(timeout=300)
        finally:
            if a.poll() is None:
                a.kill(); a.communicate(timeout=60)
        r = receipt(run)                                                     # A (the owner) still completes normally
        self.assertEqual((a.returncode, r["outcome"]), (0, "EXEC-OK"), r); self.clean_after(run, r)

    def test_12_an_unmount_program_that_cannot_start_still_ends_and_reaps_both_children(self):
        fx = Fx()
        noexec = os.path.join(fx.d, "not-executable")
        with open(noexec, "w") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(noexec, 0o600)
        for fake, err in ((os.path.join(fx.d, "absent-fusermount"), "FileNotFoundError"), (noexec, "PermissionError")):
            run = fx.run_dir()
            p = self.session(fx, run, "--exec-timeout", "60", "--fixture-unmount-exe", fake, "--fixture-exec", "/usr/bin/true")
            r = receipt(run)
            self.assertEqual((p.returncode, r["outcome"], r["cleanupComplete"]), (4, "CLEANUP-INCOMPLETE", False), r)
            self.assertTrue(r["unmount"]["normal"].startswith(f"error: {err}"), r["unmount"])
            self.ended(r); self.assertFalse(R9.mounted(os.path.join(run, "work", "db")))


if __name__ == "__main__":
    unittest.main()
