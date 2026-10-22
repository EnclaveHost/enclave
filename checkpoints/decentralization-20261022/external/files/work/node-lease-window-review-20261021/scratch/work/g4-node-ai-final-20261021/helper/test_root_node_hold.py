#!/usr/bin/env python3
"""Offline tests of root-node-hold.py (no remote call: m.ps and scp are faked). python3 -m unittest test_root_node_hold
G4 final package: + the G-UPD / N3 / pinned-node.exe preflight gates, the NEW ingress (absent-before PUT, removed by UNPUT on
rollback, network order ingress -> privacy -> worker and back), the node.exe in the cutover params."""
import base64, importlib.util, json, pathlib, shutil, sys, tempfile, time, unittest, glob
H = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("rnh", H / "root-node-hold.py"); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
import subprocess as _sp; REAL_RUN = _sp.run
PROBE = json.load(open(sorted(glob.glob(str(H.parent / "probe/out-*.json")))[-1]))

def enc_len(text):
    return len(base64.b64encode((R.m.HEAD.replace("SECS", "240") + text).encode("utf-16-le")))

class Fake:
    """canned answers by the text's shape; records every text"""
    def __init__(self, idn, fil, cov, launch=None, journal=None): self.idn, self.fil, self.cov, self.launch, self.journal, self.texts = idn, fil, cov, launch, journal, []
    def ps(self, text, secs=150):
        self.texts.append(text)
        if "cfgAcl=(Get-Acl" in text: return {k: self.idn.get(k) for k in ("cfgAcl", "localAcl")}   # the ACLS read (SDDL only)
        if "$o.cmd=@(" in text: return {k: v for k, v in self.idn.items() if k in ("cmd", "agent", "privacy", "manager", "vms", "wg", "tasks", "hyperv")}
        if "$o.runNode=" in text: return {k: v for k, v in self.idn.items() if k not in ("cmd", "agent", "privacy", "manager", "vms", "wg", "tasks", "hyperv")}
        if "$o.apps=@(" in text: return self.cov
        if "foreach($x in @(" in text: return self.fil
        if "Register-ScheduledTask" in text: return self.launch or {"decision": "started", "state": "Running"}
        if "bundle-swap.ps1" in text: return {"decision": "rolled back" if "Mode='rollback'" in text else "applied"}
        if "$pv=" in text: return {"decision": "applied" if "staged=FileSha $s" in text else "rolled back"}      # PUT / UNPUT
        if "$j=" in text: return self.journal or {"lines": ['{"final":"DONE: test"}'], "task": "unregistered after final"}
        return {"error": "unexpected text"}

def live_like():
    s, n = PROBE["state"], PROBE["network"]
    cmd_pid, cmd_start = 23976, "2026-10-21T15:01:03.5900000Z"; a = s["agent"][0].split("@"); pa = s["privacy"][0].split("@")
    vms = ",".join(sorted(s["vms"]))                                   # probe: id|name|status (the script's Vms() format)
    hyperv = ",".join(sorted(f"0000000{n}-1111-2222-3333-444444444444|vm{n}|Running" for n in range(len(s["vms"]))))
    idn = {"cmd": [{"pid": cmd_pid, "start": cmd_start}], "agent": [{"pid": int(a[0]), "parent": cmd_pid, "start": a[1].split("<")[0]}],
           "privacy": [{"pid": int(pa[0]), "start": pa[1].split("<")[0]}], "manager": s["manager"], "vms": vms, "wg": s["wg"], "tasks": [],
           "runNode": s["run-node.cmd"], "local": s["node-config.local.cmd"], "flag": False, "cfg": n["cfgSha"], "enKeys": n["enKeys"], "wallet": "absent",
           "statusAgeMs": 800, "statusWallet": None, "egressApps": 9, "hyperv": hyperv, "netWriters": ["S-1-5-18", "S-1-5-32-544"],
           # G4 final package: the read-only gates (G-UPD, N3, the root-proven node.exe)
           "at": R.now(), "netReaders": ["S-1-5-18", "S-1-5-32-544"], "pdInheritReaders": ["S-1-5-18", "S-1-5-32-544"], "nodeExe": R.NODE_SHA, "runtimeNodeExe": "9" * 64,
           "update": {"state": "Ready", "next": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime(time.time() + 7200))},
           "cfgAcl": "O:SYG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)", "localAcl": "O:SYG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)"}   # AI precondition: live forms (fixture 22:28Z / cron preflight 14:17Z)
    fil = {v[1]: v[3] for v in R.FILES.values()} | {p: h for p, h in R.KEEP.items()}
    recs = [dict(r, leaseUntil=9999999999) for r in n["records"]]
    cov = {"apps": [dict(a, configCidString=True) for a in n["apps"]], "records": recs, "policyUnavailable30min": 0}
    return idn, fil, cov

class T(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()); R.OUT = self.tmp
        R.verify_local()                                   # loads the real transport ONCE; every test then replaces m.ps
        real = REAL_RUN
        def guard(argv, **k):                              # NOTHING may reach minipc from a test
            if any(str(a) in ("ssh", "scp") for a in argv) and not getattr(R.subprocess, "fake_scp", False): raise AssertionError("a test tried to reach minipc: " + " ".join(map(str, argv[:3])))
            return real(argv, **k)
        R.subprocess.run = guard; R.m.subprocess.run = guard; R.m.ps = lambda *a, **k: (_ for _ in ()).throw(AssertionError("unfaked m.ps"))
    def tearDown(self): shutil.rmtree(self.tmp); R.subprocess.run = REAL_RUN
    def test_local_pins_and_every_remote_text_fits(self):
        R.verify_local()                                                     # every file, script and transport pin matches
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov); R.m.ps = f.ps; R.preflight()
        texts = f.texts + [R.PUT.replace("TX", R.q(R.FILES["wallet"][1])).replace("SX", R.q("C:\\x\\" + "f" * 80)).replace("OX", R.q("absent")).replace("NX", R.q("a" * 64)).replace("PX", R.q("C:\\x\\p")),
                           R.UNPUT.replace("TX", R.q(R.FILES["host"][1])).replace("OX", R.q("a" * 64)).replace("NX", R.q("b" * 64)).replace("PX", R.q("C:\\x\\p")),
                           R.AGENT.replace("PIDX", "12345").replace("STARTX", R.q("2026-10-21T00:05:03.7361540Z"))]
        loader = R.LOADER.replace("PS1X", "C:\\ProgramData\\Enclave\\staging\\nodehold-0123456789ab\\node-hold-cutover.ps1").replace("PSHA", "a" * 64) \
            .replace("PFX", "C:\\ProgramData\\Enclave\\staging\\nodehold-0123456789ab\\params-20261021t230000z-abcdef-rb.json").replace("PFSHA", "b" * 64) \
            .replace("MODEX", "rollback")
        texts.append(R.LAUNCH.replace("TNX", R.q("node-hold-20261021t230000z-abcdef-rb")).replace("PS1Q", R.q("C:\\x\\node-hold-cutover.ps1")).replace("PFQ", R.q("C:\\x\\p.json"))
                     .replace("PSHA", "a" * 64).replace("PFSHA", "b" * 64).replace("ENCX", base64.b64encode(loader.encode("utf-16-le")).decode()))
        for t in texts: self.assertLessEqual(enc_len(t), 7900, t[:80])
    def test_coverage_from_the_live_probe(self):
        idn, fil, cov = live_like(); R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight()
        self.assertEqual(len(pre["coverage"]["expectedIds"]), 9, "every VM named by a deployment id, all running records")
        self.assertEqual(pre["coverage"]["blockers"], []); self.assertEqual(len(pre["coverage"]["staleEnrolledWithoutVm"]), 8)
        self.assertNotIn("shield-readiness-v1", pre["coverage"]["expectedIds"])
        self.assertEqual(R.cutover_refusals(pre), [], "the live shape with every file new passes")
    def test_refusals(self):
        cases = [("idn", "local", "0" * 64, "node-config.local.cmd"), ("idn", "flag", True, "names the flag"), ("idn", "wallet", "c" * 64, "already carries"),
                 ("idn", "statusAgeMs", 9000, "not fresh"), ("idn", "vms", "unavailable", "VM list"), ("idn", "runNode", "0" * 64, "run-node.cmd"),
                 ("idn", "hyperv", "unavailable", "Hyper-V"), ("idn", "netWriters", ["S-1-5-18", "S-1-5-11"], "network directory is writable"),
                 ("idn", "update", {"state": "Running", "next": None}, "Update task runs or is due"),
                 ("idn", "update", {"state": "Ready", "next": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime(time.time() + 600))}, "Update task runs or is due"),
                 ("idn", "update", None, "Update task state is unreadable"),
                 ("idn", "cfgAcl", "O:BAG:S-1-5-21-1-2-3-513D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)", "cfgAcl: the DACL is not auto-inherited"),
                 ("idn", "localAcl", "O:BAG:S-1-5-21-1-2-3-513D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)", "localAcl: the DACL is not auto-inherited"),
                 ("idn", "localAcl", None, "localAcl: the DACL is not auto-inherited (unreadable)"),
                 ("idn", "cfgAcl", "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)", "cfgAcl: the DACL is not auto-inherited"),
                 ("idn", "netReaders", ["S-1-5-18", "S-1-5-32-544", "S-1-5-32-545"], "readable by more than"),
                 ("idn", "pdInheritReaders", ["S-1-5-18", "S-1-5-32-544", "S-1-5-32-545"], "inherit READ"),
                 ("idn", "nodeExe", "absent", "root-proven node.exe")]
        for where, key, val, why in cases:
            idn, fil, cov = live_like(); dict(idn=idn)[where][key] = val; R.m.ps = Fake(idn, fil, cov).ps
            self.assertTrue(any(why in r for r in R.cutover_refusals(R.preflight())), key)
        idn, fil, cov = live_like(); fil[R.FILES["host"][1]] = R.FILES["host"][2]; R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("not all new" in r for r in R.cutover_refusals(R.preflight())))
        idn, fil, cov = live_like(); fil[list(R.KEEP)[0]] = "d" * 64; R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("enclave-wg" in r for r in R.cutover_refusals(R.preflight())), "a native binary change refuses")
        idn, fil, cov = live_like(); cov["records"] = [r for r in cov["records"] if r["id"] != "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238"]
        R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight()
        self.assertEqual(pre["coverage"]["blockers"], [{"id": "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238", "why": "no node record"}])
        idn, fil, cov = live_like(); cov["records"][2] = dict(cov["records"][2], appRef="catalog://0xABC/1"); R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("exact catalog form" in b["why"] for b in R.preflight()["coverage"]["blockers"]))
        idn, fil, cov = live_like(); cov["policyUnavailable30min"] = 1; R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("P0 gate" in r for r in R.cutover_refusals(R.preflight())))
        idn, fil, cov = live_like(); cov["records"][3] = dict(cov["records"][3], leaseUntil=0); assert cov["records"][3]["status"] == "running"; R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("P0 gate" in r for r in R.cutover_refusals(R.preflight())), "a running lease < 20 min refuses")
    def test_attempt_is_never_retried(self):
        self.assertTrue(R.attempt("attempt-x.json", {})); self.assertFalse(R.attempt("attempt-x.json", {}))
    def test_cutover_and_rollback_params_end_to_end_with_fakes(self):
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov); R.m.ps = f.ps
        pre = R.preflight(); pp = self.tmp / "pre.json"; pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": "C:\\ProgramData\\Enclave\\staging\\nodehold-0123456789ab", "ok": True}))
        up = []; R.subprocess.run = lambda a, **k: (up.append(a), type("r", (), {"returncode": 0, "stderr": ""})())[1]
        R.time.sleep = lambda s: None
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 2, "no restart-agent receipt for the running agent")
        (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES["privacy"][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
        rc = R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]); self.assertEqual(rc, 0)
        res = sorted(self.tmp.glob("cutover-result-*.json")); self.assertEqual(len(res), 1)
        params = json.loads(res[0].read_text())["params"]
        self.assertEqual(params["expectedIds"], pre["coverage"]["expectedIds"]); self.assertEqual(params["vms"], idn["vms"]); self.assertEqual(params["localSha"], R.LOCAL_CFG)
        launch = [t for t in f.texts if "Register-ScheduledTask" in t][0]; self.assertIn("\\EnclaveOps\\", launch); self.assertNotIn("TaskPath '\\Enclave\\'", launch)
        # the journal of that run, with its backup/flag/config steps -> the rollback params restore EXACTLY those
        run = json.loads(res[0].read_text())["runId"]; r0 = json.loads(res[0].read_text())
        r0["journal"] = {"lines": [json.dumps({"step": "backups", "localBackup": "C:\\s\\private\\l", "cfgBackup": "C:\\s\\private\\c"}), json.dumps({"step": "flag", "after": "e" * 64}),
                                   json.dumps({"step": "config", "after": "f" * 64}), json.dumps({"final": "DONE: test"})]}
        res[0].write_text(json.dumps(r0)); pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        rc = R.main(["--rollback-cutover", run, "--stage-receipt", str(sp), "--preflight", str(pp)])
        rb = json.loads((self.tmp / f"rollback-result-{run}-rb.json").read_text())["params"]["before"]
        self.assertEqual(rb, {"local": {"before": R.LOCAL_CFG, "after": "e" * 64, "backup": "C:\\s\\private\\l"}, "cfg": {"before": idn["cfg"], "after": "f" * 64, "backup": "C:\\s\\private\\c"}})
        self.assertFalse(R.attempt(f"attempt-cutover-{run}.json", {}), "the same run id is never attempted twice")
        self.assertEqual(json.loads(res[0].read_text())["params"]["hyperv"], idn["hyperv"], "the Hyper-V identity is pinned into the run")
        self.assertEqual((params["nodeExe"], params["nodeSha"]), (R.NODE_EXE, R.NODE_SHA), "the config-edit node.exe is pinned into the hashed params")
    def test_g4_ingress_absent_before_order_and_rollback(self):
        idn, fil, cov = live_like(); ing = R.FILES["ingress"]
        self.assertEqual((ing[2], ing[4], R.GROUPS["network"]), ("absent", "put", ["ingress", "privacy", "worker"]))
        fil[ing[1]] = "absent"; R.m.ps = Fake(idn, fil, cov).ps
        self.assertEqual(R.preflight()["state"]["ingress"], "old", "absent before = old")
        fil[ing[1]] = "e" * 64; R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight()
        self.assertTrue(pre["state"]["ingress"].startswith("UNKNOWN"), "a foreign file at the path is never overwritten")
        self.assertTrue(any("not all new" in r for r in R.cutover_refusals(pre)))
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": "C:\\s", "ok": True}))
        for back, want in ((False, ["ingress", "privacy", "worker"]), (True, ["worker", "privacy", "ingress"])):
            f = Fake(idn, fil, cov); R.m.ps = f.ps
            self.assertEqual(R.main(["--rollback" if back else "--apply", "network", "--stage-receipt", str(sp)]), 0)
            order = [k for t in f.texts for k in ("ingress", "privacy", "worker") if R.q(R.FILES[k][1]) in t]
            self.assertEqual(order, want)
            ingress_text = [t for t in f.texts if R.q(R.FILES["ingress"][1]) in t][0]
            self.assertIn("$old=" + R.q("absent") + ";", ingress_text, "the CAS 'old' of the new file is absent")
            self.assertIn("if($old -eq 'absent'){Remove-Item -LiteralPath $t -Force}" if back else "if($old -eq 'absent'){[IO.File]::Move($tmp,$t)}", ingress_text,
                          "rollback (UNPUT) removes it; apply (PUT) moves it into place, never over a file")
            self.assertEqual("staged=FileSha $s" in ingress_text, not back)
    def test_recovery_required_is_never_success(self):
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov, journal={"lines": ['{"final":"RECOVERY_REQUIRED: the node flag was not restored"}'], "task": "unregistered after final"}); R.m.ps = f.ps
        pre = R.preflight(); pp = self.tmp / "pre.json"; pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": "C:\\s", "ok": True}))
        (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES["privacy"][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
        R.subprocess.run = lambda a, **k: type("r", (), {"returncode": 0, "stderr": ""})(); R.time.sleep = lambda s: None
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 3)
    def test_refused_cutover_sends_nothing(self):
        idn, fil, cov = live_like(); fil[R.FILES["privacy"][1]] = R.FILES["privacy"][2]; f = Fake(idn, fil, cov); R.m.ps = f.ps
        pre = R.preflight(); pp = self.tmp / "pre.json"; pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": "C:\\s", "ok": True})); n0 = len(f.texts)
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 2)
        self.assertEqual(len(f.texts), n0, "no remote text after a refusal"); self.assertEqual(list(self.tmp.glob("attempt-*")), [])
    def test_lease_deadline_gate_replaces_the_static_20_min(self):
        """LEASE DEADLINE proposal: shortLeases counts < LEASE_NEED_S (660), not < 1200; the cutover re-checks leaseFirstEnd NOW;
        the budget travels in the hashed params"""
        self.assertEqual((R.LEASE_NEED_S, R.LEASE), (660, {"marginSec": 180, "revertSec": 300, "forwardMinSec": 180, "startNodeSec": 150}))
        idn, fil, cov = live_like(); now = int(time.time()); ids = [r["id"] for r in cov["records"] if r["status"] == "running"]
        cov["records"] = [dict(r, leaseUntil=now + 900) for r in cov["records"]]; R.m.ps = Fake(idn, fil, cov).ps
        pre = R.preflight(); self.assertEqual(pre["gate"]["shortLeases"], 0, "900 s left: passes (the static gate refused < 1200)")
        self.assertEqual(pre["gate"]["leaseFirstEnd"], now + 900); self.assertFalse(any("P0 gate" in x for x in R.cutover_refusals(pre)))
        cov["records"] = [dict(r, leaseUntil=now + (600 if r["id"] == ids[0] else 1700)) for r in cov["records"]]; R.m.ps = Fake(idn, fil, cov).ps
        pre = R.preflight(); self.assertEqual(pre["gate"]["shortLeases"], 1); self.assertTrue(any("P0 gate" in x for x in R.cutover_refusals(pre)))
        # a preflight that passed, but whose first lease is now < 660 s away: the cutover refuses before sending anything
        cov["records"] = [dict(r, leaseUntil=now + 700) for r in cov["records"]]; f = Fake(idn, fil, cov); R.m.ps = f.ps
        pre = R.preflight(); self.assertEqual(pre["gate"]["shortLeases"], 0); pre["gate"]["leaseFirstEnd"] = now + 650
        pp = self.tmp / "pre.json"; pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": "C:\\s", "ok": True}))
        (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES["privacy"][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
        n0 = len(f.texts); out = __import__("io").StringIO(); so = sys.stdout; sys.stdout = out
        try: rc = R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)])
        finally: sys.stdout = so
        self.assertEqual(rc, 2); self.assertIn("lease deadline: the first lease ends in", out.getvalue()); self.assertEqual(len(f.texts), n0)
        self.assertEqual(list(self.tmp.glob("attempt-*")), [], "nothing attempted")
if __name__ == "__main__": unittest.main()
