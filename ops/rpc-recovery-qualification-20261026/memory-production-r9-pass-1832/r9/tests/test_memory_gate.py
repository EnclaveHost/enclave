#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r9 unit/negative tests (prepared by Claude 1825/1829; NOT run by Claude). 15 TINY tests (r8's 10
+ r9: 11 stop helper, 12 final-status shell, 13 live-session guard, 14 injected telemetry processing failure, 15 the real r6 main
soft-stop cancellation): no FUSE, mount,
qemu, MDBX, scope change or production view. The gate's ACTUAL pinned qualifications (r7 gate PASS, r6 4+12 through r7's own functions,
r4 tests/job/fixture receipts) and their mutations, the 4096 lane, the 3712 MiB setter on a FAKE cgroup, reservations, soft-stop and
OOM-aware classification decisions, the real r6 Session subclass (telemetry tick, ordered soft stop, nbdfuse post-use identity) with an
owned `sleep` stand-in, and the gate / runtime CLIs refusing outside their bound lane while writing nothing they must not.
Everything lives under $R8_TEST_TMP (never TMPDIR/HOME)."""
import contextlib, io, json, os, resource, signal, subprocess, sys, tempfile, time, types, unittest

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

    def session(self, wrap=None, ms=False):
        C = G.load_exact("r6Runtime", "r6_composite_session")
        M4 = G.load_exact("r4Fixture", "r4_memory_fixture")
        M4 = wrap(M4) if wrap else M4
        R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")
        with open("/proc/self/cgroup") as f:
            rel = f.read().strip()[3:]                                  # this test job's own cgroup (read only)
        MS = G.make_memory_session(C, M4, {"rel": rel, "root": os.getpid()}, {})
        if ms:
            return C, MS
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

    # ---- r9 (root 1828, review 1827) ------------------------------------------------------------------------------------------------
    def dummy(self, d, *extra):
        """an OWNED stand-in carrying exactly the runtime argv shape (its script only sleeps): no production code path is opened"""
        script = os.path.join(d, "memory_gate.py")
        if not os.path.exists(script):
            with open(script, "w") as f:
                f.write("import time\ntime.sleep(300)\n")
        session = os.path.join(d, "session"); os.makedirs(session, 0o700, exist_ok=True)
        argv = [G.PY3, "-I", "-B", script, "runtime", "--tree-root-pid", "1", "--", "--view-dir", "/x", "--run-dir", session,
                "--expect-kind", "production", "--validator-timeout", "60", *extra]
        return script, session, subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_11_stop_signals_only_the_exactly_identified_r9_runtime(self):
        d = tempfile.mkdtemp(prefix="stop")
        script, session, p = self.dummy(d)
        d2 = tempfile.mkdtemp(prefix="stopfx")
        _s2, session2, q = self.dummy(d2, "--fixture-exec", "/usr/bin/true")
        try:
            end = time.monotonic() + 10
            while G.proc_argv(p.pid)[:1] != [G.PY3] and time.monotonic() < end:
                time.sleep(0.05)
            start = G.proc_start(p.pid)

            def pidfile(sess, body):
                with open(os.path.join(sess, "session.pid"), "w") as f:
                    f.write(body if isinstance(body, str) else json.dumps(body))
            pidfile(session, {"pid": p.pid, "startTime": start})
            other = os.path.join(d, "other"); os.mkdir(other, 0o700); pidfile(other, {"pid": p.pid, "startTime": start})
            pidfile(session2, {"pid": q.pid, "startTime": G.proc_start(q.pid)})
            for label, call in (("not this r9 script", lambda: G.stop_session(session)),
                                ("another run dir", lambda: G.stop_session(other, script=script)),
                                ("a fixture runtime", lambda: G.stop_session(session2, script=os.path.join(d2, "memory_gate.py")))):
                with self.assertRaises(G.Refused, msg=label):
                    call()
            for body in ({"pid": p.pid, "startTime": start + 1}, "not json", {"pid": True, "startTime": start}):
                pidfile(session, body)
                with self.assertRaises(G.Refused, msg=str(body)):
                    G.stop_session(session, script=script)
            pidfile(session, {"pid": p.pid, "startTime": start})
            cli = subprocess.run([sys.executable, "-I", "-B", TOOL, "stop", session], capture_output=True, text=True, timeout=60,
                                 env={"PATH": "/usr/bin:/bin"})                # the production CLI: the real r9 path only
            self.assertEqual(cli.returncode, 3, cli.stdout + cli.stderr)
            self.assertIsNone(p.poll()); self.assertIsNone(q.poll())   # no refusal signalled anything
            self.assertEqual(G.stop_session(session, script=script)["signalled"], p.pid)
            self.assertEqual(p.wait(timeout=10), -signal.SIGTERM)       # SIGTERM through the pidfd; reaped here
            with self.assertRaises(G.Refused):
                G.stop_session(session, script=script)                    # gone: nothing to signal
        finally:
            for x in (p, q):
                if x.poll() is None:
                    x.kill()
                x.wait(timeout=10)

    def test_12_the_job_exit_never_hides_failed_final_evidence(self):
        good = {"format": "composite-production-memory-job-receipt/r9", "structurallyCleanRun": True, "rc": 0, "outcome": "CLEAN",
                "checks": {k: True for k in G.JOB_CHECKS}}

        def final(rc, jrc, body):
            J = tempfile.mkdtemp(prefix="fin"); path = os.path.join(J, "receipt.json")
            if body is not None:
                with open(path, "w") as f:
                    f.write(body if isinstance(body, str) else json.dumps(body))
            r = subprocess.run(["bash", os.path.join(STAGE, "jobs", "final-status.sh"), str(rc), str(jrc), path, J],
                               capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin"})
            return r.returncode, os.path.exists(os.path.join(J, "FINAL-EVIDENCE-FAILED"))
        cases = ((0, 0, good, (0, False)),
                 (0, 1, {**good, "structurallyCleanRun": False, "checks": {**good["checks"], "peersUnchanged": False}}, (10, True)),
                 (0, 0, None, (10, True)), (0, 0, '{"format": "composite-production', (10, True)),     # missing / truncated
                 (0, 1, good, (10, True)), (0, 0, {**good, "rc": 5}, (10, True)), (0, 0, {**good, "outcome": "PROBLEMS"}, (10, True)),
                 (7, 1, {**good, "rc": 7, "structurallyCleanRun": False}, (7, True)), (5, 0, None, (5, True)),   # runtime rc preserved
                 (2, 0, good, (2, True)), ("x", 0, good, (10, True)))
        for rc, jrc, body, want in cases:
            self.assertEqual(final(rc, jrc, body), want, (rc, jrc, body))

    def test_13_the_guard_sees_real_memory_gate_processes_not_text_mentions(self):
        SG = G.load_exact("r6SessionGuard", "r6_session_guard")
        real = [G.PY3, "-I", "-B", "/p/r9/memory_gate.py", "runtime", "--tree-root-pid", "1", "--", "--run-dir", "/s"]
        self.assertTrue(G.memory_session_argv(SG, real))
        self.assertTrue(G.memory_session_argv(SG, ["python3", "/p/r9/memory_gate.py", "gate", "--view-dir", "/v"]))
        for text in (["bash", "-c", "python3 /p/memory_gate.py runtime"], ["grep", "-r", "memory_gate.py runtime", "/x"],
                     [G.PY3, "-c", "print('memory_gate.py runtime')"], [G.PY3, "-I", "-B", "/p/memory_gate.py", "stop", "/s"],
                     [G.PY3, "/p/composite_session.py", "runtime"], ["vim", "/p/memory_gate.py"], [G.PY3, "/p/memory_gate.py"]):
            self.assertFalse(G.memory_session_argv(SG, text), text)
        guard = lambda: subprocess.run([sys.executable, "-I", "-B", TOOL, "guard"], capture_output=True, text=True, timeout=60,
                                       env={"PATH": "/usr/bin:/bin"})
        _s, _sess, p = self.dummy(tempfile.mkdtemp(prefix="guard"))
        t = subprocess.Popen([G.PY3, "-c", "import time; time.sleep(300)", "memory_gate.py", "runtime"],   # ONE process: text only
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(0.3)
            g = guard()
            self.assertEqual(g.returncode, 1, g.stdout + g.stderr); self.assertIn(f'"pid": {p.pid}', g.stdout)
            self.assertNotIn(f'"pid": {t.pid}', g.stdout)                # a text mention never refuses
            p.kill(); p.wait(timeout=10)
            g = guard()
            self.assertEqual(g.returncode, 0, g.stdout + g.stderr)
        finally:
            for x in (p, t):
                if x.poll() is None:
                    x.kill()
                x.wait(timeout=10)

    def test_14_an_injected_telemetry_processing_failure_is_counted_then_soft_stops_in_order(self):
        def wrap(M4):
            def bad(rel):
                x = M4.cg_sample(rel); x.pop("stat"); return x            # a PROCESSING failure (KeyError in the tick body)
            return types.SimpleNamespace(cg_sample=bad, tree_rss_mib=M4.tree_rss_mib, mem_available_mib=M4.mem_available_mib,
                                         tree=M4.tree, proc_status=M4.proc_status)
        C, s = self.session(wrap)
        c = s.spawn("exec", ["/usr/bin/sleep", "300"], cwd=s.work)
        try:
            s.step("validator")
            self.assertFalse(s.R9.exited_nowait(c.pid)); self.assertFalse(s.R9.exited_nowait(c.pid))   # counted, not raised
            self.assertEqual(len(s.mem["telemetryErrors"]), 2); self.assertTrue(s._phase)
            with self.assertRaises(s.SoftStop):
                s.R9.exited_nowait(c.pid)                               # the 3rd in a row: an ORDERED soft stop (never REFUSED)
            self.assertIn("telemetry failed 3", s.mem["softStop"]); self.assertFalse(s._phase)
            self.assertIn("KeyError", s.mem["telemetryErrors"][0]); self.assertLessEqual(len(s.mem["telemetryErrors"]), G.MAX_ERRORS)
            self.assertFalse(s.R9.exited_nowait(c.pid))                   # disarmed
        finally:
            s.cleanup()
        self.assertIsNotNone(c.returncode); self.assertTrue(s.receipt["cleanupComplete"], s.receipt)

    def test_15_the_real_r6_main_turns_a_forced_soft_stop_into_an_ordered_cancelled_receipt(self):
        """LIMITATION (stated): r6 prepare/expose are stubbed (no view, no FUSE, no qemu) and the validator is an owned `sleep`
        stand-in run through r6's own fixture-exec argv INSIDE this test only; the r9 runtime CLI still refuses any fixture kind"""
        C, MS = self.session(ms=True)

        class Stubbed(MS):
            def prepare(self, pins):
                with C.deferred():
                    fd = os.open(os.path.join(self.a.run_dir, "session.pid"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    self.owns_run = True
                os.write(fd, b"{}"); os.close(fd)
                self.view = {"logicalSize": 1}

            def expose(self):
                with C.deferred():
                    os.mkdir(self.work, 0o700); self.owns_work = True
                os.mkdir(self.db, 0o700)

            def held(self, label):
                return True if label == "heldBeforeExec" else super().held(label)
        C.Session = Stubbed                                             # this private r6 instance only
        run = tempfile.mkdtemp(prefix="main")
        saved, before = G.SOFT_TREE_RSS_MIB, signal.getsignal(signal.SIGTERM)
        try:
            G.SOFT_TREE_RSS_MIB = -1
            with contextlib.redirect_stdout(io.StringIO()):
                rc = C.main(["--view-dir", "/stub", "--run-dir", run, "--expect-kind", "fixture", "--exec-timeout", "60",
                             "--fixture-exec", "/usr/bin/sleep", "300"])
        finally:
            G.SOFT_TREE_RSS_MIB = saved
        self.assertIs(signal.getsignal(signal.SIGTERM), before)          # r6 main restored the handlers
        with open(os.path.join(run, "receipt.json")) as f:
            r = json.load(f)
        self.assertEqual((rc, r["outcome"], r["rc"], r["cleanupComplete"]), (5, "CANCELLED", 5, True), r)
        self.assertIn("soft stop", r["reasons"][0]); self.assertIn("tree VmRSS", r["memory"]["softStop"])
        pid = r["children"]["exec"]["pid"]
        self.assertIsNotNone(r["children"]["exec"]["returncode"]); self.assertEqual(r["childrenAlive"], [])
        self.assertFalse(os.path.exists(f"/proc/{pid}") and G.proc_argv(pid)[:1] == ["/usr/bin/sleep"])   # the stand-in is gone
        self.assertGreater(len(r["memory"]["samples"]), 0)


if __name__ == "__main__":
    unittest.main()
