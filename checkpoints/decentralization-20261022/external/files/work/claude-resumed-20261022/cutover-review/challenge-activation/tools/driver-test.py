"""Offline tests of root-challenge-activation.py (m.ps faked by text shape; any ssh/scp attempt fails the test)."""
import base64, importlib.util, json, pathlib, re, shutil, subprocess, sys, tempfile, time, unittest
A = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("drv", A / "root-challenge-activation.py"); D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)
REAL_RUN = subprocess.run
def good(**over):
    idn = {"at": D.now(), "cmd": [{"pid": 900, "start": "2026-10-22T03:38:00.0000000Z"}], "agent": [{"pid": 901, "parent": 900, "start": "2026-10-22T03:38:01.0000000Z"}],
           "privacy": [{"pid": 13932, "start": "2026-10-22T03:37:14.0971470Z"}], "manager": "35464@x", "vms": "a", "hyperv": "b", "wg": 1, "tasks": []}
    upd = {"update": {"state": "Ready", "enabled": True, "next": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime(time.time() + 7200))}}
    ch = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cfg": "c" * 64, "enKeys": ["relay", "checkers", "paceMbps", "walletAdmission"], "chainRpc": D.RPC5,
          "cfgAcl": "O:SYG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)", "ports": {"18353": "absent", "18354": "absent", "18292": "absent", "31053": "absent"}, "hs2": D.HS2_CONFIG,
          "release": {"dns": D.RELEASE["dnsSha256"], "runtime": D.RELEASE["runtimeBundleSha256"]}, "declDir": True, "decl": "absent", "netLog": 10, "nodeExe": D.NODE_SHA,
          "policyUnavailable30min": 0, "statusAgeMs": 300, "statusRunner": D.RUNNER, "egressApps": 9}
    for k, v in over.items():
        tgt = idn if k in idn else upd if k == "update" else ch
        if k == "update": upd["update"] = v
        else: tgt[k] = v
    return idn, upd, ch
class Fake:
    def __init__(self, idn, upd, ch, journal=None): self.idn, self.upd, self.ch, self.journal, self.texts = idn, upd, ch, journal, []
    def ps(self, text, secs=150):
        assert D.load_transport  # noqa
        self.texts.append(text)
        if "$o.ports=[ordered]@{}" in text: return {k: v for k, v in self.ch.items() if k not in ("at", "cfg", "enKeys", "chainRpc", "cfgAcl")}
        if "$o.enKeys=" in text: return {k: self.ch[k] for k in ("at", "cfg", "enKeys", "chainRpc", "cfgAcl")}
        if "$o.update=$(try{" in text: return self.upd
        if "$o.cmd=@(" in text: return self.idn
        if "New-Item -ItemType Directory" in text: return {"created": re.search(r"\$d='([^']*)'", text).group(1)}
        if "foreach($f in @(" in text: return {n: h for n, (_, h) in D.STAGED.items()}
        if "Register-ScheduledTask" in text: return {"decision": "started", "state": "Running"}
        if "$j=" in text: return self.journal or {"lines": ['{"step":"backup","sha":"c","backup":"C:\\\\s\\\\private\\\\b"}', '{"step":"config","after":"' + "d" * 64 + '"}', '{"final":"DONE: test"}'], "task": "unregistered after final"}
        return {"error": "unexpected text"}
class T(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()); D.OUT = self.tmp; self.up = []
        def guard(argv, **k):
            if argv and argv[0] == "timeout" and "scp" in argv: self.up.append(argv); return type("r", (), {"returncode": 0, "stderr": ""})()
            if any(str(x) in ("ssh", "scp") for x in argv): raise AssertionError("a test tried to reach minipc")
            return REAL_RUN(argv, **k)
        D.subprocess.run = guard; D.time.sleep = lambda s: None
        self.ctl = self.tmp / "control.json"; self.ctl.write_text(json.dumps({"journal": {"lines": ['{"final":"DONE: ok"}']}}))
    def tearDown(self): shutil.rmtree(self.tmp); D.subprocess.run = REAL_RUN
    def fake(self, f): D.load_transport = lambda: type("m", (), {"ps": staticmethod(f.ps)})()
    def pre(self, f, extra=()):
        self.fake(f); rc = D.main(["--preflight-read", "--control-receipt", str(self.ctl), *extra]); return rc, json.loads(max(self.tmp.glob("preflight-*.json"), key=lambda x: x.stat().st_mtime_ns).read_text())
    def test_plan_only_makes_no_call(self):
        D.load_transport = lambda: (_ for _ in ()).throw(AssertionError("network in plan mode")); self.assertEqual(D.main([]), 0)
    def test_reused_texts_are_the_pinned_driver_exactly(self):
        sys.dont_write_bytecode = True
        tmpd = self.tmp / "copy"; tmpd.mkdir(); src = tmpd / "x.py"; src.write_text(D.REUSE[0].read_text().replace("MANIFEST_SHA, FILES, GROUPS, KEEP, OBSERVE = _manifest()", "MANIFEST_SHA, FILES, GROUPS, KEEP, OBSERVE = ('', {}, {}, {}, [])", 1).replace(
            'W = next(p for p in PKG.parents if (p / "nucbox-tls-20261021").is_dir())', "W = pathlib.Path('/')", 1))
        sp = importlib.util.spec_from_file_location("orig", src); mod = importlib.util.module_from_spec(sp); sp.loader.exec_module(mod)
        for k in ("U", "IDN", "UPD", "LOADER", "LAUNCH", "JOURNAL"): self.assertEqual(D.R[k], getattr(mod, k), k)
        self.assertEqual(D.sha(D.REUSE[0]), "1d1b995c134373c0d5e72a8a3ca83a5726595d3d7d1de0a8e4cfc08ca8f69f0a")
    def test_every_remote_text_fits_the_transport(self):
        m = D.load_transport.__globals__ if False else None
        import importlib; tr = importlib.util.spec_from_file_location("tr", D.TRANSPORT[0]); mm = importlib.util.module_from_spec(tr); tr.loader.exec_module(mm)
        enc = lambda t, s: len(base64.b64encode((mm.HEAD.replace("SECS", str(s)) + t).encode("utf-16-le")))
        loader = D.R["LOADER"].replace("PS1X", D.STAGING + "\\chact-0123456789ab\\chact.ps1").replace("PSHA", "a" * 64).replace("PFX", D.STAGING + "\\chact-0123456789ab\\p-20261022t040000z-abcdef-rb.json").replace("PFSHA", "b" * 64).replace("MODEX", "rollback")
        texts = {"CH": (D.CH, 90), "CH2": (D.CH2, 120), "IDN": (D.R["IDN"], 120), "UPD": (D.R["UPD"], 60), "VERIFY": (D.VERIFY.replace("SX", "'" + D.STAGING + "\\chact-0123456789ab'").replace("NAMESX", ",".join("'" + n + "'" for n in D.STAGED)), 60),
                 "LAUNCH": (D.R["LAUNCH"].replace("TNX", "'chal-act-20261022t040000z-abcdef-rb'").replace("ENCX", base64.b64encode(loader.encode("utf-16-le")).decode()), 90)}
        for k, (t, s) in texts.items(): self.assertLessEqual(enc(t, s), 7600, k)
        self.assertNotIn("proofKey", D.CH, "the declaration's proof key is never read out")
    def test_preflight_passes_on_the_expected_post_cutover_state(self):
        rc, p = self.pre(Fake(*good())); self.assertEqual((rc, p["refusals"]), (0, []))
    def test_refusals(self):
        cases = [({"chainRpc": D.RPC5[:3]}, "not the 5"), ({"enKeys": ["relay", "walletAdmission", "paceMbps"]}, "walletAdmission is not configured last"),
                 ({"enKeys": ["relay", "challengeReplica", "walletAdmission"]}, "already configured"), ({"enKeys": ["relay", "hostServices", "walletAdmission"]}, "hostServices block exists"),
                 ({"hs2": "0" * 64}, "root-hs2-parallel.py --execute first"), ({"release": {"dns": "0", "runtime": "0"}}, "release is not the pinned"),
                 ({"declDir": False}, "declaration directory is missing"), ({"decl": {"state": "serving", "pid": 1}}, "serving declaration already exists"),
                 ({"ports": {"18353": {"pid": 5, "name": "node.exe"}, "18354": "absent", "18292": "absent", "31053": "absent"}}, "18353 (dns) is in use"),
                 ({"ports": {"18353": "absent", "18354": "absent", "18292": "absent", "31053": {"pid": 6, "name": "python.exe"}}}, "other than sshd"),
                 ({"policyUnavailable30min": 1}, "P0 gate"), ({"statusRunner": "0x0"}, "not enforcing this runner"), ({"cfgAcl": "O:SYG:SYD:(A;;FA;;;SY)"}, "not auto-inherited"),
                 ({"nodeExe": "absent"}, "root-proven"), ({"update": {"state": "Queued", "enabled": True, "next": "2030-01-01T00:00:00Z"}}, "runs or is due"),
                 ({"update": "unreadable"}, "absent or unreadable"), ({"privacy": []}, "not exactly one")]
        for over, why in cases:
            rc, p = self.pre(Fake(*good(**over))); self.assertEqual(rc, 2, over); self.assertTrue(any(why in r for r in p["refusals"]), (over, p["refusals"]))
        sshd = good(ports={"18353": "absent", "18354": "absent", "18292": "absent", "31053": {"pid": 7, "name": "sshd.exe"}}); rc, p = self.pre(Fake(*sshd)); self.assertEqual(p["refusals"], [])
    def test_control_gate(self):
        self.ctl.write_text(json.dumps({"journal": {"lines": ['{"final":"DONE_CHECK: post failed"}']}}))
        rc, p = self.pre(Fake(*good())); self.assertTrue(any("not DONE" in r for r in p["refusals"]))
        rc, p = self.pre(Fake(*good()), ["--accept-control-check"]); self.assertEqual(p["refusals"], [])
        self.fake(Fake(*good())); D.main(["--preflight-read"]); p = json.loads(max(self.tmp.glob("preflight-*.json"), key=lambda x: x.stat().st_mtime_ns).read_text())
        self.assertTrue(any("--control-receipt" in r for r in p["refusals"]))
    def stage(self, f):
        rc, p = self.pre(f); pp = max(self.tmp.glob("preflight-*.json"), key=lambda x: x.stat().st_mtime_ns); self.assertEqual(D.main(["--stage", "--preflight", str(pp)]), 0)
        return pp, max(self.tmp.glob("stage-*.json"), key=lambda x: x.stat().st_mtime_ns)
    def test_stage_uploads_the_4_pinned_files_once(self):
        f = Fake(*good()); pp, sp = self.stage(f); self.assertEqual(len(self.up), 4); rec = json.loads(sp.read_text()); self.assertTrue(rec["ok"]); self.assertTrue(rec["stage"].startswith(D.STAGING + "\\chact-"))
        self.assertTrue(list(self.tmp.glob("attempt-stage-*.json")))
    def test_apply_params_cover_every_key_the_script_reads_and_rollback_uses_the_journal(self):
        f = Fake(*good()); pp, sp = self.stage(f); self.assertEqual(D.main(["--apply", "--stage-receipt", str(sp), "--preflight", str(pp)]), 0)
        r0p = sorted(self.tmp.glob("apply-result-*.json"))[0]; r0 = json.loads(r0p.read_text()); params = r0["params"]
        used = set(re.findall(r"\$PRM\.([A-Za-z0-9]+)", (A / "challenge-activate.ps1").read_text())) - {"testRoot", "testNode", "before"}
        self.assertEqual(sorted(used - set(params)), []); self.assertEqual(params["cfgSha"], "c" * 64); self.assertEqual(params["privacy"]["pid"], 13932)
        launch = [t for t in f.texts if "Register-ScheduledTask" in t][0]; self.assertIn("\\EnclaveOps\\", launch)
        enc = re.search(r"-EncodedCommand ([A-Za-z0-9+/=]+)", launch).group(1); loader = base64.b64decode(enc).decode("utf-16-le")
        self.assertIn(D.STAGED["chact.ps1"][1], loader); self.assertIn("-Mode 'apply'", loader)
        self.assertEqual(D.main(["--rollback", r0["runId"], "--stage-receipt", str(sp), "--preflight", str(pp)]), 3, "the fake journal's final is DONE, not ROLLED_BACK")
        rb = json.loads(sorted(self.tmp.glob("rollback-result-*.json"))[0].read_text())["params"]
        self.assertEqual(rb["before"], {"cfg": {"before": "c" * 64, "after": "d" * 64, "backup": "C:\\s\\private\\b"}}); self.assertEqual(rb["runId"], r0["runId"] + "-rb")
        self.assertFalse(D.attempt(f"attempt-apply-{r0['runId']}.json", {}), "never twice")
    def test_refused_apply_sends_no_mutation(self):
        f = Fake(*good()); pp, sp = self.stage(f); n0 = len(f.texts); f.ch["hs2"] = "0" * 64
        rc, p = self.pre(f); pp2 = max(self.tmp.glob("preflight-*.json"), key=lambda x: x.stat().st_mtime_ns); n1 = len(f.texts)
        self.assertEqual(D.main(["--apply", "--stage-receipt", str(sp), "--preflight", str(pp2)]), 2); self.assertEqual(len(f.texts), n1, "no remote text after a refusal")
        self.assertEqual(list(self.tmp.glob("attempt-apply-*")), [])
    def test_stale_preflight_and_foreign_stage_refuse(self):
        f = Fake(*good()); pp, sp = self.stage(f)
        o = json.loads(pp.read_text()); o["at"] = "2026-01-01T00:00:00Z"; pp.write_text(json.dumps(o))
        with self.assertRaises(SystemExit): D.main(["--apply", "--stage-receipt", str(sp), "--preflight", str(pp)])
        s = json.loads(sp.read_text()); s["verify"]["chact.ps1"] = "0" * 64; sp.write_text(json.dumps(s))
        with self.assertRaises(SystemExit): D.main(["--status", "--stage-receipt", str(sp), "--run-id", "x"])
if __name__ == "__main__": unittest.main()
