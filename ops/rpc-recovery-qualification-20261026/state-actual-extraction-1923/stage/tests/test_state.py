#!/usr/bin/env python3
"""state-production-validation-stage/r5 tests/test_state.py (PREPARED by Claude 1890/1900/1906/1908/1919; NOT run by Claude). 27 tests. NO mount, view,
namespace, queue, network, cgroup change, build, helper run, production data, part or backup: they read this stage's sources, the
FROZEN pinned sources/receipts (r6, r10, acceptance r3, r12, capture r3) and write ONLY under a private tempfile dir. Every report/receipt here is
SYNTHETIC (parser/lifecycle-logic tests); nothing qualifies a production run."""
import ast, contextlib, copy, hashlib, importlib.util, io, json, os, pathlib, re, shlex, stat, sys, tempfile, types, unittest

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
CAPM = SG.load_exact("capture", "capture_r3_pinned")
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
                    "fixturesCapture": ["/vm/f.json", "e" * 64], "extraction": ["/vm/x.json", "f" * 64], "extractionJob": ["/vm/j.json", "9" * 64], "staticFilesDir": self.sf,
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

    def test_04_extractor_last_e2e_block_explicit_no_dead_end(self):
        src = ast.unparse(next(n for n in ast.parse((STAGE / "state_gate.py").read_text()).body
                               if getattr(n, "name", "") == "verify_production_inputs"))
        self.assertTrue(src.rstrip().endswith("return True"), src[-120:])
        order = [src.index(x) for x in ("no_symlink_ancestors(d)", "verify_capture_stage()", "verify_build_receipt(inp, CAPM)",
                                        "verify_captures(inp, A, CAPM, b)", "verify_structural(MG", "verify_extractor_stage()",
                                        "verify_extraction(inp, EXM)")]
        self.assertEqual(order, sorted(order))
        self.assertIsNotNone(SG.EXTRACTOR_E2E_RAW); self.assertEqual(set(SG.BLOCKED), {"extractorE2E"}); self.assertIsNone(SG.PRODUCTION_INPUTS)
        good = {"helperDir": "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261027T000000Z-1/out", "helperSha256": "a" * 64,
                "buildReceipt": ["/vm/b.json", "c" * 64], "positiveCapture": ["/vm/p.json", "d" * 64], "fixturesCapture": ["/vm/f.json", "e" * 64],
                "extraction": ["/vm/x.json", "f" * 64], "extractionJob": ["/vm/j.json", "9" * 64], "staticFilesDir": "/vm/sf",
                "staticFiles": [{"name": "h", "size": 1, "sha256": "b" * 64}],
                "structural": {"job": ["/r/j.json", "1" * 64], "session": ["/r/s.json", "2" * 64]}, "view": dict(VIEW)}
        def stubbed(extra):
            m = load(STAGE / "state_gate.py", "sg_stub_" + "_".join(extra))
            seen = []
            for n in ("no_symlink_ancestors", "on_vm", "verify_capture_stage", "verify_build_receipt", "verify_captures", "verify_structural", *extra):
                setattr(m, n, (lambda n: lambda *a, **k: seen.append(n) or True)(n))
            orig = m.sha_file                                           # r4: stub ONLY the helper binary; every other path is real
            helper = good["helperDir"] + "/base-state-readonly"
            m.sha_file = lambda p, cap: ("a" * 64, None) if p == helper else orig(p, cap)
            return m, seen
        m, seen = stubbed(())                                           # r5: the REAL extractor stage check (unit 25 + archived e2e 8)
        with self.assertRaises(m.Refused) as cm:                        # passes; the REAL verify_extraction refuses the placeholder pins
            m.verify_production_inputs(good, A, types.SimpleNamespace(verify_binaries=lambda d: True), None)
        self.assertIn("the extraction receipt is not", str(cm.exception))
        m2, _seen = stubbed(("x",)); m2.EXTRACTOR_E2E_RAW = None          # an unpinned e2e is still an explicit block, never a skip
        with self.assertRaises(m2.Refused) as cm:
            m2.verify_production_inputs(good, A, types.SimpleNamespace(verify_binaries=lambda d: True), None)
        self.assertIn("BLOCKED extractorE2E", str(cm.exception))
        self.assertEqual(seen[-4:], ["verify_capture_stage", "verify_build_receipt", "verify_captures", "verify_structural"])
        m, seen = stubbed(("verify_extractor_stage", "verify_extraction"))   # all known future inputs passing -> True (no dead end)
        self.assertIs(m.verify_production_inputs(good, A, types.SimpleNamespace(verify_binaries=lambda d: True), None), True)
        self.assertEqual(seen[-2:], ["verify_extractor_stage", "verify_extraction"])


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
                "extraction": ["/vm/x.json", "f" * 64], "extractionJob": ["/vm/j.json", "9" * 64], "staticFilesDir": "/vm/sf",
                "staticFiles": [{"name": "h", "size": 1, "sha256": "b" * 64}],
                "structural": {"job": ["/r/j.json", "1" * 64], "session": ["/r/s.json", "2" * 64]}, "view": dict(VIEW)}
        self.assertEqual(SG.input_shape_errors(good, A), [])
        for k, v in (("helperDir", "/tmp/out"), ("helperSha256", "A" * 64), ("buildReceipt", ["rel", "c" * 64]), ("staticFiles", []),
                     ("structural", {"job": ["/r/j.json", "1" * 64]}), ("view", dict(VIEW, kind="fixture")), ("view", dict(VIEW, parts=264)),
                     ("staticFilesDir", "/vm/../sf"), ("extractionJob", ["rel", "9" * 64]), ("extractionJob", None)):
            self.assertTrue(SG.input_shape_errors(dict(good, **{k: v}), A), k)
        self.assertTrue(SG.input_shape_errors(None, A)); self.assertTrue(SG.input_shape_errors(dict(good, extra=1), A))
        self.assertTrue(SG.input_shape_errors({k: v for k, v in good.items() if k != "extractionJob"}, A))

    def test_13_stop_guard_and_job_wiring(self):
        argv2 = SG.runtime_argv("/v", "/o/session", 1, 7)
        self.assertEqual(argv2, [SG.PY3, "-I", "-B", SG.THIS, "runtime", "--tree-root-pid", "7", "--", "--view-dir", "/v", "--run-dir",
                                 "/o/session", "--expect-kind", "production", "--validator-timeout", "3600"])
        self.assertTrue(MG.runtime_identity(argv2, "/o/session", SG.THIS))
        for extra in (["--fixture-exec", "/bin/true"], ["--fixture-unmount-exe", "/bin/true"]):
            with self.assertRaises(MG.Refused):
                MG.runtime_identity(argv2 + extra, "/o/session", SG.THIS)
        rest = argv2[8:]
        self.assertEqual(SG.runtime_rest_errors(rest), [])
        bad_rests = [rest + ["--fixture-exec", "/bin/true"], rest + ["--fixture-unmount-exe", "/x"], rest[:5] + ["fixture"] + rest[6:],
                     rest + ["--exec-timeout", "5"], rest[:6], rest[2:4] + rest[:2] + rest[4:], rest[:7] + ["1h"]]
        err = io.StringIO()
        for b in bad_rests:
            self.assertTrue(SG.runtime_rest_errors(b), b)
            with contextlib.redirect_stderr(err):
                self.assertEqual(SG.runtime(["--tree-root-pid", "1", "--", *b]), 3, b)
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):          # gate has no fixture / command option at all
            SG.gate(["--view-dir", "/v", "--run-dir", "/r", "--max-hours", "1", "--tree-root-pid", "1", "--fixture-exec", "/bin/true"])
        g = ast.unparse(next(n for n in ast.parse((STAGE / "state_gate.py").read_text()).body if getattr(n, "name", "") == "gate"))
        self.assertIn("argv2 = runtime_argv(a.view_dir, session, a.max_hours, a.tree_root_pid)", g); self.assertEqual(g.count("os.execv("), 1)
        self.assertIn("os.execv(PY3, argv2)", g)
        SGd = MG.load_exact("r6SessionGuard", "r6_session_guard_t")
        self.assertEqual(SGd.script_of(argv2), SG.THIS)
        job = (STAGE / "jobs/root-state-validate.sh").read_text()
        for must in ("ulimit -f 32768; exec timeout -s TERM -k 600 $LIMIT python3 -I -B $S/state_gate.py gate", "collect-evidence.sh before",
                     "collect-evidence.sh after", "state_gate.py final \"$O\" \"$J\" \"$rc\" \"$arc\"", "exit $final", "guards",
                     "state_gate.py guard", 'EVID_S6="$S"', "state_gate.py tests-receipt",
                     "if grep -qF '/composite-memory-fixture-stage/' /proc/self/mountinfo; then die \"a memory-fixture stage mount exists\"; fi"):
            self.assertIn(must, job)                                    # the live memory-fixture GUARD (and its message) is kept
        FORBIDDEN = {"--fixture-exec", "--fixture-unmount-exe", "--expect-kind", "--exec-timeout", "--validator-timeout"}
        def invocations(text):
            out = []
            for line in text.replace("\\\n", " ").splitlines():
                toks = shlex.split(line, comments=True)
                for i, t in enumerate(toks):
                    if t.endswith("state_gate.py") and i + 1 < len(toks):
                        out.append((toks[i + 1], [x for x in toks[i + 2:] if x.startswith("--")]))
            return out
        inv = invocations(job)
        self.assertEqual(sorted(c for c, _ in inv), ["final", "gate", "guard", "tests-receipt"])
        self.assertEqual(dict(inv)["gate"], ["--view-dir", "--run-dir", "--max-hours", "--tree-root-pid"])
        self.assertFalse([f for _, fl in inv for f in fl if f in FORBIDDEN])
        bad = invocations('python3 -I -B $S/state_gate.py gate --view-dir "$V" --fixture-exec /bin/true  # a comment --x\n')
        self.assertEqual(bad, [("gate", ["--view-dir", "--fixture-exec"])])                 # the check DOES see an executable flag
        self.assertEqual(invocations('die "a memory-fixture stage mount exists" # --fixture-exec in a comment\n'), [])
        ce = W / "composite-mdbx-validation-stage/r10/jobs/collect-evidence.sh"
        self.assertIn(hashlib.sha256(ce.read_bytes()).hexdigest(), job)
        self.assertIn("state_gate.py stop", (STAGE / "jobs/stop-session.sh").read_text())

    def test_14_pins_are_the_actual_frozen_bytes(self):
        for name, (p, h) in SG.PINS.items():
            self.assertEqual(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest(), h, name)
        for name, (fmt, n, sums) in SG.TEST_RECEIPTS.items():           # the ACTUAL receipts satisfy the strict check
            self.assertEqual(SG.test_receipt_errors(json.loads(pathlib.Path(SG.PINS[name][0]).read_bytes()), fmt, n, SG.PINS[sums][1]), [], name)
        self.assertEqual(SG.TEST_RECEIPTS["captureTests"][1], 18)
        self.assertEqual(SG.verify_capture_stage().PINS["r12Sums"], SG.PINS["r12Sums"])     # capture r3 cross-pins equal ours
        self.assertEqual((A.R12_STAGE_SUMS_SHA256, A.FORMAT), (SG.PINS["r12Sums"][1], "base-state-readonly/r11"))


GOODINP = lambda hd, **kw: dict({"helperDir": hd, "helperSha256": "a" * 64, "buildReceipt": ["/x", "c" * 64]}, **kw)


class R2(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(); self.t = os.path.realpath(self._td.name)

    def tearDown(self):
        self._td.cleanup()

    def wjson(self, path, obj):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        raw = (json.dumps(obj, sort_keys=True) + "\n").encode()
        pathlib.Path(path).write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def test_15_strict_test_receipts(self):
        t = json.loads(pathlib.Path(SG.PINS["captureTests"][0]).read_bytes())
        fmt, n, sums = SG.TEST_RECEIPTS["captureTests"]
        self.assertEqual(SG.test_receipt_errors(t, fmt, n, SG.PINS[sums][1]), [])
        for k, v in (("rc", False), ("rc", 1), ("expected", "18"), ("expected", 17), ("ran", ["18", "18"]), ("ran", [18]), ("pass", 1),
                     ("format", "state-fixture-capture-test-receipt/r2"), ("stageSums", "0" * 64), ("checks", dict(t["checks"], rc0=False)),
                     ("checks", dict(t["checks"], extra=True)), ("checks", {k2: v2 for k2, v2 in t["checks"].items() if k2 != "stdoutEmpty"})):
            self.assertTrue(SG.test_receipt_errors(dict(t, **{k: v}), fmt, n, SG.PINS[sums][1]), (k, v))
        g = json.loads(pathlib.Path(SG.PINS["r12GuardTests"][0]).read_bytes())
        fmt, n, sums = SG.TEST_RECEIPTS["r12GuardTests"]
        self.assertEqual(SG.test_receipt_errors(g, fmt, n, SG.PINS[sums][1]), [])
        g2 = copy.deepcopy(g); g2["suites"].pop("test_disk_guard")
        g3 = copy.deepcopy(g); g3["suites"]["test_bsro_gate"]["ran"] = ["15"]
        for bad in (g2, g3, dict(g, suites=None)):
            self.assertTrue(SG.test_receipt_errors(bad, fmt, n, SG.PINS[sums][1]))
        own = {"format": SG.OWN_TESTS[0], "pass": True, "rc": 0, "expected": SG.OWN_TESTS[1], "ran": [str(SG.OWN_TESTS[1])], "stageSums": "5" * 64,
               "checks": {k: True for k in SG.SUITE_CHECKS}, "scope": "x"}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.wjson(self.t + "/ok.json", own); self.wjson(self.t + "/bad.json", dict(own, ran=["14"], expected=14))
            self.assertEqual(SG.main(["tests-receipt", self.t + "/ok.json", "5" * 64]), 0)
            self.assertEqual(SG.main(["tests-receipt", self.t + "/bad.json", "5" * 64]), 1)
            self.assertEqual(SG.main(["tests-receipt", self.t + "/ok.json", "6" * 64]), 1)

    def test_16_view_bound_before_any_exec(self):
        inp = {"view": dict(VIEW)}
        self.assertTrue(SG.check_view_binding(inp, view_dir=VIEW["dir"], exposed=dict(VIEW)))
        for kw in (dict(view_dir="/other"), dict(exposed=dict(VIEW, parts=264)), dict(exposed={}), dict(exposed=dict(VIEW, dir="/o"))):
            with self.assertRaises(SG.Refused, msg=kw):
                SG.check_view_binding(inp, **kw)
        m = load(STAGE / "state_gate.py", "sg_view")
        m.PRODUCTION_INPUTS = {"view": dict(VIEW)}
        rd = os.path.join(self.t, "o"); os.mkdir(rd, 0o700)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.gate(["--view-dir", "/other/view", "--run-dir", rd, "--max-hours", "1", "--tree-root-pid", "1"]), 3)
        g = json.loads(pathlib.Path(rd, "gate-refused.json").read_text())
        self.assertIn("not the pinned production view dir", g["refused"]); self.assertNotIn("scope", g); self.assertEqual(os.listdir(rd), ["gate-refused.json"])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(m.runtime(["--tree-root-pid", "1", "--", *SG.runtime_argv("/other/view", "/o/session", 1, 1)[8:]]), 3)
        self.assertIn("not the pinned production view dir", err.getvalue())

        class Base:
            def __init__(self):
                self.a, self.db, self.receipt = None, None, {}
        S = SG.make_state_session(Base, A, {"view": dict(VIEW)}, 0)
        for v in (None, dict(VIEW, manifestSha256="0" * 64)):
            s = S(); s.receipt = {} if v is None else {"view": v}
            with self.assertRaises(SG.Refused):                         # refused BEFORE state_exec_plan (a=None would raise otherwise)
                s.exec_plan()

    def test_17_build_receipt_predicate_single_read_and_unique(self):
        runs, hd = self.t + "/runs", "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261027T000000Z-1/out"
        b = {"mode": "build", "verified": True, "finalRc": 0, "stageSums": SG.PINS["r12Sums"][1],
             "guard": {"outDir": hd, "binaries": {"base-state-readonly": {"sha256": "a" * 64}, "mk_fixture": {"sha256": "b" * 64}}}}
        p = runs + "/build-20261027T000000Z-1/receipt.json"; h = self.wjson(p, b)
        self.assertEqual(SG.verify_build_receipt(GOODINP(hd, buildReceipt=[p, h]), CAPM, runs), b)
        for mut in (dict(verified=False), dict(finalRc=1), dict(mode="preflight"), dict(stageSums="0" * 64),
                    dict(guard=dict(b["guard"], outDir=hd + "x")), dict(guard=dict(b["guard"], binaries={"base-state-readonly": {"sha256": "9" * 64}}))):
            h2 = self.wjson(p, dict(b, **mut))
            with self.assertRaises(SG.Refused, msg=mut):
                SG.verify_build_receipt(GOODINP(hd, buildReceipt=[p, h2]), CAPM, runs)
        h = self.wjson(p, b)
        for inp in (GOODINP(hd, buildReceipt=[p, "0" * 64]), GOODINP(hd, buildReceipt=[self.t + "/elsewhere/receipt.json", h])):
            with self.assertRaises(SG.Refused):
                SG.verify_build_receipt(inp, CAPM, runs)
        self.wjson(runs + "/build-20261027T000001Z-2/receipt.json", b)                     # a second matching build receipt
        with self.assertRaises(SG.Refused):
            SG.verify_build_receipt(GOODINP(hd, buildReceipt=[p, h]), CAPM, runs)

    def test_18_structural_same_id_hashed_bytes_no_substitution(self):
        runs, ID = self.t + "/runs", "20261027T000000Z-42"
        job = {"format": "composite-production-memory-job-receipt/r10", "rc": 0, "collectRc": 0, "structurallyCleanRun": True,
               "outcome": "CLEAN", "checks": {k: True for k in MG.JOB_CHECKS}}
        ses = {"outcome": "CLEAN", "rc": 0, "cleanupComplete": True, "view": dict(VIEW)}
        jp, sp = f"{runs}/job-{ID}/receipt.json", f"{runs}/prod-{ID}/session/receipt.json"
        st = lambda: {"job": [jp, hashlib.sha256(pathlib.Path(jp).read_bytes()).hexdigest()],
                      "session": [sp, hashlib.sha256(pathlib.Path(sp).read_bytes()).hexdigest()]}
        self.wjson(jp, job); self.wjson(sp, ses)
        self.assertTrue(SG.verify_structural(MG, st(), VIEW, runs))
        other = f"{runs}/prod-20261027T000000Z-43/session/receipt.json"; self.wjson(other, ses)
        for bad in (dict(st(), session=[other, hashlib.sha256(pathlib.Path(other).read_bytes()).hexdigest()]),
                    dict(st(), job=[runs + f"/job-{ID}/job-receipt.json", "0" * 64]), dict(st(), job=[jp, "0" * 64])):
            with self.assertRaises(SG.Refused):
                SG.verify_structural(MG, bad, VIEW, runs)
        pins = st()
        def swap(path, rc, jrc):                                        # substitution AROUND MG.evidence: real check, then replace
            r = MG.evidence(path, rc, jrc); self.wjson(jp, dict(job, reasons=["swapped"])); return r
        with self.assertRaises(SG.Refused) as cm:
            SG.verify_structural(types.SimpleNamespace(evidence=swap, JOB_CHECKS=MG.JOB_CHECKS), pins, VIEW, runs)
        self.assertIn("changed around", str(cm.exception))
        self.wjson(jp, dict(job, checks={k: True for k in sorted(MG.JOB_CHECKS)[1:]}))   # the hashed bytes judged by OUR predicate too
        with self.assertRaises(SG.Refused):
            SG.verify_structural(types.SimpleNamespace(evidence=lambda *a: 0, JOB_CHECKS=MG.JOB_CHECKS), st(), VIEW, runs)
        self.wjson(jp, job)
        for s2 in (dict(ses, outcome="PROBLEMS"), dict(ses, rc=False), dict(ses, view=dict(VIEW, parts=264)), dict(ses, cleanupComplete=None)):
            self.wjson(sp, s2)
            with self.assertRaises(SG.Refused, msg=s2):
                SG.verify_structural(MG, st(), VIEW, runs)

    def make_captures(self, sub="c"):
        hd = f"{self.t}/{sub}/out"; os.makedirs(hd)
        HB, HM = "a" * 64, "b" * 64
        b = {"mode": "build", "verified": True, "finalRc": 0, "stageSums": SG.PINS["r12Sums"][1],
             "guard": {"outDir": hd, "binaries": {"base-state-readonly": {"sha256": HB}, "mk_fixture": {"sha256": HM}}}}
        bp = f"{self.t}/{sub}/b12runs/build-1/receipt.json"; bsha = self.wjson(bp, b)
        inp = {"helperDir": hd, "helperSha256": HB, "buildReceipt": [bp, bsha]}
        for key, kind in (("positiveCapture", "positive"), ("fixturesCapture", "fixtures")):
            rd = f"{hd}/fixture-captures/{kind}-20261101T000000Z-{1 if kind == 'positive' else 2}"; work = rd + "/work"
            os.makedirs(work + "/out")
            if kind == "positive":
                lines = [f"case {l}: PASS" for l in A.POSITIVE_LABELS] + ["## runs=26 failed=0", f"## outputs {work}/out", "## bsro-r12-positive rc=0"]
            else:
                lines = [f"case {n} rc={3 if e == '3' else 1} expect={e} unchanged=y PASS" for n, e in A.NEGATIVE_CASES] + \
                        ["## fixtures failed=0", "## bsro-r12-fixtures rc=0"]
            cap = ("\n".join(lines) + "\n").encode(); pathlib.Path(rd, "capture.txt").write_bytes(cap)
            req, _opt = CAPM.expected_evidence_names(kind, A)
            for n in req:
                pathlib.Path(work, "out", n).write_text(f"{HB}  {hd}/base-state-readonly\n{HM}  {hd}/mk_fixture\n" if n == "binaries.sha256" else "x")
            exp = CAPM.expected_identities(kind, b, bsha)
            rec = {"format": CAPM.RECEIPT_FORMAT, "kind": kind, "pass": True, "synthetic": False, "authenticatedBy": "capture", "reasons": [],
                   "pins": {n: v[1] for n, v in CAPM.PINS.items()}, "acceptance": {n: v[1] for n, v in CAPM.ACCEPTANCE.items()},
                   "wrapperSums": "4" * 64, "buildOutDir": hd, "runDir": rd, "workDir": work, "buildReceipt": {"path": bp, "sha256": bsha},
                   "identitiesBefore": exp, "identitiesAfter": exp, "completionFingerprint": "5" * 64, "spawn": {"argv": ["/usr/bin/timeout"], "pid": 9},
                   "capture": {"path": rd + "/capture.txt", "sha256": hashlib.sha256(cap).hexdigest(), "rc": 0, "keptBytes": len(cap),
                               "totalBytes": len(cap), "truncated": False, "abandoned": False, "sinkError": None, "timedOut": False},
                   "check": {"outputValid": True}, "cleanup": {"mountsLeft": [], "treesLeft": False, "evidenceKept": True, "groupAlive": False,
                                                              "roStillOk": True, "stageRunsUnchanged": True},
                   "verifyBinariesAfter": True, "startedUtc": "x", "seconds": 1, "roPaths": ["/home/steven", "/tmp"],
                   "vmBinding": {"majmin": CAPM.VM_MAJMIN, "uuid": CAPM.VM_UUID},
                   "outputsLine": {"want": work + "/out" if kind == "positive" else None, "errors": []},
                   "evidence": {"manifest": CAPM.evidence_manifest(work + "/out"), "errors": []}}
            inp[key] = [rd + "/receipt.json", self.wjson(rd + "/receipt.json", rec)]
        return inp, b

    def repin(self, inp, key, fn):
        rec = json.loads(pathlib.Path(inp[key][0]).read_bytes()); fn(rec)
        return dict(inp, **{key: [inp[key][0], self.wjson(inp[key][0], rec)]})

    def test_19_capture_r3_wiring(self):
        inp, b = self.make_captures()
        self.assertEqual([r["kind"] for r in SG.verify_captures(inp, A, CAPM, b)], ["positive", "fixtures"])
        muts = [lambda i: dict(i, positiveCapture=[i["positiveCapture"][0], "0" * 64]),                         # receipt not the pin
                lambda i: self.repin(i, "positiveCapture", lambda r: r.__setitem__("buildOutDir", r["buildOutDir"] + "x")),
                lambda i: self.repin(i, "positiveCapture", lambda r: r.__setitem__("runDir", r["runDir"].replace("positive-", "fixtures-"))),
                lambda i: self.repin(i, "fixturesCapture", lambda r: r["identitiesAfter"].__setitem__("helperSha256", "9" * 64)),
                lambda i: self.repin(i, "fixturesCapture", lambda r: r.__setitem__("pass", False)),
                lambda i: self.repin(i, "fixturesCapture", lambda r: r["buildReceipt"].__setitem__("sha256", "0" * 64)),
                lambda i: dict(i, helperSha256="9" * 64)]
        for n, mut in enumerate(muts):
            inp, b = self.make_captures(f"m{n}")
            with self.assertRaises(SG.Refused, msg=n):
                SG.verify_captures(mut(inp), A, CAPM, b)
        inp, b = self.make_captures("t")
        append(json.loads(pathlib.Path(inp["positiveCapture"][0]).read_bytes())["capture"]["path"])   # capture.txt != the receipt's bytes
        with self.assertRaises(SG.Refused) as cm:
            SG.verify_captures(inp, A, CAPM, b)
        self.assertIn("capture.txt is not the receipt's bytes", str(cm.exception))

    def test_20_capture_evidence_outputs_and_o1_wrapper(self):
        inp, b = self.make_captures()
        pos = json.loads(pathlib.Path(inp["positiveCapture"][0]).read_bytes())
        ev = os.path.join(pos["workDir"], "out", "v1-pass.mk.txt")
        pathlib.Path(ev).write_text("tampered")                         # evidence changed after the capture
        with self.assertRaises(SG.Refused) as cm:
            SG.verify_captures(inp, A, CAPM, b)
        self.assertIn("manifest re-hash differs", str(cm.exception))
        pathlib.Path(ev).write_text("x")
        cap = pathlib.Path(pos["capture"]["path"]).read_bytes().replace(f"## outputs {pos['workDir']}/out".encode(), b"## outputs /vm/other/out")
        pathlib.Path(pos["capture"]["path"]).write_bytes(cap)            # the pinned parser accepts any abs path; the wiring does not
        inp2 = self.repin(inp, "positiveCapture", lambda r: r["capture"].__setitem__("sha256", hashlib.sha256(cap).hexdigest()))
        with self.assertRaises(SG.Refused) as cm:
            SG.verify_captures(inp2, A, CAPM, b)
        self.assertIn("outputs line", str(cm.exception))
        # O1 (root decision): non-35 outcomes need verified cleanup, else 4; a runtime 35 is acceptance's alone
        for rc, acc, cv, want in ((35, 35, True, 35), (35, 10, False, 10), (34, 34, True, 34), (34, 34, False, 4), (3, 3, True, 3),
                                  (3, 3, False, 4), (0, 10, True, 10), (0, 10, False, 4), (None, 10, False, 4), (7, 7, None, 4)):
            self.assertEqual(SG.wrapper_code(rc, acc, cv), want, (rc, acc, cv))
        ok = {k: True for k in SG.SNAP_KEYS}
        O = self.t + "/O"; os.mkdir(O)
        self.assertTrue(SG.cleanup_verified(O, None, ok))                 # gate refused: no session dir
        os.mkdir(O + "/session"); self.assertTrue(SG.cleanup_verified(O, None, ok))   # runtime refused: empty session dir
        pathlib.Path(O, "session", "receipt.json").write_text("{}")
        self.assertFalse(SG.cleanup_verified(O, None, ok)); self.assertFalse(SG.cleanup_verified(O, {"cleanupComplete": None}, ok))
        self.assertTrue(SG.cleanup_verified(O, {"cleanupComplete": True}, ok))
        for k in SG.SNAP_KEYS:
            self.assertFalse(SG.cleanup_verified(O, {"cleanupComplete": True}, dict(ok, **{k: False})), k)
        self.assertFalse(SG.cleanup_verified(O, {"cleanupComplete": True}, None))
        J = self.t + "/J"; os.mkdir(J)                                  # no status files: snapshots not ok -> a runtime 34 exits 4
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(SG.final(O, J, "34", "0"), 4)
        f = json.loads(pathlib.Path(J, "final.json").read_text())
        self.assertEqual((f["acceptanceFinal"], f["cleanupVerified"], f["final"]), (34, False, 4))


# ---- r3 (1906): the extractor r3 adapter ------------------------------------------------------------------------------------------
EXM = SG.load_exact("extractor", "extract_r3_pinned")
XID = "20261101T000000Z-7"


def h(b):
    return hashlib.sha256(b).hexdigest()


def raw_files(pins, origin=None):
    f = {k: pathlib.Path(p).read_bytes() for k, (p, _s) in pins.items()}
    f["outDir"] = origin or os.path.dirname(pins["stderr"][0])
    return f


def synth_e2e(n=8, od="/w/compact-header-extraction-stage/r3/runs/e2e-20261101T000000Z-1"):
    err = b"".join(f"test_{i} (__main__.E.test_{i}) ... ok\n".encode() for i in range(1, n + 1)) + \
        f"\n{'-' * 70}\nRan {n} tests in 99.000s\n\nOK\n".encode()
    tail = err.decode()[:-1].split("\n")[-40:]
    guard = b"[memory-guard] exit=0 peakTreeRssMiB=300 minHostAvailableMiB=20000\n"
    out = "\n".join(["[queue] START available=1MiB", '{"refused": []}', *tail, f"## PASS ({n})",
                     "## workspace /vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-e2e-20261101T000000Z-1 (kept for review; owned; remove after review)",
                     f"## outputs {od}", guard.decode().strip(), "[memory-guard] at peak: python3:9", "[queue] EXIT 0"]) + "\n"
    return {"out": out.encode(), "rc": b"0\n", "guard": guard, "stderr": err, "stdout": b"", "outDir": od}


class Extractor(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(); self.t = os.path.realpath(self._td.name)

    def tearDown(self):
        self._td.cleanup()

    def test_21_actual_raw_unit_25_pass_and_mutations(self):
        self.assertTrue(SG.read_raw_test(SG.EXTRACTOR_UNIT_RAW, 25, SG.UNIT_OUT_DIR_RE, origin_dir=SG.EXTRACTOR_UNIT_ORIGIN_DIR))
        with self.assertRaises(SG.Refused):                             # r4: the archive's physical dir is NOT the run's output dir
            SG.read_raw_test(SG.EXTRACTOR_UNIT_RAW, 25, SG.UNIT_OUT_DIR_RE)
        f = raw_files(SG.EXTRACTOR_UNIT_RAW, SG.EXTRACTOR_UNIT_ORIGIN_DIR)
        self.assertEqual(SG.raw_test_errors(f, 25, SG.UNIT_OUT_DIR_RE), [])
        self.assertTrue(SG.raw_test_errors(f, 24, SG.UNIT_OUT_DIR_RE)); self.assertTrue(SG.raw_test_errors(f, 25, SG.E2E_OUT_DIR_RE))
        muts = [("rc", b"1\n"), ("rc", b"0"), ("stderr", f["stderr"].replace(b"Ran 25 tests", b"Ran 24 tests")),
                ("stderr", f["stderr"][:-3]), ("stderr", f["stderr"] + b"ResourceWarning: x\n"),
                ("stderr", f["stderr"].replace(b"... ok", b"... skipped", 1)), ("out", f["out"].replace(b"## PASS (25)", b"## FAIL (rc 1)")),
                ("out", f["out"].replace(b"[queue] EXIT 0", b"[queue] EXIT 1")), ("out", f["out"].replace(b"## outputs /tmp/", b"## outputs /var/")),
                ("out", f["out"].replace(b"## PASS (25)\n", b"## PASS (25)\n## PASS (25)\n")), ("guard", b"[memory-guard] exit=1 x\n"),
                ("out", f["out"].replace(f["stderr"].split(b"\n")[-12], b"tampered tail line")), ("outDir", "/tmp/other-dir"),
                ("stderr", b"\xff\xfe")]
        for i, (k, v) in enumerate(muts):
            self.assertTrue(SG.raw_test_errors(dict(f, **{k: v}), 25, SG.UNIT_OUT_DIR_RE), i)
        self.assertTrue(SG.raw_test_errors({k: v for k, v in f.items() if k != "guard"}, 25, SG.UNIT_OUT_DIR_RE))
        self.assertTrue(SG.raw_test_errors(None, 25, SG.UNIT_OUT_DIR_RE))

    def test_22_future_e2e_acceptance_function_and_explicit_block(self):
        od = SG.EX3 + "/runs/e2e-20261101T000000Z-1"
        f = synth_e2e(od=od)                                            # SYNTHETIC e2e-tests.sh-shaped output: a parser test only
        self.assertEqual(SG.raw_test_errors(f, 8, SG.E2E_OUT_DIR_RE, e2e=True), [])
        self.assertTrue(SG.raw_test_errors(f, 8, SG.E2E_OUT_DIR_RE, e2e=False))     # the workspace line is e2e-only
        self.assertTrue(SG.raw_test_errors(f, 25, SG.E2E_OUT_DIR_RE, e2e=True))
        for k, v in (("out", f["out"].replace(b"## workspace ", b"## space ")), ("outDir", "/tmp/che1881-unit-AAAAAAAA"),
                     ("out", f["out"].replace(b"## PASS (8)", b"## PASS (7)")), ("rc", b"4\n")):
            self.assertTrue(SG.raw_test_errors(dict(f, **{k: v}), 8, SG.E2E_OUT_DIR_RE, e2e=True), k)
        self.assertTrue(SG.read_raw_test(SG.EXTRACTOR_E2E_RAW, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=SG.EXTRACTOR_E2E_ORIGIN_DIR))
        EXr = SG.verify_extractor_stage()                               # r5: SUMS + ACTUAL unit 25 + ACTUAL archived e2e 8 -> the module
        self.assertTrue(callable(EXr.state_pins))

    def fixture(self, **mut):
        T = self.t
        parent, runs = T + "/vmparent", T + "/runs"
        run = parent + f"/compact-header-extraction-{XID}"
        jd = runs + "/extract-20261101T000000Z-9"
        os.makedirs(run + "/files/data/static_files"); os.makedirs(jd)
        files = [{"path": e["path"], "size": e["size"], "sha256": f"{i:064x}"} for i, e in enumerate(EXM.PROD_ALLOWLIST)]
        ident = {"dev": 1, "ino": 2, "size": 3, "mtimeNs": 4, "ctimeNs": 5, "mode": 0o444, "readOnlyMount": False}
        rec = {"format": "compact-header-extraction-receipt/v1", "rc": 0, "outcome": "CLEAN", "runDir": run,
               "session": {"rc": 0, "reasons": []}, "canonicalAuthority": False, "resetAuthority": False, "files": files,
               "totalBytes": EXM.PROD["total"], "backupReceiptSha256": EXM.BACKUP_RECEIPT[1], "sourcePre": dict(ident), "sourcePost": dict(ident)}
        raw = json.dumps(mut.get("rec", rec)).encode()
        pathlib.Path(run, "EXTRACTION-RECEIPT.json").write_bytes(raw)
        job = {"format": EXM.JOB_FORMAT, "finalRc": 0, "extractRc": 0, "stageSumsBefore": SG.PINS["extractorSums"][1],
               "stageSumsAfter": SG.PINS["extractorSums"][1], "stageCheckAfterOk": True, "peersBeforeSha256": "6" * 64,
               "peersAfterSha256": "6" * 64, "peersEqual": True, "runDir": run, "extractionReceiptPath": run + "/EXTRACTION-RECEIPT.json",
               "extractionReceiptSha256": h(raw), "jobDir": jd, "canonicalAuthority": False, "resetAuthority": False,
               "createdUtc": "2026-11-01T00:00:00Z"}
        job.update(mut.get("job", {}))
        jraw = json.dumps(job).encode()
        pathlib.Path(jd, "JOB-RECEIPT.json").write_bytes(jraw)
        sf = [{"name": f["path"].rsplit("/", 1)[1], "size": f["size"], "sha256": f["sha256"]} for f in files[1:]]
        inp = {"extraction": [run + "/EXTRACTION-RECEIPT.json", h(raw)], "extractionJob": [jd + "/JOB-RECEIPT.json", h(jraw)],
               "staticFilesDir": run + "/files/data/static_files", "staticFiles": sf}
        return inp, {"runs_dir": runs, "prod_parent": parent, "vm": lambda p: True}, run, jd

    def check(self, inp, kw):
        return SG.verify_extraction(inp, EXM, **kw)

    def refused(self, inp, kw, msg=None):
        with self.assertRaises((SG.Refused, EXM.Refuse, OSError), msg=msg):
            self.check(inp, kw)

    def test_23_extraction_bound_through_the_pinned_state_pins(self):
        inp, kw, run, jd = self.fixture()
        pins = self.check(inp, kw)
        self.assertEqual((pins["staticFilesDir"], pins["staticFiles"], pins["stageSums"]),
                         (inp["staticFilesDir"], inp["staticFiles"], SG.PINS["extractorSums"][1]))
        self.assertEqual((pins["extractionReceiptSha256"], pins["jobReceiptSha256"]), (inp["extraction"][1], inp["extractionJob"][1]))
        src = ast.unparse(next(n for n in ast.parse((STAGE / "state_gate.py").read_text()).body if getattr(n, "name", "") == "verify_extraction"))
        self.assertIn("EXM.state_pins(raws['receipt'], run_dir, raws['job'], PINS['extractorSums'][1])", src)

    def test_24_extraction_refusals(self):
        inp, kw, run, jd = self.fixture(); os.unlink(jd + "/JOB-RECEIPT.json")
        self.refused(inp, kw, "outer missing")
        self.tearDown(); self.setUp()
        for name, job in (("outer nonzero", {"finalRc": 1}), ("outer extract rc", {"extractRc": 4}),
                          ("outer mismatched sha", {"extractionReceiptSha256": "9" * 64}), ("outer peers", {"peersEqual": False}),
                          ("outer other stage", {"stageSumsAfter": "8" * 64}), ("jobDir not parent", {"jobDir": "/x/runs/extract-1"})):
            inp, kw, run, jd = self.fixture(job=job)
            self.refused(inp, kw, name); self.tearDown(); self.setUp()
        inp, kw, run, jd = self.fixture()
        pathlib.Path(run, "EXTRACTION-RECEIPT.json").write_bytes(pathlib.Path(run, "EXTRACTION-RECEIPT.json").read_bytes().replace(b'"rc": 0', b'"rc": 0 '))
        self.refused(inp, kw, "swapped inner bytes (pin unchanged)")
        inp["extraction"][1] = h(pathlib.Path(run, "EXTRACTION-RECEIPT.json").read_bytes())
        self.refused(inp, kw, "swapped inner bytes re-pinned, outer still bound to the old sha")
        self.tearDown(); self.setUp()
        for name, f in (("reordered", lambda i: i["staticFiles"].reverse()), ("size changed", lambda i: i["staticFiles"][0].__setitem__("size", 1)),
                        ("dir differs", lambda i: i.__setitem__("staticFilesDir", i["staticFilesDir"] + "x")),
                        ("job pin", lambda i: i["extractionJob"].__setitem__(1, "0" * 64))):
            inp, kw, run, jd = self.fixture(); f(inp)
            self.refused(inp, kw, name); self.tearDown(); self.setUp()
        inp, kw, run, jd = self.fixture()
        bad = dict(inp, extraction=[run.replace("compact-header-extraction-", "compact-header-e2e-") + "/EXTRACTION-RECEIPT.json", inp["extraction"][1]])
        self.refused(bad, kw, "wrong run path")
        self.refused(dict(inp, extractionJob=[self.t + "/elsewhere/JOB-RECEIPT.json", inp["extractionJob"][1]]), kw, "job not runs/extract-ID")
        os.rename(run + "/files", run + "/files-real"); os.symlink(run + "/files-real", run + "/files")
        self.refused(inp, kw, "symlinked ancestor")
        os.unlink(run + "/files"); os.rename(run + "/files-real", run + "/files")
        self.assertTrue(self.check(inp, kw))
        self.refused(inp, dict(kw, vm=SG.on_vm), "not on /vm")          # the real /vm device check refuses a tmp dir

    def test_25_qualification_pins_missing_or_malformed(self):
        good = SG.EXTRACTOR_UNIT_RAW
        for bad in (None, {k: v for k, v in good.items() if k != "guard"}, dict(good, extra=good["rc"]),
                    dict(good, rc=[good["rc"][0], "0" * 64]), dict(good, rc=["rel/path", good["rc"][1]]),
                    dict(good, stdout=[self.t + "/stdout", good["stdout"][1]])):
            with self.assertRaises((SG.Refused, OSError)):
                SG.read_raw_test(bad, 25, SG.UNIT_OUT_DIR_RE)
        d = self.t + "/che1881-unit-copy"; os.mkdir(d)                  # exact bytes, but not the job's own output dir
        for k in ("stderr", "stdout"):
            pathlib.Path(d, k).write_bytes(pathlib.Path(good[k][0]).read_bytes())
        with self.assertRaises(SG.Refused):
            SG.read_raw_test(dict(good, stderr=[d + "/stderr", good["stderr"][1]], stdout=[d + "/stdout", good["stdout"][1]]), 25, SG.UNIT_OUT_DIR_RE)
        with self.assertRaises(SG.Refused):
            SG.read_raw_test(good, 8, SG.E2E_OUT_DIR_RE, e2e=True)     # the unit run can never stand in for the e2e

    def test_26_archived_actual_evidence_with_its_original_output_dir(self):
        good = SG.EXTRACTOR_UNIT_RAW
        self.assertEqual(SG.EXTRACTOR_UNIT_ORIGIN_DIR, "/tmp/che1881-unit-GnvMSyRq")
        self.assertTrue(all(p.startswith(SG.EVID + "/") for p, _ in good.values()))
        self.assertIn(b"## outputs " + SG.EXTRACTOR_UNIT_ORIGIN_DIR.encode() + b"\n", pathlib.Path(good["out"][0]).read_bytes())

        def archive(name, mutate=None):
            d = os.path.join(self.t, name); os.makedirs(d + "/x")
            pins = {}
            for k, (p, hsh) in good.items():
                dst = os.path.join(d, "x", k) if k in ("stderr", "stdout") else os.path.join(d, k)
                b = pathlib.Path(p).read_bytes()
                pathlib.Path(dst).write_bytes(mutate(k, b) if mutate else b)
                pins[k] = [dst, hsh]
            return pins
        cp = archive("copy")                                             # copied ACTUAL unchanged bytes, same shas
        self.assertTrue(SG.read_raw_test(cp, 25, SG.UNIT_OUT_DIR_RE, origin_dir=SG.EXTRACTOR_UNIT_ORIGIN_DIR))
        for origin in ("/tmp/che1881-unit-AAAAAAAA", "/tmp/che1881-unit-GnvMSyRq/x", None, "rel/che1881-unit-GnvMSyRq", 7,
                       "/tmp/../tmp/che1881-unit-GnvMSyRq"):
            with self.assertRaises(SG.Refused, msg=origin):              # mismatched / malformed origin metadata
                SG.read_raw_test(cp, 25, SG.UNIT_OUT_DIR_RE, origin_dir=origin)
        with self.assertRaises(SG.Refused):
            SG.read_raw_test(cp, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=SG.EXTRACTOR_UNIT_ORIGIN_DIR)
        for k in SG.RAW_KEYS:                                            # modified bytes (pins unchanged) -> sha refuses
            m = archive("mod-" + k, lambda kk, b, k=k: b + b"\n" if kk == k else b)
            with self.assertRaises(SG.Refused, msg=k):
                SG.read_raw_test(m, 25, SG.UNIT_OUT_DIR_RE, origin_dir=SG.EXTRACTOR_UNIT_ORIGIN_DIR)
        re_pinned = archive("tamper", lambda kk, b: b.replace(b"Ran 25 tests", b"Ran 26 tests") if kk in ("stderr", "out") else b)
        for k in ("stderr", "out"):                                       # modified AND re-pinned -> the unweakened parser refuses
            re_pinned[k][1] = h(pathlib.Path(re_pinned[k][0]).read_bytes())
        with self.assertRaises(SG.Refused):
            SG.read_raw_test(re_pinned, 25, SG.UNIT_OUT_DIR_RE, origin_dir=SG.EXTRACTOR_UNIT_ORIGIN_DIR)
        split = dict(cp, stdout=[os.path.join(self.t, "copy", "stdout-elsewhere"), good["stdout"][1]])
        pathlib.Path(split["stdout"][0]).write_bytes(pathlib.Path(good["stdout"][0]).read_bytes())
        with self.assertRaises(SG.Refused):                              # stderr/stdout must share ONE physical parent dir
            SG.read_raw_test(split, 25, SG.UNIT_OUT_DIR_RE, origin_dir=SG.EXTRACTOR_UNIT_ORIGIN_DIR)

    def test_27_archived_actual_e2e_8_with_its_original_output_dir(self):
        good, origin = SG.EXTRACTOR_E2E_RAW, SG.EXTRACTOR_E2E_ORIGIN_DIR
        self.assertEqual(origin, SG.EX3 + "/runs/e2e-20261027T133216Z-3242045")
        self.assertRegex(origin, "^" + SG.E2E_OUT_DIR_RE + "$")
        self.assertTrue(all(p.startswith(SG.EVID_E2E + "/") for p, _ in good.values()))
        self.assertEqual({k: v[1] for k, v in good.items()},
                         {"out": "ee40de431d4b26f14f39e5b4f4652b54af33d2926b687faf7eeebc26f1c4f95e",
                          "rc": "9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa",
                          "guard": "5f55951292b5f6cf74295678ca98f22908eda13ddd48edd7179c85c37b00cb1b",
                          "stderr": "007c655c805fc49c06a14d081851388c934473fb4328943b026a95e5b0845f0c",
                          "stdout": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"})
        out, err = pathlib.Path(good["out"][0]).read_bytes(), pathlib.Path(good["stderr"][0]).read_bytes()
        self.assertIn(b"\n## outputs " + origin.encode() + b"\n", out)    # the origin is the preserved log's own line
        self.assertNotIn(SG.EVID_E2E.encode(), out)                      # ... never the archive path
        self.assertEqual(len([l for l in err.decode().split("\n") if l.endswith(" ... ok")]), 8)
        for bad in (b"skipped", b"expected failure", b"unexpected success", b"FAIL", b"ERROR"):
            self.assertNotIn(bad, err)
        self.assertEqual(pathlib.Path(good["rc"][0]).read_bytes(), b"0\n")
        self.assertTrue(SG.read_raw_test(good, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=origin))
        with self.assertRaises(SG.Refused):                             # the archive's physical dir is NOT the run's output dir
            SG.read_raw_test(good, 8, SG.E2E_OUT_DIR_RE, e2e=True)
        for o in (origin[:-1] + "6", SG.EXTRACTOR_UNIT_ORIGIN_DIR, SG.EVID_E2E + "/e2e", origin + "/x", "rel/e2e-20261027T133216Z-3242045",
                  origin.replace("/runs/", "/runs/../runs/"), SG.EX3 + "/runs/extract-20261027T133307Z-3243269", 7):
            with self.assertRaises(SG.Refused, msg=o):                   # mismatched / malformed origin metadata
                SG.read_raw_test(good, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=o)
        for n, e2e in ((7, True), (25, True), (8, False)):
            with self.assertRaises(SG.Refused, msg=(n, e2e)):            # exactly 8, and only as an e2e run
                SG.read_raw_test(good, n, SG.E2E_OUT_DIR_RE, e2e=e2e, origin_dir=origin)
        with self.assertRaises(SG.Refused):
            SG.read_raw_test(good, 8, SG.UNIT_OUT_DIR_RE, e2e=True, origin_dir=origin)

        def archive(name, mutate=None):
            d = os.path.join(self.t, name); os.makedirs(d + "/e2e")
            pins = {}
            for k, (p, hsh) in good.items():
                dst = os.path.join(d, "e2e", k) if k in ("stderr", "stdout") else os.path.join(d, k)
                b = pathlib.Path(p).read_bytes()
                pathlib.Path(dst).write_bytes(mutate(k, b) if mutate else b)
                pins[k] = [dst, hsh]
            return pins
        cp = archive("copy")                                             # copied ACTUAL unchanged bytes, same shas
        self.assertTrue(SG.read_raw_test(cp, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=origin))
        for k in SG.RAW_KEYS:                                            # one byte changed, pins unchanged -> the hash refuses
            m = archive("mod-" + k, lambda kk, b, k=k: b + b"\n" if kk == k else b)
            with self.assertRaises(SG.Refused, msg=k):
                SG.read_raw_test(m, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=origin)
        for name, f in (("skip", lambda b: b.replace(b"... ok", b"... skipped 'x'", 1)), ("ran7", lambda b: b.replace(b"Ran 8 tests", b"Ran 7 tests")),
                        ("origin", lambda b: b.replace(origin.encode(), (origin[:-1] + "6").encode()))):
            rp = archive("re-" + name, lambda kk, b, f=f: f(b) if kk in ("stderr", "out") else b)
            for k in ("stderr", "out"):                                   # changed AND re-pinned -> the unweakened parser refuses
                rp[k][1] = h(pathlib.Path(rp[k][0]).read_bytes())
            with self.assertRaises(SG.Refused, msg=name):
                SG.read_raw_test(rp, 8, SG.E2E_OUT_DIR_RE, e2e=True, origin_dir=origin)
        m = load(STAGE / "state_gate.py", "sg_e2e_pin")                 # a wrong pinned sha in the stage constant refuses the stage check
        m.EXTRACTOR_E2E_RAW = dict(good, guard=(good["guard"][0], "0" * 64))
        with self.assertRaises(m.Refused):
            m.verify_extractor_stage()
        m.EXTRACTOR_E2E_RAW, m.EXTRACTOR_E2E_ORIGIN_DIR = good, origin[:-1] + "6"
        with self.assertRaises(m.Refused):
            m.verify_extractor_stage()


if __name__ == "__main__":
    unittest.main()
