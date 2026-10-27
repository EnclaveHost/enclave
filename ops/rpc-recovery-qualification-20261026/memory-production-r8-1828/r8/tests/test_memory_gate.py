#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r8 unit/negative tests (prepared by Claude 1825; NOT run by Claude). 10 TINY tests: no FUSE, mount,
qemu, MDBX, scope change or production view. The gate's ACTUAL pinned qualifications (r7 gate PASS, r6 4+12 through r7's own functions,
r4 tests/job/fixture receipts) and their mutations, the 4096 lane, the 3712 MiB setter on a FAKE cgroup, reservations, soft-stop and
OOM-aware classification decisions, the real r6 Session subclass (telemetry tick, ordered soft stop, nbdfuse post-use identity) with an
owned `sleep` stand-in, and the gate / runtime CLIs refusing outside their bound lane while writing nothing they must not.
Everything lives under $R8_TEST_TMP (never TMPDIR/HOME)."""
import json, os, resource, signal, subprocess, sys, tempfile, time, types, unittest

TMP = os.environ.get("R8_TEST_TMP", "")
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("R8_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP
STAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, STAGE)
import memory_gate as G  # noqa: E402

TOOL = os.path.join(STAGE, "memory_gate.py")
MIB = 1 << 20


def fsize(cap):
    return lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))


class Gate(unittest.TestCase):
    def test_1_the_actual_pinned_qualifications_pass_and_altered_ones_refuse(self):
        R7 = G.load_exact("r7Gate", "r7_production_gate")
        q = G.check_qualifications(R7)                                  # r7 stage + gate PASS, r6 stage + exact 4+12, r4 stage + receipts
        self.assertEqual(q["r4Receipts"]["r4Job"], G.PINS["r4Job"][1])
        job, run, t4, t7 = (G.pinned_json(k) for k in ("r4Job", "r4Run", "r4Tests", "r7GateTests"))
        bad = [(G.check_r4_job, {**job, "outcome": "SOFT-STOP"}), (G.check_r4_job, {**job, "controllerKilled": True}),
               (G.check_r4_job, {**job, "walker": {**job["walker"], "result": {**job["walker"]["result"], "scannedBytes": 4096}}}),
               (G.check_r4_run, {**run, "cgAfter": {**run["cgAfter"], "events": {**run["cgAfter"]["events"], "oom_kill": 1}}}),
               (G.check_r4_run, {**run, "cgAfter": {**run["cgAfter"], "events": dict(run["cgBefore"]["events"])}}),   # no high event
               (G.check_r4_tests, {**t4, "ran": ["10"]}), (G.check_r7_gate_tests, {**t7, "pass": False})]
        for fn, rec in bad:
            with self.assertRaises(G.Refused, msg=fn.__name__):
                fn(rec)
        p = os.path.join(tempfile.mkdtemp(prefix="pin"), "receipt.json")
        with open(G.PINS["r4Job"][0], "rb") as f, open(p, "wb") as g:
            g.write(f.read().replace(b'"MEASURED"', b'"MEASURED" '))     # one byte differs: never the exact pinned receipt
        saved = G.PINS["r4Job"]
        try:
            G.PINS["r4Job"] = (p, saved[1])
            with self.assertRaises(G.Refused):
                G.pinned_json("r4Job")
        finally:
            G.PINS["r4Job"] = saved

    def test_2_only_the_4096_lane_above_the_floor_with_no_prior_high(self):
        self.assertEqual(G.lane_ok(f"{4096 * MIB}\n", "max\n", 20736)["memoryMaxMiB"], 4096)
        for mx, hi, av in ((str(2560 * MIB), "max", 30000), ("max", "max", 30000), (str(768 * MIB), "max", 30000),
                           (str(4096 * MIB), str(3712 * MIB), 30000), (str(4096 * MIB), "max", 20735)):
            with self.assertRaises(G.Refused, msg=(mx, hi, av)):
                G.lane_ok(mx, hi, av)

    def test_3_memoryhigh_3712_is_set_on_the_bound_scope_only(self):
        M4 = G.load_exact("r4Fixture", "r4_memory_fixture")
        M4.LANE_MIB, M4.HIGH_MIB = G.LANE_MIB, G.HIGH_MIB
        uid = os.getuid()
        rel = f"/user.slice/user-{uid}.slice/user@{uid}.service/app.slice/run-p1-i2.scope"

        def tree():
            cg = tempfile.mkdtemp(prefix="cg"); own = os.path.join(cg, rel.lstrip("/")); os.makedirs(own)
            for path, body in ((own + "/memory.high", "max"), (own + "/memory.max", str(4096 * MIB)), (os.path.dirname(own) + "/memory.high", "max")):
                with open(path, "w") as f:
                    f.write(body + "\n")
            return cg, own

        def runner(own, group, calls):
            def run(args):
                calls.append(args[0])
                if args[0] == "show" and args[2] == "ControlGroup":
                    return 0, group
                if args[0] == "set-property":
                    self.assertEqual(args[-1], "MemoryHigh=3712M")
                    with open(own + "/memory.high", "w") as f:
                        f.write(f"{3712 * MIB}\n")
                    return 0, ""
                with open(own + "/memory.high") as f:
                    return 0, f.read()
            return run
        cg, own = tree(); calls = []
        r = M4.set_memory_high(rel, "run-p1-i2.scope", runner(own, rel, calls), cg=cg)
        self.assertEqual((r["after"]["ownHigh"], r["after"]["ownMax"], r["after"]["parentHigh"]), (str(3712 * MIB), str(4096 * MIB), "max"))
        cg, own = tree(); calls = []
        with self.assertRaises(M4.Refused):
            M4.set_memory_high(rel, "run-p1-i2.scope", runner(own, rel.replace("run-p1", "run-p9"), calls), cg=cg)
        self.assertNotIn("set-property", calls)                          # a scope mismatch changes nothing

    def test_4_reservations_keep_recovery_floors_native_and_the_output_budget(self):
        self.assertEqual(G.OUTPUT_BUDGET, 208 * MIB)
        need_root = (4 << 30) + (40 << 30) + (8 << 30) + G.OUTPUT_BUDGET
        r = G.reserve(need_root, 4 << 30, 40 << 30, 41 << 30, 1 << 30, 40 << 30)
        self.assertEqual((r["root"]["margin"], r["vm"]["margin"]), (0, 0))
        for args in ((need_root - 1, 4 << 30, 40 << 30, 41 << 30, 1 << 30, 40 << 30), (need_root, 4 << 30, 40 << 30, (41 << 30) - 1, 1 << 30, 40 << 30)):
            with self.assertRaises(G.Refused):
                G.reserve(*args)

    def test_5_soft_stop_thresholds(self):
        self.assertIsNone(G.soft_reason(3840, 16896))
        self.assertIn("tree VmRSS", G.soft_reason(3841, 30000)); self.assertIn("MemAvailable", G.soft_reason(100, 16895))

    def test_6_an_oom_event_never_lets_clean_or_problems_through(self):
        ev = {"high": 5, "max": 0, "oom": 0, "oom_kill": 0, "oom_group_kill": 0}
        self.assertFalse(G.dirty(ev, {**ev, "high": 99, "max": 3})); self.assertTrue(G.dirty(ev, {**ev, "oom_kill": 1}))
        self.assertTrue(G.dirty(None, ev)); self.assertTrue(G.dirty(ev, {"high": 1}))
        for name, after, want in (("CLEAN", ev, "CLEAN"), ("CLEAN", {**ev, "oom_kill": 1}, "INCONCLUSIVE"),
                                  ("PROBLEMS", {**ev, "oom": 1}, "INCONCLUSIVE"), ("CLEAN", None, "INCONCLUSIVE"),
                                  ("VOID", {**ev, "oom": 1}, "VOID"), ("INCONCLUSIVE", ev, "INCONCLUSIVE")):
            def cg_sample(rel, after=after):
                if after is None:
                    raise OSError("unreadable")
                return {"events": after}
            s = types.SimpleNamespace(mem={"eventsBefore": ev})
            cls = G.memory_classify(lambda *a: (name, {"CLEAN": 0, "PROBLEMS": 2, "VOID": 8}.get(name, 7), []),
                                    types.SimpleNamespace(cg_sample=cg_sample), "/x", {"s": s})
            self.assertEqual(cls({}, {}, True, False, 1)[0], want, (name, after))

    def session(self):
        C = G.load_exact("r6Runtime", "r6_composite_session")
        M4 = G.load_exact("r4Fixture", "r4_memory_fixture")
        R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")
        with open("/proc/self/cgroup") as f:
            rel = f.read().strip()[3:]                                  # this test job's own cgroup (read only)
        MS = G.make_memory_session(C, M4, {"rel": rel, "root": os.getpid()}, {})
        a = types.SimpleNamespace(run_dir=tempfile.mkdtemp(prefix="run"), expect_kind="production", fixture_unmount_exe=None, view_dir=None)
        s = MS(a, R9, None)
        os.mkdir(s.work, 0o700); s.owns_work = True
        return C, s

    def test_7_the_validator_tick_records_bounded_telemetry_and_an_ordered_soft_stop_cancels_own_session(self):
        C, s = self.session()
        self.assertIsInstance(s.mem["eventsBefore"], dict)
        c = s.spawn("exec", ["/usr/bin/sleep", "300"], cwd=s.work)        # the stand-in validator: our own group child
        saved = G.SOFT_TREE_RSS_MIB
        try:
            self.assertFalse(s.R9.exited_nowait(c.pid))                  # before the "validator" step: passthrough, no sample
            self.assertEqual(s.mem["samples"], [])
            s.step("validator")
            self.assertFalse(s.R9.exited_nowait(c.pid))                  # first tick: a full sample with this child's real meters
            smp = s.mem["samples"][0]
            self.assertTrue(any(k.startswith("sleep:") and v.get("VmRSSKiB", 0) > 0 and v.get("VmPTEKiB", 0) > 0 for k, v in smp["procs"].items()), smp)
            self.assertGreater(s.mem["peaks"]["cgCurrent"], 0); self.assertGreater(s.mem["peaks"]["treeVmRssMiB"], 0)
            G.SOFT_TREE_RSS_MIB = -1
            with self.assertRaises(C.Stop) as cm:                         # r6 main records it as interrupted -> CANCELLED, never CLEAN
                s.R9.exited_nowait(c.pid)
            self.assertIsInstance(cm.exception, s.SoftStop); self.assertIn("tree VmRSS", s.mem["softStop"])
            self.assertFalse(s.R9.exited_nowait(c.pid))                  # disarmed: a cleanup-time call never raises again
        finally:
            G.SOFT_TREE_RSS_MIB = saved
            s.cleanup()                                                  # the TEST owns cleanup: r6 ends + reaps the child, closes logs
        self.assertIsNotNone(c.returncode); self.assertTrue(s.receipt["cleanupComplete"], s.receipt)

    def test_8_post_use_also_requires_the_same_bound_nbdfuse(self):
        C, s = self.session()
        self.assertFalse(s.nbdfuse_same())                               # never spawned: not the bound server
        c = s.spawn("nbdfuse", ["/usr/bin/sleep", "300"], cwd=s.work)     # a stand-in "server", bound like r6 binds it
        try:
            s.bind["nbdfuse"] = {"pidfd": os.pidfd_open(c.pid), "startTime": C.start_time(c.pid)}
            self.assertTrue(s.nbdfuse_same())
            os.kill(c.pid, signal.SIGKILL)
            end = time.monotonic() + 10
            while not s._r9.exited_nowait(c.pid) and time.monotonic() < end:
                time.sleep(0.05)
            self.assertFalse(s.nbdfuse_same())                           # a dead (or replaced) FUSE server voids the result
        finally:
            s.cleanup()
        self.assertIsNotNone(c.returncode); self.assertEqual(s.receipt["childrenAlive"], [])

    def test_9_the_gate_refuses_outside_its_bounds_writes_only_its_refusal_and_never_sets_memoryhigh(self):
        gate = lambda run, cap: subprocess.run([sys.executable, "-I", "-B", TOOL, "gate", "--view-dir", "/nonexistent", "--run-dir", run,
                                                "--max-hours", "1", "--tree-root-pid", str(os.getpid())], capture_output=True, text=True,
                                               timeout=300, preexec_fn=fsize(cap), env={"PATH": "/usr/bin:/bin"})
        for cap, want in ((64 * MIB, "RLIMIT_FSIZE"), (32 * MIB, "memory.max")):   # unbounded files; then this 512 test lane
            run = tempfile.mkdtemp(prefix="gate")
            p = gate(run, cap)
            self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
            self.assertEqual(os.listdir(run), ["gate-refused.json"])
            with open(os.path.join(run, "gate-refused.json")) as f:
                g = json.load(f)
            self.assertIn(want, g["refused"]); self.assertNotIn("scope", g); self.assertNotIn("session", g)
        run = tempfile.mkdtemp(prefix="used")
        with open(os.path.join(run, "receipt.json"), "w") as f:
            f.write("LIVE")
        p = gate(run, 32 * MIB)
        self.assertEqual(p.returncode, 3); self.assertEqual(os.listdir(run), ["receipt.json"])   # never writes into a used run dir

    def test_10_the_runtime_refuses_before_r6_outside_the_bound_scope_or_kind(self):
        def rt(*rest, pre=True):
            run = tempfile.mkdtemp(prefix="rt")
            argv = [sys.executable, "-I", "-B", TOOL, "runtime", "--tree-root-pid", str(os.getpid())]
            argv += (["--"] if pre else []) + ["--view-dir", "/nonexistent", "--run-dir", run, *rest]
            p = subprocess.run(argv, capture_output=True, text=True, timeout=120, preexec_fn=fsize(32 * MIB), env={"PATH": "/usr/bin:/bin"})
            return p, run
        for rest, pre in ((("--expect-kind", "production", "--validator-timeout", "60"), True),   # 512 test lane, no 3712 high
                          (("--expect-kind", "fixture"), True), (("--expect-kind", "production", "--fixture-exec", "/usr/bin/true"), True),
                          (("--expect-kind", "production"), False)):
            p, run = rt(*rest, pre=pre)
            self.assertEqual(p.returncode, 3, p.stdout + p.stderr); self.assertIn("REFUSED", p.stderr)
            self.assertEqual(os.listdir(run), [])                         # nothing claimed, nothing written


if __name__ == "__main__":
    unittest.main()
