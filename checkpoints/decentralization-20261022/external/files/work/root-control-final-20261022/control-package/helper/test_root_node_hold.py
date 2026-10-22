#!/usr/bin/env python3
"""Offline tests of the control-package root-node-hold.py (no remote call: m.ps and scp are faked; a guard fails any ssh/scp).
python3 -m unittest -v test_root_node_hold   (adapted from g4-node-ai-final-20261021/helper/test_root_node_hold.py + new cases)"""
import base64, glob, importlib.util, json, pathlib, re, shutil, sys, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parent; P = H.parent; W = P.parents[1]
spec = importlib.util.spec_from_file_location("rnh", H / "root-node-hold.py"); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
import subprocess as _sp; REAL_RUN = _sp.run
PROBE = json.load(open(sorted(glob.glob(str(W / "g4-node-ai-final-20261021/probe/out-*.json")))[-1]))
PRIV = "network/privacy-agent.mjs"
STAGE = "C:\\ProgramData\\Enclave\\staging\\nodehold-0123456789ab"

def enc_len(text, secs=240): return R.enc_len(text, secs)

def unq(s): return s.replace("''", "'")
BATCH = re.compile(r"\$b='((?:[^']|'')*)';\$o=\[ordered\]@\{\};foreach\(\$x in @\((.*)\)\)\{\$o\[\$x\]=FileSha \(\$b\+\$x\)\}")

class Fake:
    """canned answers by the text's shape; records every text"""
    def __init__(self, idn, fil, cov, launch=None, journal=None): self.idn, self.fil, self.cov, self.launch, self.journal, self.texts = idn, fil, cov, launch, journal, []
    def ps(self, text, secs=150):
        assert enc_len(text, secs) <= 7900, "a remote text over the transport limit"
        self.texts.append(text)
        mb = BATCH.search(text)
        if mb:
            b = unq(mb.group(1)); rels = [unq(x) for x in re.findall(r"'((?:[^']|'')*)'", mb.group(2))]
            return {r: self.fil.get(b + r, "absent") for r in rels}
        if "cfgAcl=(Get-Acl" in text: return {k: self.idn.get(k) for k in ("cfgAcl", "localAcl")}   # the ACLS read (SDDL only)
        if "$o.cmd=@(" in text: return {k: v for k, v in self.idn.items() if k in ("cmd", "agent", "privacy", "manager", "vms", "wg", "tasks", "hyperv")}
        if "$o.runNode=" in text: return {k: v for k, v in self.idn.items() if k not in ("cmd", "agent", "privacy", "manager", "vms", "wg", "tasks", "hyperv")}
        if "$o.apps=@(" in text: return self.cov
        if "Register-ScheduledTask" in text: return self.launch or {"decision": "started", "state": "Running"}
        if "bundle-swap.ps1" in text:
            tgt = unq(re.search(r"Target='((?:[^']|'')*)'", text).group(1)); back = "Mode='rollback'" in text
            k = next(k for k, v in R.FILES.items() if v[1] == tgt); self.fil[tgt] = R.FILES[k][2 if back else 3]
            return {"decision": "rolled back" if back else "applied"}
        if "$pv=" in text:
            tgt = unq(re.search(r"\$t='((?:[^']|'')*)'", text).group(1)); back = "staged=FileSha $s" not in text
            k = next(k for k, v in R.FILES.items() if v[1] == tgt); self.fil[tgt] = R.FILES[k][2 if back else 3]
            return {"decision": "rolled back" if back else "applied"}
        if "New-Item -ItemType Directory" in text: return {"created": unq(re.search(r"\$d='((?:[^']|'')*)'", text).group(1))}
        if "$j=" in text: return self.journal or {"lines": ['{"final":"DONE: test"}'], "task": "unregistered after final"}
        return {"error": "unexpected text"}

def live_like(lease_sec=3600):
    s, n = PROBE["state"], PROBE["network"]
    cmd_pid, cmd_start = 23976, "2026-10-21T15:01:03.5900000Z"; a = s["agent"][0].split("@"); pa = s["privacy"][0].split("@")
    vms = ",".join(sorted(s["vms"]))
    hyperv = ",".join(sorted(f"0000000{n}-1111-2222-3333-444444444444|vm{n}|Running" for n in range(len(s["vms"]))))
    at = R.now()
    idn = {"cmd": [{"pid": cmd_pid, "start": cmd_start}], "agent": [{"pid": int(a[0]), "parent": cmd_pid, "start": a[1].split("<")[0]}],
           "privacy": [{"pid": int(pa[0]), "start": pa[1].split("<")[0]}], "manager": s["manager"], "vms": vms, "wg": s["wg"], "tasks": [],
           "runNode": s["run-node.cmd"], "local": s["node-config.local.cmd"], "flag": False, "cfg": n["cfgSha"], "enKeys": n["enKeys"], "wallet": "absent",
           "statusAgeMs": 800, "statusWallet": None, "egressApps": 9, "hyperv": hyperv, "netWriters": ["S-1-5-18", "S-1-5-32-544"],
           "at": at, "netReaders": ["S-1-5-18", "S-1-5-32-544"], "pdInheritReaders": ["S-1-5-18", "S-1-5-32-544"], "nodeExe": R.NODE_SHA, "runtimeNodeExe": "9" * 64,
           "update": {"state": "Ready", "next": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime(time.time() + 7200))},
           "cfgAcl": "O:SYG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)", "localAcl": "O:SYG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)"}
    fil = {v[1]: v[3] for v in R.FILES.values()} | dict(R.KEEP)
    t0 = R.iso_epoch(at)
    recs = [dict(r, leaseUntil=t0 + lease_sec) for r in n["records"]]
    cov = {"apps": [dict(a, configCidString=True) for a in n["apps"]], "records": recs, "policyUnavailable30min": 0}
    return idn, fil, cov

class T(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()); R.OUT = self.tmp
        R.verify_local()                                   # loads the real transport ONCE; every test then replaces m.ps
        real = REAL_RUN
        def guard(argv, **k):                              # NOTHING may reach minipc from a test
            if any(str(a) in ("ssh", "scp") for a in argv): raise AssertionError("a test tried to reach minipc: " + " ".join(map(str, argv[:3])))
            return real(argv, **k)
        R.subprocess.run = guard; R.m.subprocess.run = guard; R.m.ps = lambda *a, **k: (_ for _ in ()).throw(AssertionError("unfaked m.ps"))
        self.sleep = R.time.sleep
    def tearDown(self): shutil.rmtree(self.tmp); R.subprocess.run = REAL_RUN; R.time.sleep = self.sleep
    def fake_scp(self):
        up = []; R.subprocess.run = lambda a, **k: (up.append(a), type("r", (), {"returncode": 0, "stderr": ""})())[1]; return up
    def receipts(self, pre, stage=STAGE):
        pp = self.tmp / "pre.json"; pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": stage, "ok": True, "manifestSha": R.MANIFEST_SHA}))
        return pp, sp

    # ------------------------------------------------------------------ package / pins
    def test_manifest_files_budget_and_cutover_pins(self):
        man = json.loads(R.MANIFEST[0].read_text())
        self.assertEqual(R.GROUPS["network"], [PRIV], "network: the privacy agent only")
        self.assertEqual((R.FILES[PRIV][2][:8], R.FILES[PRIV][3][:8]), ("7ef4e230", "cfb69370"))
        for keep, h in (("host-service-ingress.mjs", "c952dce4"), ("windows-circuit-worker.mjs", "13ce44f1"), ("enclave-wg.exe", "cbaf8313"), ("enclave-circuit-firewall.exe", "78daec71")):
            self.assertEqual(R.KEEP[R.PF + "\\network\\" + keep][:8], h, keep)
            self.assertNotIn("network/" + keep, R.FILES, "already-live/native files are never replaced")
        self.assertEqual(len(R.GROUPS["control"]), 18)
        self.assertNotIn("sdk/bootstrap/package.mjs", R.GROUPS["control"], "already live at 17cc4cba (fresh snapshot): verify-only")
        self.assertEqual(R.KEEP[R.PF + "\\control\\sdk\\bootstrap\\package.mjs"][:8], "17cc4cba")
        self.assertEqual((R.FILES["windows/node/host.mjs"][3][:8], R.FILES["windows/node/agent.mjs"][3][:8], R.FILES["windows/node/host-admission.bundle.mjs"][3][:8]), ("9634cb40", "76cac355", "6bef372d"))
        hows = [R.FILES[k][4] for k in R.GROUPS["control"]]
        self.assertEqual(hows, ["put"] * 5 + ["swap"] * 13, "new files first (nothing old imports them)")
        self.assertEqual(R.GROUPS["control"][-2:], ["windows/node/host.mjs", "windows/node/agent.mjs"], "importers last")
        b = W.parent / man["composedFrom"]["budget"]["path"]; bj = json.loads(b.read_text())
        self.assertEqual(R.sha(b), man["composedFrom"]["budget"]["sha256"])
        self.assertEqual(R.LEASE, bj["leaseBudget"]); self.assertEqual(R.LEASE_NEED, bj["minimumRemainingBeforeStop"])
        self.assertEqual(R.LEASE_NEED, R.LEASE["revertSec"] + R.LEASE["marginSec"] + R.LEASE["forwardMinSec"])
        self.assertEqual(R.sha(W.parent / man["composedFrom"]["cutover"]["path"]), R.SCRIPTS["node-hold-cutover.ps1"][1], "verbatim copy of root's candidate")
        self.assertEqual(man["composedFrom"]["cutover"]["sha256"], R.SCRIPTS["node-hold-cutover.ps1"][1])
        self.assertTrue(R.BOUND_S - R.LEASE["revertSec"] >= R.LEASE["forwardMinSec"], "the global bound leaves forward time after reserving recovery")
        self.assertLess(R.BOUND_S + 120, 20 * 60, "the one-shot task's 20-minute limit outlasts the bound")
    def test_params_cover_every_key_the_cutover_reads(self):
        ps1 = (H / "node-hold-cutover.ps1").read_text()
        used = set(re.findall(r"\$PRM\.([A-Za-z]+)", ps1)) - {"testRoot", "testNode", "before"}
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov); R.m.ps = f.ps; pre = R.preflight(); pp, sp = self.receipts(pre)
        (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES[PRIV][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
        self.fake_scp(); R.time.sleep = lambda s: None
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 0)
        params = json.loads(sorted(self.tmp.glob("cutover-result-*.json"))[0].read_text())["params"]
        self.assertEqual(sorted(used - set(params)), [], "every $PRM key the pinned cutover reads is sent")
        lease_keys = set(re.findall(r"\$PRM\.lease\.([A-Za-z]+)", ps1)) | set(re.findall(r"\$lp\.([A-Za-z]+)", ps1))
        self.assertEqual(sorted(lease_keys - set(params["lease"])), [])
    def test_every_remote_text_fits_and_hashing_is_batched(self):
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov); R.m.ps = f.ps; R.preflight()
        batches = [t for t in f.texts if BATCH.search(t)]
        self.assertGreater(len(batches), 1, "the file set does not fit one call: batched")
        seen = []
        for t in batches:
            mb = BATCH.search(t); b = unq(mb.group(1)); seen += [b + unq(x) for x in re.findall(r"'((?:[^']|'')*)'", mb.group(2))]
            self.assertLessEqual(enc_len(t, 90), R.LIMIT)
        want = [v[1] for v in R.FILES.values()] + list(R.KEEP) + R.OBSERVE
        self.assertEqual(sorted(seen), sorted(set(want)), "every path exactly once"); self.assertEqual(len(seen), len(set(seen)))
        long_t = max(R.FILES.values(), key=lambda v: len(v[1]))
        texts = f.texts + [R.PUT.replace("TX", R.q(long_t[1])).replace("SX", R.q(STAGE + "\\files\\" + R.skey("windows/vbslike/manager/model-volumes.mjs"))).replace("OX", R.q("absent")).replace("NX", R.q("a" * 64)).replace("PX", R.q(STAGE + "\\put-private")),
                           R.UNPUT.replace("TX", R.q(long_t[1])).replace("OX", R.q("a" * 64)).replace("NX", R.q("b" * 64)).replace("PX", R.q(STAGE + "\\put-private")),
                           R.AGENT.replace("PIDX", "12345").replace("STARTX", R.q("2026-10-21T00:05:03.7361540Z"))]
        loader = R.LOADER.replace("PS1X", STAGE + "\\node-hold-cutover.ps1").replace("PSHA", "a" * 64) \
            .replace("PFX", STAGE + "\\params-20261021t230000z-abcdef-rb.json").replace("PFSHA", "b" * 64).replace("MODEX", "rollback")
        texts.append(R.LAUNCH.replace("TNX", R.q("node-hold-20261021t230000z-abcdef-rb")).replace("PSHA", "a" * 64).replace("PFSHA", "b" * 64).replace("ENCX", base64.b64encode(loader.encode("utf-16-le")).decode()))
        for t in texts: self.assertLessEqual(enc_len(t), 7900, t[:80])
        # the longest swap call (bundle-swap with the longest target and staged name)
        for how in ("swap", "put"):
            k = max((k for k in R.FILES if R.FILES[k][4] == how), key=lambda k: len(R.FILES[k][1]) + len(k))
            for back in (False, True):
                cap = []; R.m.ps = lambda text, secs=150: (cap.append((text, secs)), {"decision": "applied"})[1]
                R.change(STAGE, k, back); self.assertEqual(len(cap), 1)
                for t, s in cap: self.assertLessEqual(enc_len(t, s), 7900, (how, back))
    def test_stage_uploads_and_verifies_in_batches(self):
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov); R.m.ps = f.ps; pre = R.preflight()
        pp = self.tmp / "pre.json"; pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre})); up = self.fake_scp()
        def ps(text, secs=150):
            mm = re.search(r"\$d='((?:[^']|'')*)'", text)
            if "New-Item -ItemType Directory" in text and mm:
                d = unq(mm.group(1))
                for n, (_, h) in R.SCRIPTS.items(): f.fil[d + "\\" + n] = h
                for k, v in R.FILES.items(): f.fil[R.staged(d, k)] = v[3]
            return f.ps(text, secs)
        R.m.ps = ps
        self.assertEqual(R.main(["--stage", "--preflight", str(pp)]), 0)
        self.assertEqual(len(up), len(R.SCRIPTS) + len(R.FILES))
        rec = json.loads(sorted(self.tmp.glob("stage-*.json"))[0].read_text()); self.assertTrue(rec["ok"]); self.assertEqual(rec["manifestSha"], R.MANIFEST_SHA)
        self.assertEqual(len(set(R.staged(rec["stage"], k) for k in R.FILES)), len(R.FILES), "staged names are unique")

    # ------------------------------------------------------------------ preflight gates
    def test_coverage_from_the_live_probe(self):
        idn, fil, cov = live_like(); R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight()
        self.assertEqual(len(pre["coverage"]["expectedIds"]), 9, "every VM named by a deployment id, all running records")
        self.assertEqual(pre["coverage"]["blockers"], []); self.assertEqual(len(pre["coverage"]["staleEnrolledWithoutVm"]), 8)
        self.assertEqual(R.cutover_refusals(pre), [], "the live shape with every file new passes")
    def test_lease_window_uses_the_budget_not_a_static_20_minutes(self):
        for sec, ok in ((944, True), (918, True), (1199, True), (909, False), (300, False)):
            idn, fil, cov = live_like(sec); R.m.ps = Fake(idn, fil, cov).ps; ref = R.cutover_refusals(R.preflight())
            self.assertEqual(not any("lease window" in r for r in ref), ok, (sec, ref))
        idn, fil, cov = live_like(944); R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight()
        self.assertLess(R.lease_estimate(pre, at=pre["gate"]["localAtEpoch"] + 60), R.LEASE_NEED, "time since the preflight counts")
        idn, fil, cov = live_like(); cov["records"][3] = dict(cov["records"][3], leaseUntil=None); R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("lease window unknown" in r for r in R.cutover_refusals(R.preflight())))
    def test_refusals(self):
        cases = [("local", "0" * 64, "node-config.local.cmd"), ("flag", True, "names the flag"), ("wallet", "c" * 64, "already carries"),
                 ("statusAgeMs", 9000, "not fresh"), ("vms", "unavailable", "VM list"), ("runNode", "0" * 64, "run-node.cmd"),
                 ("hyperv", "unavailable", "Hyper-V"), ("netWriters", ["S-1-5-18", "S-1-5-11"], "network directory is writable"),
                 ("update", {"state": "Running", "next": None}, "Update task runs or is due"),
                 ("update", {"state": "Ready", "next": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime(time.time() + 600))}, "Update task runs or is due"),
                 ("update", None, "Update task state is unreadable"),
                 ("cfgAcl", "O:BAG:S-1-5-21-1-2-3-513D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)", "cfgAcl: the DACL is not auto-inherited"),
                 ("localAcl", None, "localAcl: the DACL is not auto-inherited (unreadable)"),
                 ("netReaders", ["S-1-5-18", "S-1-5-32-544", "S-1-5-32-545"], "readable by more than"),
                 ("pdInheritReaders", ["S-1-5-18", "S-1-5-32-544", "S-1-5-32-545"], "inherit READ"),
                 ("nodeExe", "absent", "root-proven node.exe")]
        for key, val, why in cases:
            idn, fil, cov = live_like(); idn[key] = val; R.m.ps = Fake(idn, fil, cov).ps
            self.assertTrue(any(why in r for r in R.cutover_refusals(R.preflight())), key)
        idn, fil, cov = live_like(); fil[R.FILES["windows/node/host.mjs"][1]] = R.FILES["windows/node/host.mjs"][2]; R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("not all new" in r for r in R.cutover_refusals(R.preflight())))
        for p in (R.PF + "\\network\\enclave-wg.exe", R.PF + "\\network\\host-service-ingress.mjs", R.PF + "\\control\\relay\\snp-verify.mjs", R.PF + "\\control\\windows\\node\\session.mjs"):
            idn, fil, cov = live_like(); fil[p] = "d" * 64; R.m.ps = Fake(idn, fil, cov).ps
            self.assertTrue(any("verify-only pins differ" in r and p in r for r in R.cutover_refusals(R.preflight())), p)
        idn, fil, cov = live_like(); cov["policyUnavailable30min"] = 1; R.m.ps = Fake(idn, fil, cov).ps
        self.assertTrue(any("P0 gate" in r for r in R.cutover_refusals(R.preflight())))
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov)
        def flaky(text, secs=150): return {"error": "ssh rc 255"} if BATCH.search(text) and "control" in text else f.ps(text, secs)
        R.m.ps = flaky; pre = R.preflight(); self.assertIn("files", pre["errors"]); self.assertTrue(any("preflight errors" in r for r in R.cutover_refusals(pre)))
    def test_observed_manager_files_are_reported_never_gated(self):
        idn, fil, cov = live_like(); fil[R.OBSERVE[0]] = "e" * 64; R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight()
        self.assertEqual(pre["observed"][R.OBSERVE[0]], "e" * 64); self.assertEqual(R.cutover_refusals(pre), [])

    # ------------------------------------------------------------------ group CAS
    def test_apply_order_and_full_rollback(self):
        idn, fil, cov = live_like(); fil.update({v[1]: v[2] for v in R.FILES.values()}); pre = None
        _, sp = self.receipts({"identities": {}, "gate": {}})
        for back, want in ((False, R.GROUPS["control"]), (True, list(reversed(R.GROUPS["control"])))):
            f = Fake(idn, fil, cov); R.m.ps = f.ps
            self.assertEqual(R.main(["--rollback" if back else "--apply", "control", "--stage-receipt", str(sp)]), 0)
            order = [k for t in f.texts if not BATCH.search(t) for k in R.FILES if R.q(R.FILES[k][1]) in t or ("Target=" + R.q(R.FILES[k][1])) in t]
            self.assertEqual(order, want)
            for k in R.GROUPS["control"]: self.assertEqual(fil[R.FILES[k][1]], R.FILES[k][2 if back else 3])
        put = [t for t in f.texts if "$pv=" in t and R.q(R.FILES["network/wallet-admission.mjs"][1]) in t][0]
        self.assertIn("if($old -eq 'absent'){Remove-Item -LiteralPath $t -Force}", put, "rollback (UNPUT) removes a new file")
    def test_rollback_after_partial_apply_restores_exactly_the_applied_files(self):
        idn, fil, cov = live_like(); fil.update({v[1]: v[2] for v in R.FILES.values()}); _, sp = self.receipts({"identities": {}, "gate": {}})
        f = Fake(idn, fil, cov); calls = {"n": 0}
        def failing(text, secs=150):
            if "bundle-swap.ps1" in text:
                calls["n"] += 1
                if calls["n"] == 4: return {"decision": "refused: CAS (the target is not -OldSha)"}
            return f.ps(text, secs)
        R.m.ps = failing
        self.assertEqual(R.main(["--apply", "control", "--stage-receipt", str(sp)]), 3)
        applied = [k for k in R.GROUPS["control"] if fil[R.FILES[k][1]] == R.FILES[k][3]]
        self.assertEqual(applied, R.GROUPS["control"][:8], "5 PUT + 3 swaps, then stopped")
        f2 = Fake(idn, fil, cov); R.m.ps = f2.ps
        self.assertEqual(R.main(["--rollback", "control", "--stage-receipt", str(sp)]), 0)
        touched = [k for t in f2.texts if not BATCH.search(t) for k in R.FILES if R.q(R.FILES[k][1]) in t or ("Target=" + R.q(R.FILES[k][1])) in t]
        self.assertEqual(touched, list(reversed(applied)), "only the applied files, newest first; unapplied ones are never sent")
        self.assertTrue(all(fil[R.FILES[k][1]] == R.FILES[k][2] for k in R.GROUPS["control"]))
    def test_unknown_target_refuses_the_group_before_any_change(self):
        idn, fil, cov = live_like(); fil.update({v[1]: v[2] for v in R.FILES.values()}); fil[R.FILES["windows/node/agent.mjs"][1]] = "e" * 64
        _, sp = self.receipts({"identities": {}, "gate": {}}); f = Fake(idn, fil, cov); R.m.ps = f.ps
        self.assertEqual(R.main(["--apply", "control", "--stage-receipt", str(sp)]), 3)
        self.assertTrue(all(BATCH.search(t) for t in f.texts), "only reads were sent"); self.assertEqual(list(self.tmp.glob("attempt-*")), [], "no attempt consumed")
        fil[R.FILES["network/host-service-names.mjs"][1]] = "e" * 64; fil[R.FILES["windows/node/agent.mjs"][1]] = R.FILES["windows/node/agent.mjs"][2]
        f = Fake(idn, fil, cov); R.m.ps = f.ps
        self.assertEqual(R.main(["--apply", "control", "--stage-receipt", str(sp)]), 3, "a foreign file where a new file goes is never overwritten")
    def test_network_apply_touches_only_the_privacy_agent(self):
        idn, fil, cov = live_like(); fil[R.FILES[PRIV][1]] = R.FILES[PRIV][2]; _, sp = self.receipts({"identities": {}, "gate": {}})
        f = Fake(idn, fil, cov); R.m.ps = f.ps
        self.assertEqual(R.main(["--apply", "network", "--stage-receipt", str(sp)]), 0)
        muts = [t for t in f.texts if not BATCH.search(t)]
        self.assertEqual(len(muts), 1); self.assertIn("Target=" + R.q(R.FILES[PRIV][1]), muts[0]); self.assertIn("OldSha='7ef4e230", muts[0])
        for keep in ("host-service-ingress.mjs", "windows-circuit-worker.mjs"): self.assertNotIn(keep, muts[0])
    def test_stage_receipt_of_another_manifest_refuses(self):
        sp = self.tmp / "stage.json"; sp.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": STAGE, "ok": True, "manifestSha": "0" * 64}))
        with self.assertRaises(SystemExit): R.main(["--apply", "control", "--stage-receipt", str(sp)])

    # ------------------------------------------------------------------ cutover / rollback-cutover
    def test_attempt_is_never_retried(self):
        self.assertTrue(R.attempt("attempt-x.json", {})); self.assertFalse(R.attempt("attempt-x.json", {}))
    def test_cutover_and_rollback_params_end_to_end_with_fakes(self):
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov); R.m.ps = f.ps
        pre = R.preflight(); pp, sp = self.receipts(pre); self.fake_scp(); R.time.sleep = lambda s: None
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 2, "no restart-agent receipt for the running agent")
        (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES[PRIV][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
        jx = []
        def ps(text, secs=150):
            mm = re.search(r"\$j='((?:[^']|'')*)'", text)
            if mm: jx.append(unq(mm.group(1)))
            return f.ps(text, secs)
        R.m.ps = ps
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 0)
        res = sorted(self.tmp.glob("cutover-result-*.json")); self.assertEqual(len(res), 1)
        r0 = json.loads(res[0].read_text()); params, run = r0["params"], r0["runId"]
        self.assertEqual(params["runId"], run, "the cutover journal is cutover-<runId>.jsonl")
        self.assertEqual(jx[-1], STAGE + f"\\cutover-{run}.jsonl", "the poll reads the journal the script writes")
        self.assertEqual(params["lease"], R.LEASE); self.assertEqual(params["boundSec"], R.BOUND_S)
        self.assertEqual(len(params["files"]), len(R.FILES) + len(R.KEEP))
        self.assertEqual(params["expectedIds"], pre["coverage"]["expectedIds"]); self.assertEqual(params["vms"], idn["vms"]); self.assertEqual(params["localSha"], R.LOCAL_CFG)
        self.assertEqual((params["nodeExe"], params["nodeSha"]), (R.NODE_EXE, R.NODE_SHA)); self.assertEqual(params["hyperv"], idn["hyperv"])
        launch = [t for t in f.texts if "Register-ScheduledTask" in t][0]; self.assertIn("\\EnclaveOps\\", launch)
        r0["journal"] = {"lines": [json.dumps({"step": "backups", "localBackup": "C:\\s\\private\\l", "cfgBackup": "C:\\s\\private\\c"}), json.dumps({"step": "flag", "after": "e" * 64}),
                                   json.dumps({"step": "config", "after": "f" * 64}), json.dumps({"final": "DONE: test"})]}
        res[0].write_text(json.dumps(r0)); pp.write_text(json.dumps({"what": "preflight", "at": R.now(), **pre}))
        R.main(["--rollback-cutover", run, "--stage-receipt", str(sp), "--preflight", str(pp)])
        rbp = json.loads((self.tmp / f"rollback-result-{run}-rb.json").read_text())["params"]
        self.assertEqual(rbp["runId"], run + "-rb")
        self.assertEqual(rbp["before"], {"local": {"before": R.LOCAL_CFG, "after": "e" * 64, "backup": "C:\\s\\private\\l"}, "cfg": {"before": idn["cfg"], "after": "f" * 64, "backup": "C:\\s\\private\\c"}})
        self.assertFalse(R.attempt(f"attempt-cutover-{run}.json", {}), "the same run id is never attempted twice")
    def test_recovery_required_is_never_success(self):
        idn, fil, cov = live_like(); f = Fake(idn, fil, cov, journal={"lines": ['{"final":"RECOVERY_REQUIRED: the node flag was not restored"}'], "task": "unregistered after final"}); R.m.ps = f.ps
        pre = R.preflight(); pp, sp = self.receipts(pre)
        (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES[PRIV][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
        self.fake_scp(); R.time.sleep = lambda s: None
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 3)
    def test_final_lines_of_the_pinned_cutover_are_classified_exactly(self):
        ps1 = (H / "node-hold-cutover.ps1").read_text()
        finals = sorted(set(re.findall(r"""['"]((?:DONE|ROLLED_BACK|CRASHED|RECOVERY|REFUSED)[A-Z0-9_]*):""", ps1)))
        want = {"DONE": "done", "DONE_CHECK": "check", "DONE_PARTIAL": "check", "REFUSED": "refused", "RECOVERY_REQUIRED": "recovery",
                "ROLLED_BACK": "rolled-back", "ROLLED_BACK_LEASE": "rolled-back", "ROLLED_BACK_R0": "rolled-back", "ROLLED_BACK_R1": "rolled-back",
                "ROLLED_BACK_R2": "rolled-back", "ROLLED_BACK_AFTER_CRASH": "rolled-back", "CRASHED_RESTORED": "rolled-back",
                "ROLLED_BACK_CHECK": "check", "ROLLED_BACK_AFTER_CRASH_CHECK": "check"}
        self.assertEqual(sorted(want), finals, "every final prefix of the pinned cutover is known here")
        for p, k in want.items(): self.assertEqual(R.classify(p + ": x"), k, p)
        idn, fil, cov = live_like()
        for line, rc in (('{"final":"ROLLED_BACK_CHECK: the revert completed but a later check failed"}', 3), ('{"final":"DONE_CHECK: post failed"}', 3), ('{"final":"DONE: ok"}', 0)):
            f = Fake(idn, fil, cov, journal={"lines": [line], "task": "unregistered after final"}); R.m.ps = f.ps
            pre = R.preflight(); pp, sp = self.receipts(pre)
            (self.tmp / "restart-agent-result-x.json").write_text(json.dumps({"result": {"agentScript": R.FILES[PRIV][3], "newPid": idn["privacy"][0]["pid"], "newStart": idn["privacy"][0]["start"]}}))
            self.fake_scp(); R.time.sleep = lambda s: None
            import io, contextlib
            out = io.StringIO()
            with contextlib.redirect_stdout(out): got = R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)])
            self.assertEqual(got, rc, line)
            if "_CHECK" in line: self.assertNotIn("verified back", out.getvalue()); self.assertIn("NOT verified", out.getvalue())
    def test_refused_cutover_sends_nothing(self):
        idn, fil, cov = live_like(); fil[R.FILES[PRIV][1]] = R.FILES[PRIV][2]; f = Fake(idn, fil, cov); R.m.ps = f.ps
        pre = R.preflight(); pp, sp = self.receipts(pre); n0 = len(f.texts)
        self.assertEqual(R.main(["--cutover", "--stage-receipt", str(sp), "--preflight", str(pp)]), 2)
        self.assertEqual(len(f.texts), n0, "no remote text after a refusal"); self.assertEqual(list(self.tmp.glob("attempt-*")), [])
    def test_restart_agent_requires_a_known_privacy_state(self):
        idn, fil, cov = live_like(); fil[R.FILES[PRIV][1]] = "e" * 64; R.m.ps = Fake(idn, fil, cov).ps; pre = R.preflight(); pp, _ = self.receipts(pre)
        with self.assertRaises(SystemExit): R.main(["--restart-agent", "--preflight", str(pp)])
        self.assertEqual(list(self.tmp.glob("attempt-*")), [])
if __name__ == "__main__": unittest.main()
