#!/usr/bin/env python3
"""Local fixture tests of root-g4-network-observe.py. Nothing reaches minipc: the transport is replaced by a raiser, and
snapshot() by fixtures. Fixture SHAPES are root's real receipts (P2 / P1 preflight copies, hs2 probe-after); the restart
receipt is built with exactly the keys of the helper's AGENT text. These tests prove the evaluation logic, not live health."""
import copy, hashlib, importlib.util, json, pathlib, shutil, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location("obs", H / "root-g4-network-observe.py"); O = importlib.util.module_from_spec(s); s.loader.exec_module(O)
R, HS_TEXT = O.load_pinned()                                   # local pins + the helper's verify_local (no remote)
R.m.ps = lambda *a, **k: (_ for _ in ()).throw(AssertionError("a test reached the transport"))
BASE = json.loads((H / "fixtures/baseline-P2.copy.json").read_text()); P1 = json.loads((H / "fixtures/preflight-P1.copy.json").read_text())
HSREF = json.loads(O.HS_AFTER[0].read_text())
NEWPID, NEWSTART = 41234, "2026-10-21T23:20:55.1234560Z"
RESTART = {"what": "result", "at": "2026-10-21T23:22:10Z", "result": {"wgBefore": 21, "newPid": NEWPID, "newStart": NEWSTART, "backAfterSec": 4.1, "alive": True,
           "wgAfter60s": 21, "decision": "restarted", "agentScript": R.FILES["privacy"][3], "statusAgeMs": 700, "statusWallet": False, "egressApps": 9}}
def pre(elapsed=600, **idn):
    p = copy.deepcopy({k: BASE[k] for k in ("identities", "files", "state", "keepUnchanged", "coverage", "gate", "errors")})
    p["identities"]["privacy"] = [{"pid": NEWPID, "start": NEWSTART}]; p["identities"]["statusAgeMs"] = 850; p["gate"]["policyUnavailable30min"] = 0
    t = O.ts(NEWSTART) + elapsed; p["identities"]["at"] = __import__("time").strftime("%Y-%m-%dT%H:%M:%S", __import__("time").gmtime(t)) + ".5000000Z"
    p["identities"].update(idn); return p
def hs(**over): h = {k: copy.deepcopy(v) for k, v in HSREF.items()}; h.update(over); return h
def ev(p=None, h=None, base=BASE, restart=RESTART): return O.evaluate(base, restart, O.reduce(p or pre(), h or hs()), HSREF, R.FILES)
def failed(r): return [c["check"] for c in r["checks"] if c["ok"] is False]
class Observe(unittest.TestCase):
    def test_pins_and_probe_text(self):
        self.assertEqual(O.sha(O.HELPER[0]), "0829847e90cd090948af9e74ca053045aef4e630193881ce2a48e3e54947cd02")
        self.assertIn("Get-NetTCPConnection -State Listen", HS_TEXT); self.assertIn("'/health' 'GET'", HS_TEXT); self.assertTrue(HS_TEXT.endswith("$o|ConvertTo-Json -Depth 5 -Compress"))
        self.assertNotIn("POST", HS_TEXT.upper().replace("POSTURE", "")); self.assertNotIn("Set-", HS_TEXT); self.assertNotIn("Remove-", HS_TEXT)
        enc = len(__import__("base64").b64encode((R.m.HEAD.replace("SECS", "90") + HS_TEXT).encode("utf-16-le"))); self.assertLessEqual(enc, 7900, enc)
    def test_positive_initial_then_complete(self):
        r = ev(pre(600)); self.assertEqual(r["status"], "INITIAL_HEALTHY", failed(r) or [c for c in r["checks"] if c["ok"] is None]); self.assertEqual(r["elapsedSinceRestartSec"], 600.4); self.assertEqual(r["remainingSec"], 1199.6)
        r = ev(pre(1800)); self.assertEqual(r["status"], "OBSERVATION_COMPLETE_HEALTHY"); self.assertEqual(r["remainingSec"], 0)
        self.assertEqual(ev(pre(1799))["status"], "INITIAL_HEALTHY", "elapsed < 30 min is never 'complete'")
    def test_egress_recovery_is_required_only_for_completion(self):
        r = ev(pre(96, egressApps=7)); self.assertEqual(r["status"], "INITIAL_HEALTHY"); self.assertTrue(r["informational"]["egressApps"]["recovering"])
        self.assertIn("egress routes back to the baseline app count (required for completion)", failed(ev(pre(1800, egressApps=8))))
        self.assertEqual(ev(pre(1800, egressApps=-1))["status"], "UNAVAILABLE"); self.assertEqual(ev(pre(1900, egressApps=9))["status"], "OBSERVATION_COMPLETE_HEALTHY")
    def test_changed_identities(self):
        a = copy.deepcopy(BASE["identities"]["agent"]); a[0]["pid"] += 1
        self.assertIn("node agent identity unchanged (pid+start)", failed(ev(pre(agent=a))))
        c = copy.deepcopy(BASE["identities"]["cmd"]); c[0]["start"] = "2026-10-21T23:30:00.0000000Z"
        self.assertEqual(ev(pre(cmd=c))["status"], "UNHEALTHY"); self.assertEqual(ev(pre(manager="1@2026-10-21T23:30:00.0000000Z"))["status"], "UNHEALTHY")
    def test_vm_loss(self):
        v = BASE["identities"]["vms"].split(","); h = BASE["identities"]["hyperv"].split(",")
        self.assertIn("manager VM identities unchanged (full id|name|status set)", failed(ev(pre(vms=",".join(v[1:])))))
        self.assertIn("Hyper-V VM identities unchanged (full GUID|name|state set)", failed(ev(pre(hyperv=",".join(h[1:])))))
        self.assertEqual(ev(pre(hyperv=BASE["identities"]["hyperv"].replace("|Running", "|Off", 1)))["status"], "UNHEALTHY", "a VM state change")
    def test_privacy_wrong_pid(self):
        self.assertIn("exactly one privacy agent and it is the restart's pinned PID+start", failed(ev(pre(privacy=[{"pid": NEWPID + 1, "start": NEWSTART}]))))
        self.assertEqual(ev(pre(privacy=[{"pid": NEWPID, "start": NEWSTART}, {"pid": 5, "start": NEWSTART}]))["status"], "UNHEALTHY")
        self.assertEqual(ev(pre(privacy=BASE["identities"]["privacy"]))["status"], "UNHEALTHY", "the OLD agent")
        self.assertEqual(ev(pre(privacy=[]))["status"], "UNHEALTHY", "no agent")
    def test_stale_status(self):
        self.assertIn("network status fresh (< 5 s)", failed(ev(pre(statusAgeMs=9000))))
        self.assertEqual(ev(pre(statusAgeMs=-1))["status"], "UNAVAILABLE", "status.json unreadable")
    def test_hash_mismatch(self):
        p = pre(); p["state"]["privacy"] = "UNKNOWN " + "e" * 64; p["files"][R.FILES["privacy"][1]] = "e" * 64
        self.assertIn(f"privacy file is the new sha {R.FILES['privacy'][3][:8]}", failed(ev(p)))
        p = pre(); p["state"]["ingress"] = "old"; self.assertEqual(ev(p)["status"], "UNHEALTHY")
        p = pre(); p["state"]["host"] = "new"; self.assertIn("control-group files unchanged from the baseline (not yet applied)", failed(ev(p)))
        p = pre(); k = list(p["keepUnchanged"])[0]; p["keepUnchanged"][k] = False; self.assertEqual(ev(p)["status"], "UNHEALTHY")
        self.assertEqual(ev(pre(cfg="0" * 64))["status"], "UNHEALTHY")
    def test_coverage_wallet_policy_hs2(self):
        p = pre(); p["coverage"]["expectedIds"] = p["coverage"]["expectedIds"][1:]; self.assertEqual(ev(p)["status"], "UNHEALTHY")
        p = pre(); p["coverage"]["blockers"] = [{"id": "0x1", "why": "record not running"}]; self.assertEqual(ev(p)["status"], "UNHEALTHY")
        self.assertEqual(ev(pre(flag=True))["status"], "UNHEALTHY"); self.assertEqual(ev(pre(statusWallet={"x": 1}))["status"], "UNHEALTHY")
        self.assertEqual(ev(pre(enKeys=BASE["identities"]["enKeys"] + ["walletAdmission"]))["status"], "UNHEALTHY")
        self.assertEqual(ev(pre(enKeys=BASE["identities"]["enKeys"] + ["challengeReplica"]))["status"], "UNHEALTHY", "G4 must stay inert")
        self.assertEqual(ev(pre(statusWallet=False))["status"], "INITIAL_HEALTHY", "false is accepted like null")
        p = pre(); p["gate"]["policyUnavailable30min"] = 1; self.assertEqual(ev(p)["status"], "UNHEALTHY")
        self.assertEqual(ev(h=hs(http=dict(HSREF["http"], directory=502)))["status"], "UNHEALTHY"); self.assertEqual(ev(h=hs(config="f" * 64))["status"], "UNHEALTHY")
        self.assertEqual(ev(h=hs(listeners=HSREF["listeners"] + [{"port": 18288, "address": "0.0.0.0"}]))["status"], "UNHEALTHY")
    def test_unavailable_sources_never_pass(self):
        for p, h in ((pre(vms="unavailable"), None), (pre(hyperv="unavailable"), None), (None, {"error": "transport lost"}), (None, {"config": HSREF["config"]})):
            self.assertEqual(ev(p, h)["status"], "UNAVAILABLE", (p and p["identities"].get("vms"), h))
        p = pre(); p["errors"] = {"coverage": "x"}; self.assertEqual(ev(p)["status"], "UNAVAILABLE")
        p = pre(); p["gate"]["policyUnavailable30min"] = None; self.assertEqual(ev(p)["status"], "UNAVAILABLE", "node.log count unreadable")
        p = pre(); del p["identities"]["cmd"]; self.assertEqual(ev(p)["status"], "UNAVAILABLE")
        p = pre(); p["identities"]["at"] = "garbage"; self.assertEqual(ev(p)["status"], "UNAVAILABLE", "no elapsed time -> no verdict")
    def test_inputs(self):
        self.assertEqual(ev(base=P1)["status"], "UNHEALTHY", "P1 (before --apply network) is not the baseline")
        rr = copy.deepcopy(RESTART); rr["result"]["decision"] = "ROOT: no new privacy agent within 90 s"; self.assertEqual(ev(restart=rr)["status"], "UNHEALTHY")
        rr = copy.deepcopy(RESTART); rr["result"]["agentScript"] = R.FILES["privacy"][2]; self.assertEqual(ev(restart=rr)["status"], "UNHEALTHY", "restarted onto the OLD bundle")
        self.assertEqual(ev(restart={"what": "attempt"})["status"], "UNHEALTHY")
    def test_reduced_snapshot_has_no_key_names_or_sddls(self):
        r = O.reduce(pre(), hs()); t = json.dumps(r)
        self.assertNotIn("enKeys", t); self.assertNotIn("hostEgress", t); self.assertNotIn("cfgAcl", t); self.assertNotIn("O:SYG:SYD", t)
        self.assertEqual(r["identities"]["enKeyFlags"], {"walletAdmission": False, "hostServices": False, "challengeReplica": False})
    def test_main_writes_one_receipt_per_invocation(self):
        d = pathlib.Path(tempfile.mkdtemp()); O.OUT = d; rp = d / "restart.json"; rp.write_text(json.dumps(RESTART))
        O.load_pinned = lambda: (R, HS_TEXT); O.snapshot = lambda R_, t: (pre(700), hs())
        try:
            self.assertEqual(O.main(["--baseline", str(H / "fixtures/baseline-P2.copy.json"), "--restart", str(rp)]), 2)
            __import__("time").sleep(1.1); O.snapshot = lambda R_, t: (pre(1900), hs())
            self.assertEqual(O.main(["--baseline", str(H / "fixtures/baseline-P2.copy.json"), "--restart", str(rp)]), 0)
            recs = sorted(d.glob("observe-*.json")); self.assertEqual(len(recs), 2)
            last = json.loads(recs[-1].read_text()); self.assertEqual(last["report"]["priorSnapshotsForThisRestart"][0]["status"], "INITIAL_HEALTHY")
            self.assertEqual(last["restart"]["sha256"], hashlib.sha256(rp.read_bytes()).hexdigest())
        finally: shutil.rmtree(d)
if __name__ == "__main__": unittest.main()
