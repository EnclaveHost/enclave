#!/usr/bin/env python3
"""state-production-validation-stage/r1 tests/test_state.py (PREPARED by Claude 1890; NOT run by Claude). 14 tests. NO mount, view,
namespace, queue, network, cgroup change, build, helper run, production data, part or backup: they read this stage's sources, the
FROZEN pinned sources/receipts (r6, r10, acceptance r3, r12) and write ONLY under a private tempfile dir. Every report/receipt here is
SYNTHETIC (parser/lifecycle-logic tests); nothing qualifies a production run."""
import ast, contextlib, copy, hashlib, importlib.util, io, json, os, pathlib, stat, sys, tempfile, types, unittest

STAGE = pathlib.Path(__file__).resolve().parent.parent
W = STAGE.parent.parent


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


SG = load(STAGE / "state_gate.py", "state_gate_under_test")
A = SG.load_exact("acceptance", "acceptance_r3_pinned")
AT = load(W / "state-helper-qualification-stage/r3/tests/test_acceptance.py", "acceptance_r3_tests")   # SYNTHETIC GOLDEN etc.
MG = SG.load_exact("memoryGate", "memory_gate_r10_pinned")
R6 = W / "composite-mdbx-validation-stage/r6/composite_session.py"
EV0 = {"low": 0, "high": 0, "max": 0, "oom": 0, "oom_kill": 0, "oom_group_kill": 0}
VIEW = {"dir": "/home/u/view", "kind": "production", "manifestSha256": "7" * 64, "descriptorSha256": "8" * 64, "logicalSize": 1 << 40,
        "parts": 265, "receiptSha256": "9" * 64}


def append(path, b=b"x"):
    with open(path, "ab") as f:
        f.write(b)


def ns(**kw):
    d = dict(run_dir=None, fixture_exec=None, fixture_unmount_exe=None, expect_kind="production", validator_timeout=100, exec_timeout=5)
    d.update(kw); return types.SimpleNamespace(**d)


class Tmp(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(); self.t = self._td.name
        self.rd = os.path.join(self.t, "session"); os.makedirs(self.rd + "/work/db")
        self.hd = os.path.join(self.t, "out"); os.mkdir(self.hd)
        self.helper = os.path.join(self.hd, "base-state-readonly")
        with open(self.helper, "wb") as f:
            f.write(b"\x7fELF synthetic helper")
        self.sf = os.path.join(self.t, "static_files"); os.mkdir(self.sf)
        files = []
        for n, b in (("static_file_headers_53000000_53499999", b"h" * 100), ("static_file_headers_53000000_53499999.off", b"o" * 9)):
            with open(os.path.join(self.sf, n), "wb") as f:
                f.write(b)
            files.append({"name": n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()})
        self.inp = {"helperDir": self.hd, "helperSha256": hashlib.sha256(b"\x7fELF synthetic helper").hexdigest(),
                    "buildReceipt": ["/vm/b/receipt.json", "c" * 64], "positiveCapture": ["/vm/p.json", "d" * 64],
                    "fixturesCapture": ["/vm/f.json", "e" * 64], "extraction": ["/vm/x.json", "f" * 64], "staticFilesDir": self.sf,
                    "staticFiles": files, "structural": {"job": ["/r/j.json", "1" * 64], "session": ["/r/s.json", "2" * 64]},
                    "view": dict(VIEW)}

    def tearDown(self):
        self._td.cleanup()


class Seam(unittest.TestCase):
    def test_01_session_copy_is_r6_except_the_seam(self):
        mine, r6 = ast.parse((STAGE / "composite_session.py").read_text()), ast.parse(R6.read_text())

        def body(tree):
            out = {}
            for n in tree.body:
                if isinstance(n, ast.ClassDef):
                    for m in n.body:
                        out[f"{n.name}.{getattr(m, 'name', ast.dump(m)[:40])}"] = ast.dump(m)
                    out[n.name + "#bases"] = ast.dump(ast.Module(body=[], type_ignores=[])) + str([ast.dump(b) for b in n.bases])
                elif isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "OUTPUT_NAMES" for t in n.targets):
                    out["OUTPUT_NAMES"] = [c.value for c in n.value.elts]
                else:
                    out[getattr(n, "name", ast.dump(n)[:120])] = ast.dump(n)
            return out
        a, b = body(mine), body(r6)
        self.assertEqual(a.pop("OUTPUT_NAMES"), b.pop("OUTPUT_NAMES") + ["state-report.json"])
        self.assertIn("Session.exec_plan", a); a.pop("Session.exec_plan")
        self.assertNotEqual(a.pop("Session.use"), b.pop("Session.use"))
        self.assertEqual(a, b)                                          # every other node is r6's, exactly

    def test_02_default_exec_plan_is_r6_and_use_takes_both_from_it(self):
        C = load(STAGE / "composite_session.py", "seam_copy")
        fake = types.SimpleNamespace(a=ns(run_dir="/r/s"), db="/r/s/work/db")
        argv, limit, report = C.Session.exec_plan(fake)
        self.assertEqual(argv, [C.PY3, "-I", "-B", C.PINS["mdbxCheckPy"][0], "--chk", C.PINS["mdbxChk"][0], "--chk-sha256",
                                C.PINS["mdbxChk"][1], "--db-dir", "/r/s/work/db", "--timeout", "100", "--out", "/r/s/mdbx-report.json"])
        self.assertEqual((limit, report), (100 + C.VALIDATOR_GRACE, "/r/s/mdbx-report.json"))
        fake.a.fixture_exec = ["/bin/true"]
        self.assertEqual(C.Session.exec_plan(fake), (["/bin/true"], 5, "/r/s/mdbx-report.json"))
        use = next(m for n in ast.parse((STAGE / "composite_session.py").read_text()).body if isinstance(n, ast.ClassDef)
                   for m in n.body if getattr(m, "name", "") == "use")
        src = ast.unparse(use)
        self.assertIn("argv, limit, report = self.exec_plan()", src); self.assertNotIn("mdbx-report.json", src)
        self.assertIn("self.report_raw = raw", src); self.assertNotIn("fixture_exec", src)


class FailClosed(unittest.TestCase):
    def test_03_gate_and_runtime_refuse_first_while_inputs_unpinned(self):
        self.assertIsNone(SG.PRODUCTION_INPUTS)
        with tempfile.TemporaryDirectory() as t:
            rd = os.path.realpath(os.path.join(t, "o")); os.mkdir(rd, 0o700)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = SG.gate(["--view-dir", "/nonexistent/view", "--run-dir", rd, "--max-hours", "1", "--tree-root-pid", "1"])
            self.assertEqual(rc, 3)
            self.assertEqual(os.listdir(rd), ["gate-refused.json"])     # no session dir, nothing else
            g = json.loads(pathlib.Path(rd, "gate-refused.json").read_text())
            self.assertIn("PRODUCTION_INPUTS not pinned", g["refused"]); self.assertNotIn("scope", g)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for argv in (["--tree-root-pid", "1", "--", "--view-dir", "v", "--run-dir", "r", "--expect-kind", "production"],
                         ["--tree-root-pid", "1", "--", "--expect-kind", "production", "--fixture-exec", "/bin/true"],
                         ["--tree-root-pid", "1", "--", "--expect-kind", "fixture"], ["--tree-root-pid", "1"]):
                self.assertEqual(SG.runtime(argv), 3, argv)

    def test_04_blocked_prerequisites_always_refuse(self):
        src = ast.unparse(next(n for n in ast.parse((STAGE / "state_gate.py").read_text()).body
                               if getattr(n, "name", "") == "verify_production_inputs"))
        self.assertTrue(src.rstrip().endswith("refuse(f'BLOCKED {k}: {BLOCKED[k]}')"), src[-200:])
        self.assertEqual(set(SG.BLOCKED), {"captureReceipts", "extractionReceipt"})
        m = load(STAGE / "state_gate.py", "sg_blocked")                 # a private instance: stub only the impure reads
        good = {"helperDir": "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261027T000000Z-1/out", "helperSha256": "a" * 64,
                "buildReceipt": ["/vm/b.json", "c" * 64], "positiveCapture": ["/vm/p.json", "d" * 64], "fixturesCapture": ["/vm/f.json", "e" * 64],
                "extraction": ["/vm/x.json", "f" * 64], "staticFilesDir": "/vm/sf", "staticFiles": [{"name": "h", "size": 1, "sha256": "b" * 64}],
                "structural": {"job": ["/r/j.json", "1" * 64], "session": ["/r/s.json", "2" * 64]}, "view": dict(VIEW)}
        rec = json.dumps({"stageSums": m.PINS["r12Sums"][1], "guard": {"outDir": good["helperDir"], "binaries": {"base-state-readonly": {"sha256": "a" * 64}}}}).encode()
        m.read_all = lambda p, cap: rec; m.sha = lambda b: "c" * 64; m.sha_file = lambda p, cap: ("a" * 64, None)
        m.verify_structural = lambda MG, st, v: None
        with self.assertRaises(m.Refused) as cm:
            m.verify_production_inputs(good, A, types.SimpleNamespace(verify_binaries=lambda d: True), None)
        self.assertIn("BLOCKED captureReceipts", str(cm.exception))


class ExecPlan(Tmp):
    def test_05_exact_argv_and_report_path_from_the_pins(self):
        argv, report, prov = SG.state_exec_plan(ns(run_dir=self.rd), self.rd + "/work/db", self.inp, A)
        self.assertEqual(argv, A.expected_argv(SG.acceptance_pins(self.inp, self.rd)))
        self.assertEqual(argv, [self.helper, "--db", self.rd + "/work/db", "--static-files", self.sf, "--rocksdb", self.rd + "/rocksdb-absent",
                                "--out", self.rd + "/state-report.json", "--plain-hashed"])
        self.assertEqual(report, self.rd + "/state-report.json")
        self.assertEqual(set(prov) | {"helperSha256After", "staticFilesAfter", "rocksdbAbsentAfter"}, set(A.PROV_KEYS))
        self.assertEqual([f["name"] for f in prov["staticFilesBefore"]], [f["name"] for f in self.inp["staticFiles"]])

    def test_06_exec_plan_refusals(self):
        cases = [(ns(run_dir=self.rd, fixture_exec=["/bin/true"]), None), (ns(run_dir=self.rd, expect_kind="fixture"), None),
                 (ns(run_dir=self.rd, fixture_unmount_exe="/bin/true"), None), (ns(run_dir=self.rd), "db")]
        for a, what in cases:
            with self.assertRaises(SG.Refused):
                SG.state_exec_plan(a, self.rd + ("/other" if what == "db" else "/work/db"), self.inp, A)
        for mut in (lambda: open(self.rd + "/state-report.json", "w").close(), lambda: os.mkdir(self.rd + "/rocksdb-absent"),
                    lambda: append(self.helper), lambda: open(os.path.join(self.sf, "extra"), "w").close(),
                    lambda: append(os.path.join(self.sf, self.inp["staticFiles"][0]["name"]))):
            self.tearDown(); self.setUp(); mut()
            with self.assertRaises(SG.Refused):
                SG.state_exec_plan(ns(run_dir=self.rd), self.rd + "/work/db", self.inp, A)

    def test_07_provenance_after(self):
        _argv, _r, prov = SG.state_exec_plan(ns(run_dir=self.rd), self.rd + "/work/db", self.inp, A)
        p = SG.provenance_after(prov, self.helper, self.rd, self.inp, A)
        self.assertTrue(SG.provenance_ok(p, A)); self.assertEqual(set(p), set(A.PROV_KEYS))
        for mut in (lambda: os.mkdir(self.rd + "/rocksdb-absent"), lambda: append(self.helper),
                    lambda: os.utime(os.path.join(self.sf, self.inp["staticFiles"][1]["name"]), ns=(1, 1)),   # identity (mtime) only
                    lambda: os.unlink(os.path.join(self.sf, self.inp["staticFiles"][1]["name"]))):
            self.tearDown(); self.setUp()
            _argv, _r, prov = SG.state_exec_plan(ns(run_dir=self.rd), self.rd + "/work/db", self.inp, A)
            mut()
            self.assertFalse(SG.provenance_ok(SG.provenance_after(prov, self.helper, self.rd, self.inp, A), A))


class Classify(unittest.TestCase):
    def run_c(self, rc, raw, post_ok=True, sample=lambda: dict(EV0), mem=None, exec_extra=None, fixture=False):
        s = types.SimpleNamespace(mem=dict(mem or {"eventsBefore": dict(EV0), "softStop": None}), receipt={}, report_raw=raw)
        c = SG.make_state_classify(A, MG.dirty, sample, {"s": s})
        e = {"rc": rc, "timedOut": False, "limitSeconds": 9, "groupLeftovers": [], "escapedKilled": 0, "groupEmpty": True,
             "orphansGone": True, **(exec_extra or {})}
        return c(e, None, post_ok, fixture, 1)[1], s

    def test_08_only_the_specified_codes(self):
        g, f4 = AT.raw(AT.GOLDEN), AT.raw(AT.failing4())
        self.assertEqual(self.run_c(3, None)[0], 30); self.assertEqual(self.run_c(3, g)[0], 7)
        self.assertEqual(self.run_c(4, f4)[0], 34); self.assertEqual(self.run_c(4, None)[0], 7); self.assertEqual(self.run_c(4, b"{")[0], 7)
        code, s = self.run_c(5, g)
        self.assertEqual(code, 35); self.assertIs(s.receipt["stateClassification"]["canonical"], False)
        self.assertEqual(s.mem["memoryDirty"], False); self.assertEqual(s.mem["eventsAfter"], EV0)
        for rc in (0, 1, 2, 6, 101, 124, 137, None):
            self.assertEqual(self.run_c(rc, g)[0], 7, rc)
        self.assertEqual(self.run_c(5, g, post_ok=False)[0], 8); self.assertEqual(self.run_c(5, g, post_ok=None)[0], 8)
        self.assertEqual(self.run_c(5, g, exec_extra={"timedOut": True})[0], 7)
        self.assertEqual(self.run_c(5, g, exec_extra={"groupLeftovers": [123]})[0], 7)
        self.assertEqual(self.run_c(5, g, fixture=True)[0], 7)

    def test_09_oom_softstop_and_unreadable_counters_downgrade_34_35(self):
        g, f4 = AT.raw(AT.GOLDEN), AT.raw(AT.failing4())
        def boom():
            raise OSError("memory.events unreadable")
        for kw in (dict(sample=lambda: dict(EV0, oom_kill=1)), dict(sample=boom), dict(mem={"eventsBefore": None, "softStop": None}),
                   dict(mem={"eventsBefore": dict(EV0), "softStop": "tree VmRSS 3900 MiB"}), dict(mem={"eventsBefore": dict(EV0)})):
            self.assertEqual(self.run_c(5, g, **kw)[0], 7, kw); self.assertEqual(self.run_c(4, f4, **kw)[0], 7, kw)
        self.assertEqual(self.run_c(3, None, sample=boom)[0], 30)       # a refusal stays 30 (never usable anyway)


class Final(Tmp):
    def bundle(self):
        _argv, _r, prov = SG.state_exec_plan(ns(run_dir=self.rd), self.rd + "/work/db", self.inp, A)
        prov = SG.provenance_after(prov, self.helper, self.rd, self.inp, A)
        self.inp = dict(self.inp, helperDir="/vm/enclave-volumes/rpc-recovery-validation-build/run-20261027T000000Z-1/out")
        raw = AT.raw(AT.GOLDEN)
        with open(self.rd + "/state-report.json", "wb") as f:
            f.write(raw)
        rec = {"outcome": "STATE-PARTIAL-V2", "rc": 35, "cleanupComplete": True, "interrupted": None, "view": dict(VIEW),
               "reportPath": self.rd + "/state-report.json", "reportSha256": hashlib.sha256(raw).hexdigest(),
               "exec": {"rc": 5, "timedOut": False, "limitSeconds": 9, "groupLeftovers": [], "escapedKilled": 0, "groupEmpty": True,
                        "orphansGone": True},
               "children": {"exec": {"pid": 9, "argv": A.expected_argv(SG.acceptance_pins(self.inp, self.rd))}},
               "checks": {"postUseRecheck": {"ok": True}, "stateProvenance": {"ok": True}}, "stateProvenance": prov,
               "memory": {"memoryDirty": False, "softStop": None, "eventsBefore": dict(EV0), "eventsAfter": dict(EV0), "peaks": {}}}
        snap = {"snapshotsOk": True, "peersUnchanged": True, "noMountLeft": True, "noProcessLeft": True}
        return rec, snap

    def fin(self, rec, snap, rc=35, inp="default", path=None):
        rep, raw = SG.report_info(path or self.rd + "/state-report.json")
        inp = self.inp if inp == "default" else inp
        return SG.final_code(rc, A, rec, snap, rep, raw, inp, self.rd)["final"]

    def test_10_final_35_only_with_complete_bound_evidence(self):
        rec, snap = self.bundle()
        self.assertEqual(self.fin(rec, snap), 35)
        muts = [lambda r, s: r.__setitem__("interrupted", "signal 15"), lambda r, s: r.pop("interrupted"),
                lambda r, s: r["memory"].__setitem__("softStop", "MemAvailable"), lambda r, s: r["memory"].__setitem__("eventsAfter", dict(EV0, oom=1)),
                lambda r, s: r["children"]["exec"]["argv"].append("--repair"), lambda r, s: r["view"].__setitem__("parts", 264),
                lambda r, s: r.__setitem__("cleanupComplete", False), lambda r, s: s.__setitem__("peersUnchanged", False),
                lambda r, s: s.__setitem__("noMountLeft", False), lambda r, s: r["stateProvenance"].__setitem__("rocksdbAbsentAfter", False),
                lambda r, s: r["checks"]["stateProvenance"].__setitem__("ok", False), lambda r, s: r["exec"].__setitem__("orphansGone", False),
                lambda r, s: r["exec"].__setitem__("rc", 4), lambda r, s: r.pop("view")]
        for i, m in enumerate(muts):
            r, s = copy.deepcopy(rec), dict(snap); m(r, s)
            self.assertEqual(self.fin(r, s), 10, i)
        self.assertEqual(self.fin(None, snap), 10)
        self.assertEqual(self.fin(rec, snap, inp=None), 10)

    def test_11_runtime_codes_and_report_binding(self):
        rec, snap = self.bundle()
        self.assertEqual(self.fin(rec, snap, rc=0), 10)                 # runtime 0 is NEVER success
        r3 = copy.deepcopy(rec); r3["memory"].pop("softStop")
        self.assertEqual(self.fin(r3, snap), 10)                        # a missing native field is malformed, not "no soft stop"
        for rc in (3, 4, 5, 7, 8, 30, 34, 124, 137):
            self.assertEqual(self.fin(rec, snap, rc=rc), rc)
        for rc in (None, 256, -1):
            self.assertEqual(self.fin(rec, snap, rc=rc), 10)
        with open(self.rd + "/state-report.json", "ab") as f:
            f.write(b" ")                                               # still valid JSON, but NOT the bytes the runtime classified
        self.assertEqual(self.fin(rec, snap), 10)
        r2 = dict(rec, reportPath=self.rd + "/other.json")
        self.assertEqual(self.fin(r2, snap), 10)
        os.unlink(self.rd + "/state-report.json"); os.symlink(self.t + "/elsewhere.json", self.rd + "/state-report.json")
        self.assertEqual(self.fin(rec, snap), 10)                       # a symlink is recorded, never followed
        os.unlink(self.rd + "/state-report.json")
        self.assertEqual(self.fin(rec, snap), 10)


class Wiring(unittest.TestCase):
    def test_12_input_shape(self):
        good = {"helperDir": "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261027T000000Z-1/out", "helperSha256": "a" * 64,
                "buildReceipt": ["/vm/b.json", "c" * 64], "positiveCapture": ["/vm/p.json", "d" * 64], "fixturesCapture": ["/vm/f.json", "e" * 64],
                "extraction": ["/vm/x.json", "f" * 64], "staticFilesDir": "/vm/sf", "staticFiles": [{"name": "h", "size": 1, "sha256": "b" * 64}],
                "structural": {"job": ["/r/j.json", "1" * 64], "session": ["/r/s.json", "2" * 64]}, "view": dict(VIEW)}
        self.assertEqual(SG.input_shape_errors(good, A), [])
        for k, v in (("helperDir", "/tmp/out"), ("helperSha256", "A" * 64), ("buildReceipt", ["rel", "c" * 64]), ("staticFiles", []),
                     ("structural", {"job": ["/r/j.json", "1" * 64]}), ("view", dict(VIEW, kind="fixture")), ("view", dict(VIEW, parts=264)),
                     ("staticFilesDir", "/vm/../sf")):
            self.assertTrue(SG.input_shape_errors(dict(good, **{k: v}), A), k)
        self.assertTrue(SG.input_shape_errors(None, A)); self.assertTrue(SG.input_shape_errors(dict(good, extra=1), A))

    def test_13_stop_guard_and_job_wiring(self):
        argv2 = [SG.PY3, "-I", "-B", SG.THIS, "runtime", "--tree-root-pid", "7", "--", "--view-dir", "/v", "--run-dir", "/o/session",
                 "--expect-kind", "production", "--validator-timeout", "3600"]
        self.assertTrue(MG.runtime_identity(argv2, "/o/session", SG.THIS))
        with self.assertRaises(MG.Refused):
            MG.runtime_identity(argv2 + ["--fixture-exec", "/bin/true"], "/o/session", SG.THIS)
        SGd = MG.load_exact("r6SessionGuard", "r6_session_guard_t")
        self.assertEqual(SGd.script_of(argv2), SG.THIS)
        job = (STAGE / "jobs/root-state-validate.sh").read_text()
        for must in ("ulimit -f 32768; exec timeout -s TERM -k 600 $LIMIT python3 -I -B $S/state_gate.py gate", "collect-evidence.sh before",
                     "collect-evidence.sh after", "state_gate.py final \"$O\" \"$J\" \"$rc\" \"$arc\"", "exit $final", "guards",
                     "state_gate.py guard", 'EVID_S6="$S"'):
            self.assertIn(must, job)
        self.assertNotIn("fixture", job.replace("memory-fixture-stage", ""))
        ce = W / "composite-mdbx-validation-stage/r10/jobs/collect-evidence.sh"
        self.assertIn(hashlib.sha256(ce.read_bytes()).hexdigest(), job)
        self.assertIn("state_gate.py stop", (STAGE / "jobs/stop-session.sh").read_text())

    def test_14_pins_are_the_actual_frozen_bytes(self):
        for name, (p, h) in SG.PINS.items():
            self.assertEqual(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest(), h, name)
        t = json.loads(pathlib.Path(SG.PINS["acceptanceTests"][0]).read_bytes())
        self.assertEqual((t["format"], t["pass"], t["ran"], t["stageSums"]), ("state-acceptance-test-receipt/r3", True, ["46"],
                                                                             SG.PINS["acceptanceSums"][1]))
        self.assertEqual((A.R12_STAGE_SUMS_SHA256, A.FORMAT), (SG.PINS["r12Sums"][1], "base-state-readonly/r11"))


if __name__ == "__main__":
    unittest.main()
