#!/usr/bin/env python3
"""composite-memory-fixture-stage/r1 unit tests (prepared by Claude 1810; NOT run by Claude). 7 TINY tests: no FUSE, mount, qemu, scope
change or large memory. Scope parsing / lane / reservation / soft-stop decisions, the MemoryHigh setter's binding and verification against a
FAKE cgroup tree + FAKE systemctl (mismatch, failure, not applied, parent changed), the sparse allocation cap, the walker on tiny files,
an ORDERED cancellation of a real owned child through the qualified r6 Session cleanup, and the outcome classification.
Everything lives under $CMF_TEST_TMP (never TMPDIR/HOME)."""
import json, os, subprocess, sys, tempfile, unittest

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
        need = (100 << 30) + (40 << 30) + (8 << 30) + (64 << 20) + (16 << 20)
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
        s = M.make_session_class(C)(a, R9, None)
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


if __name__ == "__main__":
    unittest.main()
