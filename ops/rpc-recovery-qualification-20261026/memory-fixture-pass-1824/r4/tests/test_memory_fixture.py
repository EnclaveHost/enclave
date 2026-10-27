#!/usr/bin/env python3
"""composite-memory-fixture-stage/r4 unit tests (prepared by Claude 1810/1813; NOT run by Claude). 11 TINY tests: no FUSE, mount, qemu, scope
change or large memory. Scope parsing / lane / reservation / soft-stop decisions, the MemoryHigh setter's binding and verification against a
FAKE cgroup tree + FAKE systemctl (mismatch, failure, not applied, parent changed), the sparse allocation cap, the walker on tiny files,
an ORDERED cancellation of a real owned child through the qualified r6 Session cleanup, and the outcome classification.
Everything lives under $CMF_TEST_TMP (never TMPDIR/HOME)."""
import contextlib, hashlib, io, json, os, signal, subprocess, sys, tempfile, time, types, unittest

TMP = os.environ.get("CMF_TEST_TMP", "")
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("CMF_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP
STAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, STAGE)
import memory_fixture as M  # noqa: E402

UID = os.getuid()
GOOD = f"/user.slice/user-{UID}.slice/user@{UID}.service/app.slice/run-p123-i124.scope"


class Pure(unittest.TestCase):
    def test_1_only_this_users_transient_run_scope_is_accepted(self):
        self.assertEqual(M.scope_of(f"0::{GOOD}\n", UID), (GOOD, "run-p123-i124.scope"))
        for bad in (f"0::/user.slice/user-{UID}.slice/user@{UID}.service/app.slice/app-org.chromium.Chromium-1.scope",  # not ours
                    f"0::/user.slice/user-{UID + 1}.slice/user@{UID + 1}.service/app.slice/run-p1-i2.scope",          # other user
                    "0::/system.slice/run-p1-i2.scope", f"0::{GOOD}/child", f"0::{GOOD}\n1:name=x:/", ""):
            with self.assertRaises(M.Refused, msg=bad):
                M.scope_of(bad, UID)

    def test_2_lane_reservation_and_soft_stop_decisions(self):
        self.assertTrue(M.lane_ok(f"{768 << 20}\n"))
        for bad in ("max", str(512 << 20), str(2560 << 20)):
            with self.assertRaises(M.Refused):
                M.lane_ok(bad)
        need = (100 << 30) + (40 << 30) + (8 << 30) + M.FIXTURE_WRITE_BOUND           # F2: fixture writes are NOT taken from the 8 GiB
        self.assertEqual(M.FIXTURE_WRITE_BOUND, (64 << 20) + 3 * (4 << 20) + (16 << 20))
        self.assertEqual(M.reservation_ok(need, 100 << 30, 40 << 30)["marginBytes"], 0)
        with self.assertRaises(M.Refused):
            M.reservation_ok(need - 1, 100 << 30, 40 << 30)              # the full remaining recovery reservation is preserved
        self.assertIsNone(M.soft_stop_reason(639, 20000))
        self.assertIn("tree VmRSS", M.soft_stop_reason(641, 20000))
        self.assertIn("MemAvailable", M.soft_stop_reason(100, 16895))

    def test_3_memory_high_is_set_only_on_our_bound_scope_and_verified(self):
        def tree(own_high="max", parent_high="max"):
            cg = tempfile.mkdtemp(prefix="cg")
            own = os.path.join(cg, GOOD.lstrip("/")); os.makedirs(own)
            for d, h in ((own, own_high), (os.path.dirname(own), parent_high)):
                with open(os.path.join(d, "memory.high"), "w") as f:
                    f.write(h + "\n")
            with open(os.path.join(own, "memory.max"), "w") as f:
                f.write(f"{768 << 20}\n")
            return cg, own

        def runner(cg, own, group=GOOD, set_rc=0, apply=True, touch_parent=False, calls=None):
            def run(args):
                (calls if calls is not None else []).append(args[0])
                if args[0] == "show" and args[2] == "ControlGroup":
                    return 0, group + "\n"
                if args[0] == "set-property":
                    if set_rc == 0 and apply:
                        with open(os.path.join(own, "memory.high"), "w") as f:
                            f.write(f"{512 << 20}\n")
                    if touch_parent:
                        with open(os.path.join(os.path.dirname(own), "memory.high"), "w") as f:
                            f.write("1\n")
                    return set_rc, "" if set_rc == 0 else "Access denied"
                if args[0] == "show" and args[2] == "MemoryHigh":
                    with open(os.path.join(own, "memory.high")) as f:
                        return 0, f.read()
                return 1, "unexpected"
            return run
        cg, own = tree()
        r = M.set_memory_high(GOOD, "run-p123-i124.scope", runner(cg, own), cg=cg)
        self.assertEqual(r["after"]["ownHigh"], str(512 << 20)); self.assertEqual(r["after"]["parentHigh"], "max")
        cases = (("scope mismatch", {"group": GOOD.replace("run-p123", "run-p999")}, "max"),
                 ("setter failure", {"set_rc": 1}, "max"), ("not applied", {"apply": False}, "max"),
                 ("parent changed", {"touch_parent": True}, "max"), ("already set", {}, str(256 << 20)))
        for label, kw, own_high in cases:
            cg, own = tree(own_high=own_high); calls = []
            with self.assertRaises(M.Refused, msg=label):
                M.set_memory_high(GOOD, "run-p123-i124.scope", runner(cg, own, calls=calls, **kw), cg=cg)
            if label in ("scope mismatch", "already set"):
                self.assertNotIn("set-property", calls, label)        # nothing is changed before the binding is proven

    def test_4_the_image_must_stay_sparse(self):
        p = os.path.join(tempfile.mkdtemp(prefix="img"), "sparse.raw")
        with open(p, "wb") as f:
            f.truncate(M.IMAGE_BYTES)
        self.assertLessEqual(M.allocated_ok(p), M.ALLOC_CAP)
        q = os.path.join(os.path.dirname(p), "dense.raw")
        with open(q, "wb") as f:
            f.write(b"\x01" * (2 << 20)); f.flush(); os.fsync(f.fileno())
        with self.assertRaises(M.Refused):
            M.allocated_ok(q, cap=1 << 20)

    def test_5_walker_touches_every_page_of_tiny_files(self):
        d = tempfile.mkdtemp(prefix="walk")
        walk = lambda path, n: subprocess.run([sys.executable, "-I", "-B", os.path.join(STAGE, "walker.py"), path, str(n), "60"],
                                              capture_output=True, text=True, timeout=60)
        z = os.path.join(d, "zero.raw")
        with open(z, "wb") as f:
            f.truncate(1 << 20)
        r = walk(z, 1 << 20)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        res = json.loads(r.stdout.splitlines()[-1])
        self.assertEqual((res["scannedBytes"], res["pages"], res["nonzeroPages"]), (1 << 20, 256, 0))
        nz = os.path.join(d, "nonzero.raw")
        with open(nz, "wb") as f:
            f.truncate(1 << 20); f.seek(4096 * 7); f.write(b"\x01")
        r = walk(nz, 1 << 20)
        self.assertEqual((r.returncode, json.loads(r.stdout.splitlines()[-1])["nonzeroPages"]), (1, 1))
        self.assertEqual(walk(z, 2 << 20).returncode, 2)                   # size mismatch: never a partial claim

    def test_6_an_ordered_cancel_ends_and_reaps_the_walker_through_r6_cleanup(self):
        C = M.load_exact("r6Runtime", "r6_composite_session")
        R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")
        run = tempfile.mkdtemp(prefix="run")
        a = type("A", (), {"run_dir": run, "expect_kind": "fixture", "fixture_unmount_exe": None, "view_dir": None,
                           "tree_root_pid": os.getpid()})()
        s = M.make_session_class(C)(a, R9, None, {})
        os.mkdir(s.work, 0o700); s.owns_work = True
        c = s.spawn("exec", ["/usr/bin/sleep", "300"], cwd=s.work)        # the stand-in walker: our own group child
        self.assertFalse(R9.exited_nowait(c.pid))
        self.assertTrue(R9.stop_group(c, grace=0))                        # the soft-stop path: the walker group FIRST
        s.cleanup()                                                       # then the qualified r6 ordered cleanup
        self.assertIsNotNone(c.returncode)
        self.assertTrue(s.receipt["cleanupComplete"], s.receipt)
        self.assertEqual((s.receipt["childrenAlive"], s.receipt["leftoverProcesses"], s.receipt["mountLeft"]), ([], [], False))

    def test_7_outcomes_never_overclaim(self):
        ok = {"rc": 0, "result": {"scannedBytes": M.IMAGE_BYTES, "nonzeroPages": 0}, "groupLeftovers": [], "groupEmpty": True,
              "orphansGone": True, "softStop": None, "timedOut": False}
        rec = {"cleanupComplete": True, "cgBefore": {"events": {"high": 3}}, "cgAfter": {"events": {"high": 9}}}
        self.assertEqual(M.outcome(rec, ok, None, None)[0], "MEASURED")
        self.assertEqual(M.outcome({**rec, "cgAfter": {"events": {"high": 3}}}, ok, None, None)[0], "INCONCLUSIVE")
        self.assertEqual(M.outcome(rec, {**ok, "result": {"scannedBytes": 4096, "nonzeroPages": 0}}, None, None)[0], "FAILED")
        self.assertEqual(M.outcome(rec, {**ok, "rc": -9}, None, None)[0], "FAILED")
        self.assertEqual(M.outcome(rec, {**ok, "softStop": "soft stop: x"}, None, None)[0], "SOFT-STOP")
        self.assertEqual(M.outcome(rec, {**ok, "timedOut": True}, None, None)[0], "TIMEOUT")
        self.assertEqual(M.outcome(rec, None, None, "Refused: x")[0], "REFUSED")
        self.assertEqual(M.outcome(rec, ok, None, "Refused: late")[0], "FAILED")
        self.assertEqual(M.outcome(rec, ok, "signal 15", None)[0], "CANCELLED")
        self.assertEqual(M.outcome({**rec, "cleanupComplete": False}, ok, "signal 15", None)[0], "CLEANUP-INCOMPLETE")

    # ---- r2 (review 1811 F2 / F4, root) -------------------------------------------------------------------------------------------
    def test_8_a_real_sigterm_during_use_cancels_cleans_up_with_signals_ignored_and_writes_the_owned_receipt(self):
        C = M.load_exact("r6Runtime", "r6_composite_session")
        run, seen = tempfile.mkdtemp(prefix="drv"), {}

        class Stub:
            def __init__(self):
                self.receipt, self.owns_run, self.owns_work = {"format": M.FORMAT}, False, False
                self.walk, self.image_id, self.peaks, self.samples = None, None, {}, []

            def prepare(self):
                with C.deferred():
                    os.close(os.open(os.path.join(run, "session.pid"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)); self.owns_run = True

            def expose(self):
                self.owns_work = True

            def use(self):
                os.kill(os.getpid(), signal.SIGTERM)                         # the real signal -> r6 _on_signal -> Stop
                time.sleep(5); seen["notInterrupted"] = True

            def cleanup(self):
                seen["handler"] = signal.getsignal(signal.SIGTERM); self.receipt["cleanupComplete"] = True
        before = signal.getsignal(signal.SIGTERM)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = M.drive(types.SimpleNamespace(run_dir=run), C, Stub, time.monotonic())
        self.assertEqual(rc, 5); self.assertNotIn("notInterrupted", seen)
        self.assertIs(seen["handler"], signal.SIG_IGN)                       # cleanup ran with the cancel signals ignored
        self.assertIs(signal.getsignal(signal.SIGTERM), before)              # handlers restored afterwards
        with open(os.path.join(run, "receipt.json")) as f:
            r = json.load(f)
        self.assertEqual((r["outcome"], r["rc"], r["cleanupComplete"]), ("CANCELLED", 5, True))

    def test_9_a_refusal_in_an_unowned_old_run_dir_writes_nothing_there(self):
        C = M.load_exact("r6Runtime", "r6_composite_session")
        R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")
        run = tempfile.mkdtemp(prefix="old")
        for n, body in (("session.pid", '{"pid": 1}'), ("receipt.json", '{"outcome": "LIVE"}')):
            with open(os.path.join(run, n), "w") as f:
                f.write(body)
        def snap():
            result = {}
            for n in sorted(os.listdir(run)):
                with open(os.path.join(run, n)) as handle:
                    result[n] = handle.read()
            return result
        before = snap()

        class Refusing:
            def __init__(self):
                self.receipt, self.owns_run, self.owns_work, self.walk = {"format": M.FORMAT}, False, False, None
                self.peaks, self.samples = {}, []

            def prepare(self):
                raise M.Refused("run dir busy")
        a = types.SimpleNamespace(run_dir=run, expect_kind="fixture", fixture_unmount_exe=None, view_dir=None, tree_root_pid=os.getpid())
        for build in (Refusing, lambda: M.make_session_class(C)(a, R9, None, {})):   # a stub, then the REAL prepare refusal
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(M.drive(a, C, build, time.monotonic()), 3)
            self.assertEqual(snap(), before)                                 # nothing written, renamed or removed
            self.assertIsNone(json.loads(out.getvalue())["receiptFile"])

    def test_10_the_soft_stop_branch_of_use_stops_the_walker_first(self):
        C = M.load_exact("r6Runtime", "r6_composite_session")
        R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")
        run = tempfile.mkdtemp(prefix="soft")
        a = types.SimpleNamespace(run_dir=run, expect_kind="fixture", fixture_unmount_exe=None, view_dir=None, tree_root_pid=os.getpid())

        class Sleeper(M.make_session_class(C)):
            def walker_argv(self, walker, limit):                         # a stand-in walker: no mount, no mapping
                return ["/usr/bin/sleep", "300"]
        s = Sleeper(a, R9, None, {})
        os.mkdir(s.work, 0o700); s.owns_work = True
        with open("/proc/self/cgroup") as f:
            s.rel = f.read().strip()[3:]                                  # this test job's own cgroup (read only)
        s.t0, s.deadline = time.monotonic(), time.monotonic() + 600
        saved = M.SOFT_TREE_RSS_MIB
        try:
            M.SOFT_TREE_RSS_MIB = -1                                      # any tree RSS trips the soft stop at the first sample
            s.use()
        finally:                                                          # r4: the TEST owns cleanup even if use() raised or an
            M.SOFT_TREE_RSS_MIB = saved                                   # assertion fails: r6 cleanup ends and reaps the child and
            s.cleanup()                                                   # closes its log (no leaked process / fd / ResourceWarning)
        c = s.children["exec"]
        self.assertIsNotNone(c.returncode); self.assertTrue(s.walk["groupEmpty"]); self.assertIn("tree VmRSS", s.walk["softStop"])
        self.assertTrue(s.receipt["cleanupComplete"], s.receipt)
        self.assertEqual(M.outcome(s.receipt, s.walk, None, None)[0], "SOFT-STOP")
        # r4: real telemetry of the live stand-in (an exec'd /usr/bin/sleep has resident pages and page tables): the first sample is
        # a full one and must carry the kernel's VmRSS / VmPTE for the child, and the peaks must hold at least those values
        first = s.samples[0]["walker"]
        self.assertGreater(first.get("VmRSSKiB", 0), 0, first); self.assertGreater(first.get("VmPTEKiB", 0), 0, first)
        self.assertGreaterEqual(s.peaks["walkerVmRSSKiB"], first["VmRSSKiB"]); self.assertGreaterEqual(s.peaks["walkerVmPTEKiB"], first["VmPTEKiB"])
        self.assertGreater(s.peaks["cgCurrent"], 0)                      # this job's own cgroup was really read

    def test_11_remaining_counts_every_part_that_is_not_r3_validated_committed(self):
        R = M.load_runner()
        d = tempfile.mkdtemp(prefix="r3"); j = lambda *x: os.path.join(d, *x)
        BS, PART, L = 4096, 65536, 50 * 4096
        EXT = [[0, 10, 900, False], [12, 19, 950, False], [33, 8, 990, False]]
        det = lambda seed, n: b"".join(hashlib.sha256(f"{seed}-{i}".encode()).digest() for i in range(n // 32 + 1))[:n]
        with open(j("source.img"), "wb") as f:
            f.truncate(L)
            for lb, n, _pb, _u in EXT:
                f.seek(lb * BS); f.write(det(f"data{lb}", n * BS))
        with open(j("map.json"), "w") as f:
            json.dump({"format": "ext4-recovery-checksum-r1/v1", "map": {"extentList": EXT, "extents": len(EXT)}}, f)
        for n, b in (("journal.bin", det("journal", 65536)), ("original.qcow2", det("qcow2", 12345))):
            with open(j(n), "wb") as f:
                f.write(b)
        with open(j("plan.json"), "w") as f:
            json.dump({"format": "recovery-overlay-plan/v1", "mode": "fixture", "inputs": {"captureSha256": "00" * 32},
                       "target": {"size": L, "path": "/data/db/mdbx.dat"}, "map": {"extents": len(EXT)},
                       "patches": [{"kind": "inode", "fsBlock": 7, "byteOffset": 1024, "length": 256, "sha256": "ab" * 32, "source": "000.bin"}]}, f)
        for t in ("a", "b"):
            os.mkdir(j(t), 0o700)
        cli = lambda *x: subprocess.run([sys.executable, "-I", "-B", M.PINS["r3Core"][0], *x], capture_output=True, text=True, timeout=120,
                                        env={"PATH": "/usr/bin:/bin"})
        r = cli("plan", "--original", j("original.qcow2"), "--map", j("map.json"), "--overlay-plan", j("plan.json"), "--journal", j("journal.bin"),
                "--out", j("manifest.json"), "--target", f"a={j('a')}", "--target", f"b={j('b')}", "--assign", "a:0-1", "--assign", "b:2-3",
                "--logical-size", str(L), "--part-size", str(PART), "--chunk-bytes", "8192", "--checkpoint-bytes", "16384")
        self.assertEqual(r.returncode, 0, r.stderr)
        msha = json.loads(r.stdout)["manifestSha256"]
        m = ["--manifest", j("manifest.json"), "--manifest-sha256", msha, "--source-file", j("source.img")]
        for mode in ("copy", "verify"):                                   # parts 0..2 committed + verified; part 3 never copied
            r = cli(mode, *m, "--parts", "0-2"); self.assertEqual(r.returncode, 0, r.stderr)
        dm, _ = R.MP.load_manifest(j("manifest.json"), msha)
        self.assertEqual((M.root_remaining(R, dm, msha, "a"), M.root_remaining(R, dm, msha, "b")), (0, 8192))   # valid; only part 3
        os.unlink(j("a", "part-0000.bin"))                                 # a record whose file is MISSING
        os.utime(j("b", "part-0002.bin"), ns=(1, 1))                       # a record whose file is STALE (identity changed)
        self.assertEqual(M.root_remaining(R, dm, msha, "a"), PART)         # part 0 counts in full; part 1 (valid) does not
        self.assertEqual(M.root_remaining(R, dm, msha, "b"), PART + 8192)  # part 2 (stale) + part 3 (no record)


if __name__ == "__main__":
    unittest.main()
