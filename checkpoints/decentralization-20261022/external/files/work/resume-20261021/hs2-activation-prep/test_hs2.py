"""Fixture tests of the hs2 activation helper: the pure guards (hs2lib) on a probe built from the REAL read-only probe of
13:31Z, and the helper's orchestration (root-hs2-activate.py main) with its SSH/scp layer stubbed - never a real host.
  run: python3 -m unittest -v test_hs2.py"""
import copy, importlib.util, json, pathlib, shutil, sys, tempfile, unittest
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import hs2lib as L

SUMS = {s: "%064x" % (i + 1) for i, s in enumerate(L.SCRIPTS)}
LOCAL = {f"bafy{'a' * 30}{i:04d}.{ext}": 1000 + i for i in range(L.PINS["objects"]) for ext in ("bin", "car")}
BASE = {  # the real probe (probe-minipc.json, 2026-10-21T13:31Z) + the helper's extra fields at their pre-activation values
    "freeRamMiB": 37618, "freeDiskMiB": 910702, "tcpListenOnStagePorts": 0, "udpOnStagePorts": 0, "listeners": [], "taskState": "Ready", "taskRealTriggers": 0,
    "taskPrincipal": "LOCAL SERVICE", "receiptLast": "complete", "receiptSha256": L.PINS["receiptSha256"], "receiptFilesMatch": 24, "receiptFilesBad": 0,
    "hostServicesJson": L.PINS["hostServicesJson"], "supervisorJson": L.PINS["supervisorJson"], "manifestSha256": L.PINS["manifestSha256"],
    "artifactsFiles": 0, "artifactsOther": 0, "artifactsBytes": 0, "hs2NodeProcesses": 0, "supervisorProcesses": 0, "node": "v24.16.0",
    "scripts": dict(SUMS), "staging": None, "stagingMarker": None, "sessionElevated": True}
def P(**kw): p = copy.deepcopy(BASE); p.update(kw); return p
def ev(p, phase, **kw): return L.evaluate(p, phase, local_sizes=LOCAL, script_sums=SUMS, **kw)
FULL = dict(LOCAL); FULL[L.MARKER] = 64
FILLED = dict(artifactsFiles=1872, artifactsBytes=sum(LOCAL.values()), staging=FULL, stagingMarker=L.PINS["manifestSha256"])

class Preflight(unittest.TestCase):
    def test_real_state_admits_dry_run_and_transfer_only(self):
        self.assertEqual(ev(BASE, "dry-run"), []); self.assertEqual(ev(BASE, "transfer"), [])
        self.assertTrue(any("staging copy is not complete" in x for x in ev(BASE, "fill")))
        r = ev(BASE, "start"); self.assertTrue(any("artifacts not filled" in x for x in r)); self.assertTrue(any("fill receipt" in x for x in r))
    def test_pin_drift_refuses_every_changing_phase_but_never_stop_or_rollback(self):
        drifts = {"receipt": dict(receiptSha256="0" * 64), "receipt file": dict(receiptFilesMatch=23, receiptFilesBad=1), "config": dict(hostServicesJson="1" * 64),
                  "supervisor": dict(supervisorJson="2" * 64), "manifest": dict(manifestSha256="3" * 64), "trigger added": dict(taskRealTriggers=1),
                  "principal": dict(taskPrincipal="SYSTEM"), "old node": dict(node="v20.11.0"), "script": dict(scripts={**SUMS, "windows/start.ps1": "f" * 64})}
        for name, d in drifts.items():
            for ph in ("dry-run", "transfer", "fill", "start", "cleanup"):
                self.assertTrue(ev(P(**d), ph), f"{name} must refuse {ph}")
            self.assertEqual(ev(P(**d), "stop"), [], f"{name} must not block stop"); self.assertEqual(ev(P(**d), "rollback"), [], f"{name} must not block rollback")
        for ph in L.PHASES: self.assertTrue(ev(P(sessionElevated=False), ph), "not elevated refuses every phase")
    def test_transfer_guards(self):
        self.assertTrue(ev(P(taskState="Running"), "transfer")); self.assertEqual(ev(P(taskState="Running"), "dry-run"), [], "dry-run reports, never refuses on a running stage")
        self.assertTrue(any("not this helper's" in x for x in ev(P(staging={"x.bin": 1}, stagingMarker=""), "transfer")))
        self.assertTrue(any("not snapshot objects" in x for x in ev(P(staging={L.MARKER: 64, "evil.exe": 9}, stagingMarker=L.PINS["manifestSha256"]), "transfer")))
        tight = (16 * 1024) + (sum(LOCAL.values()) >> 20)        # MiB: exactly the floor + the copy, rounded down -> refuse
        self.assertTrue(any("free disk" in x for x in ev(P(freeDiskMiB=tight - 1), "transfer")))
    def test_fill_guards(self):
        ok = P(staging=FULL, stagingMarker=L.PINS["manifestSha256"])
        self.assertEqual(ev(ok, "fill"), [])
        part = dict(FULL); part.pop(next(iter(LOCAL)))
        self.assertTrue(ev(P(staging=part, stagingMarker=L.PINS["manifestSha256"]), "fill"))
        self.assertTrue(ev(P(staging=FULL, stagingMarker=L.PINS["manifestSha256"], taskState="Running"), "fill"))
        self.assertTrue(any("free disk" in x for x in ev(P(staging=FULL, stagingMarker=L.PINS["manifestSha256"], freeDiskMiB=16 * 1024), "fill")))
    def test_start_guards(self):
        self.assertEqual(ev(P(**FILLED), "start", fill_done=True), [])
        for name, d, fd in [("no fill receipt", {}, False), ("temporaries", dict(artifactsOther=1), True), ("port busy", dict(tcpListenOnStagePorts=1), True),
                            ("udp busy", dict(udpOnStagePorts=1), True), ("low ram", dict(freeRamMiB=1000), True), ("running", dict(taskState="Running"), True),
                            ("leftover process", dict(hs2NodeProcesses=1), True), ("partial", dict(artifactsFiles=1871), True)]:
            self.assertTrue(ev(P(**{**FILLED, **d}), "start", fill_done=fd), name)
    def test_cleanup_guards(self):
        self.assertEqual(ev(P(**FILLED), "cleanup"), [])
        self.assertTrue(ev(P(**{**FILLED, "artifactsFiles": 10}), "cleanup"), "the staging copy is still the only full source")
        self.assertTrue(ev(P(**{**FILLED, "stagingMarker": "x"}), "cleanup"))

class Transfer(unittest.TestCase):
    def test_plan(self):
        self.assertEqual(len(L.plan_transfer(LOCAL, None, None)[0]), 1872)
        partial = {n: s for i, (n, s) in enumerate(LOCAL.items()) if i % 3}; partial[next(iter(LOCAL))] = 1   # missing third + one truncated
        to_send, refs = L.plan_transfer(LOCAL, {**partial, L.MARKER: 64}, L.PINS["manifestSha256"])
        self.assertEqual(refs, []); self.assertEqual(set(to_send), {n for n in LOCAL if partial.get(n) != LOCAL[n]})
        self.assertEqual(L.plan_transfer(LOCAL, FULL, L.PINS["manifestSha256"]), ([], []))
        self.assertTrue(L.staging_complete(LOCAL, FULL, L.PINS["manifestSha256"])); self.assertFalse(L.staging_complete(LOCAL, {**FULL, "x.tmp": 1}, L.PINS["manifestSha256"]))
    def test_staging_path_guard(self):
        self.assertTrue(L.staging_path_ok())
        for bad in (r"C:\ProgramData\Enclave\host-services\hs2\data", r"C:\ProgramData\Enclave\staging", r"C:\ProgramData\Enclave\staging\hs2-artifacts-20261021\..\x",
                    r"C:\Program Files\Enclave\x", r"D:\ProgramData\Enclave\staging\hs2-artifacts-20261021"):
            self.assertFalse(L.staging_path_ok(bad), bad)

ART = {"manifestSha256": L.PINS["manifestSha256"], "objects": 936, "kept": 0, "copied": 1872, "fetched": 0, "missing": []}
class Fill(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(L.validate_fill(0, ART, 0, {"state": "unanchored", "wrote": None}, 1872), [])
        self.assertEqual(L.validate_fill(0, {**ART, "kept": 1000, "copied": 872}, 0, {"state": "anchored", "wrote": "C:\\ProgramData\\Enclave\\host-services\\hs2\\data\\policy-import\\ab.json"}, 1872), [])
    def test_refusals(self):
        for name, args in {"art rc": (3, ART, 0, {"state": "unanchored", "wrote": None}, 1872), "missing": (0, {**ART, "missing": ["x.bin"], "copied": 1871}, 0, {"state": "unanchored", "wrote": None}, 1871),
                           "fetched": (0, {**ART, "fetched": 1, "copied": 1871}, 0, {"state": "unanchored", "wrote": None}, 1872), "manifest": (0, {**ART, "manifestSha256": "0"}, 0, {"state": "unanchored", "wrote": None}, 1872),
                           "count": (0, ART, 0, {"state": "unanchored", "wrote": None}, 1871), "pol rc": (0, ART, 3, None, 1872), "unanchored wrote": (0, ART, 0, {"state": "unanchored", "wrote": "x"}, 1872),
                           "anchored elsewhere": (0, ART, 0, {"state": "anchored", "wrote": "C:\\Windows\\x.json"}, 1872), "weird state": (0, ART, 0, {"state": "torn"}, 1872), "no json": (0, None, 0, None, 1872)}.items():
            self.assertTrue(L.validate_fill(*args), name)
        self.assertTrue(L.validate_fill(0, ART, 0, {"state": "unanchored", "wrote": None}, 1872, 2), "temporaries")

H6 = ["PASS  gate: platform host policy admits this host now  {...not-activated}", "PASS  directory-replica /health", "PASS  bootstrap-replica serves the manifest",
      "PASS  route-dns answers SOA and NS", "PASS  route-dns answers 4 static platform label(s)", "PASS  policy-mirror /health"]
LST = [("tcp", "127.0.0.1", 18188), ("tcp", "127.0.0.1", 18189), ("udp", "127.0.0.1", 18153), ("tcp", "127.0.0.1", 18153), ("tcp", "127.0.0.1", 18154), ("tcp", "127.0.0.1", 18190)]
class Start(unittest.TestCase):
    def test_ok(self): self.assertEqual(L.validate_start(0, H6, LST, "Running"), [])
    def test_refusals(self):
        self.assertTrue(L.validate_start(2, H6, LST, "Running")); self.assertTrue(L.validate_start(0, H6[:5], LST, "Running"))
        self.assertTrue(L.validate_start(0, H6 + ["FAIL  gate: ..."], LST, "Running")); self.assertTrue(L.validate_start(0, H6, LST, "Ready"))
        self.assertTrue(L.validate_start(0, H6, LST[:2] + LST[3:], "Running"), "udp dns missing")
        for a in ("0.0.0.0", "::", "192.168.1.20"):
            r = L.validate_start(0, H6, LST + [("tcp", a, 18190)], "Running"); self.assertTrue(any("NOT LOOPBACK-ONLY" in x for x in r), a)
    def test_tool_json(self):
        log = "ok a.bin\r\nok a.car\r\n{\r\n  \"objects\": 936,\r\n  \"missing\": [],\r\n  \"nested\": {\r\n    \"x\": 1\r\n  }\r\n}\r\n"
        self.assertEqual(L.parse_tool_json(log), {"objects": 936, "missing": [], "nested": {"x": 1}}); self.assertIsNone(L.parse_tool_json("MISSING x\nboom"))

# ---- orchestration: the real main() with the SSH/scp layer stubbed ----
def load_helper(tmp):
    shutil.copy(HERE / "hs2lib.py", tmp / "hs2lib.py")
    spec = importlib.util.spec_from_file_location("helper", HERE / "root-hs2-activate.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    m.HERE = tmp; m.local_pins = lambda: (SUMS, LOCAL); return m
class Orchestration(unittest.TestCase):
    def setUp(self): self.tmp = pathlib.Path(tempfile.mkdtemp(dir=str(HERE / "tmp"))); self.m = load_helper(self.tmp); self.calls = []
    def run_main(self, argv, probes, ps_results):
        probes = list(probes); ps_results = list(ps_results)
        self.m.probe = lambda: copy.deepcopy(probes.pop(0) if len(probes) > 1 else probes[0])
        def ps(script, seconds): self.calls.append(script); return ps_results.pop(0) if ps_results else (0, {}, "")
        self.m.ps = ps
        sys.argv = ["x"] + argv
        with self.assertRaises(SystemExit) as c: self.m.main()
        return c.exception.code, sorted((self.tmp / "receipts").glob("*.json"))[-1]
    def test_drift_refuses_with_exit_2_and_no_remote_action(self):
        code, _ = self.run_main(["--transfer"], [P(receiptSha256="0" * 64)], []); self.assertEqual(code, 2); self.assertEqual(self.calls, [])
    def test_failed_start_is_always_stopped(self):
        pre = P(**FILLED); (self.tmp / "receipts").mkdir(); (self.tmp / "receipts" / "fill-x.json").write_text(json.dumps({"exit": 0}))
        running_bad = P(**{**FILLED, "taskState": "Running", "listeners": LST})
        quiet = P(**FILLED)
        code, rec = self.run_main(["--start"], [pre, running_bad, quiet], [(0, {"startRc": 2, "healthRc": 2, "health": H6[:5] + ["FAIL  gate"]}, ""), (0, {"stopRc": 0}, "")])
        self.assertEqual(code, 3); self.assertTrue(any("stop.ps1" in c for c in self.calls), "stop.ps1 must run after a failed start")
        code, rec = self.run_main(["--start"], [pre, running_bad, running_bad], [(0, {"startRc": 2, "health": []}, ""), (0, {"stopRc": 1}, "")])
        self.assertEqual(code, 4, "a stop that leaves listeners is CRITICAL")
    def test_exposed_listener_after_healthy_start_is_stopped(self):
        pre = P(**FILLED); (self.tmp / "receipts").mkdir(); (self.tmp / "receipts" / "fill-x.json").write_text(json.dumps({"exit": 0}))
        exposed = P(**{**FILLED, "taskState": "Running", "listeners": LST + [("tcp", "0.0.0.0", 18188)]})
        code, rec = self.run_main(["--start"], [pre, exposed, P(**FILLED)], [(0, {"startRc": 0, "healthRc": 0, "health": H6}, ""), (0, {"stopRc": 0}, "")])
        self.assertEqual(code, 3); self.assertIn("NOT LOOPBACK-ONLY", rec.read_text())
    def test_healthy_start(self):
        pre = P(**FILLED); (self.tmp / "receipts").mkdir(); (self.tmp / "receipts" / "fill-x.json").write_text(json.dumps({"exit": 0}))
        code, _ = self.run_main(["--start"], [pre, P(**{**FILLED, "taskState": "Running", "listeners": LST})], [(0, {"startRc": 0, "healthRc": 0, "health": H6}, "")])
        self.assertEqual(code, 0); self.assertFalse(any("stop.ps1" in c for c in self.calls))
    def test_start_refused_without_fill_receipt(self):
        code, _ = self.run_main(["--start"], [P(**FILLED)], []); self.assertEqual(code, 2); self.assertEqual(self.calls, [])
    def test_incomplete_fill_exits_3_and_never_starts(self):
        pre = P(staging=FULL, stagingMarker=L.PINS["manifestSha256"])
        art = json.dumps({**ART, "missing": ["x.car"], "copied": 1871}, indent=2)
        code, _ = self.run_main(["--fill"], [pre, P(**{**FILLED, "artifactsFiles": 1871})], [(0, {"artRc": 3, "art": art, "polRc": 0, "pol": json.dumps({"state": "unanchored", "wrote": None}, indent=2)}, "")])
        self.assertEqual(code, 3); self.assertFalse(any("start.ps1" in c for c in self.calls))
    def test_complete_fill(self):
        pre = P(staging=FULL, stagingMarker=L.PINS["manifestSha256"])
        code, _ = self.run_main(["--fill"], [pre, P(**FILLED)], [(0, {"artRc": 0, "art": json.dumps(ART, indent=2), "polRc": 0, "pol": json.dumps({"state": "unanchored", "wrote": None}, indent=2)}, "")])
        self.assertEqual(code, 0); self.assertIn("--from-dir','" + L.STAGING, self.calls[0]); self.assertNotIn("from-origin", self.calls[0])
    def test_transfer_scp_failure_is_resumable_exit_3(self):
        import subprocess
        orig = subprocess.run
        self.m.subprocess.run = lambda *a, **k: type("R", (), {"returncode": 1, "stderr": "lost connection", "stdout": ""})()
        try:
            code, _ = self.run_main(["--transfer"], [P(staging={L.MARKER: 64}, stagingMarker=L.PINS["manifestSha256"])], [])
        finally: self.m.subprocess.run = orig
        self.assertEqual(code, 3)
    def test_remote_scripts_fit_and_are_bound(self):
        self.assertNotIn("@STAGE@", self.m.PROBE); self.assertNotIn("@STAGING@", self.m.PROBE); self.assertNotIn("@SCRIPTS@", self.m.PROBE)
        import base64
        full = self.m.WATCH.replace("@MS@", "120000") + self.m.PROBE
        self.assertLess(len(base64.b64encode(full.encode("utf-16le"))), 30000)

if __name__ == "__main__":
    unittest.main()
