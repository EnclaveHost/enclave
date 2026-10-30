#!/usr/bin/env python3
"""state-production-validation-stage/r2 tests/test_state.py (PREPARED by Claude 1890/1900; NOT run by Claude). 20 tests. NO mount, view,
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

    def test_04_extraction_stays_blocked_after_every_other_prerequisite(self):
        src = ast.unparse(next(n for n in ast.parse((STAGE / "state_gate.py").read_text()).body
                               if getattr(n, "name", "") == "verify_production_inputs"))
        self.assertTrue(src.rstrip().endswith("refuse('EXTRACTION is pinned but no reviewed consumer exists in this revision')"), src[-200:])
        self.assertIn("if EXTRACTION is None:", src); self.assertIsNone(SG.EXTRACTION); self.assertEqual(set(SG.BLOCKED), {"extractionReceipt"})
        order = [src.index(x) for x in ("no_symlink_ancestors(d)", "verify_capture_stage()", "verify_build_receipt(inp, CAPM)",
                                        "verify_captures(inp, A, CAPM, b)", "verify_structural(MG", "if EXTRACTION is None:")]
        self.assertEqual(order, sorted(order))
        m = load(STAGE / "state_gate.py", "sg_blocked")                 # a private instance: stub only the impure prerequisites
        good = {"helperDir": "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261027T000000Z-1/out", "helperSha256": "a" * 64,
                "buildReceipt": ["/vm/b.json", "c" * 64], "positiveCapture": ["/vm/p.json", "d" * 64], "fixturesCapture": ["/vm/f.json", "e" * 64],
                "extraction": ["/vm/x.json", "f" * 64], "staticFilesDir": "/vm/sf", "staticFiles": [{"name": "h", "size": 1, "sha256": "b" * 64}],
                "structural": {"job": ["/r/j.json", "1" * 64], "session": ["/r/s.json", "2" * 64]}, "view": dict(VIEW)}
        seen = []
        for n in ("no_symlink_ancestors", "on_vm", "verify_capture_stage", "verify_build_receipt", "verify_captures", "verify_structural"):
            setattr(m, n, (lambda n: lambda *a, **k: seen.append(n) or True)(n))
        m.sha_file = lambda p, cap: ("a" * 64, None)
        with self.assertRaises(m.Refused) as cm:
            m.verify_production_inputs(good, A, types.SimpleNamespace(verify_binaries=lambda d: True), None)
        self.assertIn("BLOCKED extractionReceipt", str(cm.exception))
        self.assertEqual(seen[-4:], ["verify_capture_stage", "verify_build_receipt", "verify_captures", "verify_structural"])


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
        own = {"format": SG.OWN_TESTS[0], "pass": True, "rc": 0, "expected": 20, "ran": ["20"], "stageSums": "5" * 64,
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


if __name__ == "__main__":
    unittest.main()
