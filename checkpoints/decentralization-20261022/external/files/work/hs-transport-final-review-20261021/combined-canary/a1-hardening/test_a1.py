#!/usr/bin/env python3
"""Fixture tests for the hardened root-a1-provider.py. The REAL remote program runs locally against a temp tree, with fake
systemctl / nft / journalctl / node first on PATH. The fake systemd derives the running argv from the drop-ins, exactly as
systemd does (the last ExecStart= wins). No ssh, no front, no production."""
import base64, hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("a1", HERE / "root-a1-provider.py"); A1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(A1)
sha = lambda b: hashlib.sha256(b).hexdigest()

FAKE_SYSTEMCTL = r'''#!/usr/bin/env python3
import os, sys
D, log = os.environ["FAKE_DROPINS"], os.environ["FAKE_LOG"]
a = sys.argv[1:]; open(log, "a").write("systemctl " + " ".join(a) + "\n")
import time
def nth(kind):   # 1-based count of this kind of call; FAKE_<KIND>_FAIL_AT / _HANG_AT = comma list of call numbers
    c = os.path.join(os.path.dirname(log), "count-" + kind); n = int(open(c).read()) + 1 if os.path.exists(c) else 1
    open(c, "w").write(str(n)); return n
for kind, cmd in (("RELOAD", "daemon-reload"), ("RESTART", "restart")):
    if a[0] == cmd:
        n = nth(kind)
        if str(n) in os.environ.get("FAKE_%s_HANG_AT" % kind, "").split(","): time.sleep(5)
        if str(n) in os.environ.get("FAKE_%s_FAIL_AT" % kind, "").split(","): sys.stderr.write("Job failed\n"); sys.exit(1)
def argv():
    v = ""
    for f in sorted(os.listdir(D)):
        for l in open(os.path.join(D, f)):
            if l.startswith("ExecStart="): v = l.strip()[len("ExecStart="):]   # an empty ExecStart= resets, the last wins
    return v
if a[0] == "show":
    if "--value" in a: print("{ path=x ; argv[]=%s ; ignore_errors=no }" % argv())
    else: print("ActiveState=active\nMainPID=4242\nNRestarts=0")
'''
FAKE_NFT = r'''#!/usr/bin/env python3
import os, sys
D = os.environ["FAKE_DROPINS"]; a = sys.argv[1:]
if a[:2] == ["-c", "-f"]: sys.exit(0)
import time
c = os.path.join(os.path.dirname(os.environ["FAKE_LOG"]), "count-NFT"); n = int(open(c).read()) + 1 if os.path.exists(c) else 1
open(c, "w").write(str(n))
if str(n) in os.environ.get("FAKE_NFT_HANG_AT", "").split(","): time.sleep(5)
argv = ""
for f in sorted(os.listdir(D)):
    for l in open(os.path.join(D, f)):
        if l.startswith("ExecStart="): argv = l.strip()
print("table inet enclave_net {\n set egress4 {\n  type ipv4_addr\n  elements = { 10.0.0.1 }\n }\n chain forward {")
new = os.environ["FAKE_NEW"]
if new in argv: print('  iifname "eth0" oifname "wg-exit" ct status dnat udp dport 53 drop')
if new in argv and os.environ.get("FAKE_NFT_EXTRA"): print("  " + os.environ["FAKE_NFT_EXTRA"])
print("  ct state established,related accept\n }\n}")
'''
FAKE_NODE = r'''#!/usr/bin/env python3
import os, sys
if "--check-config" in sys.argv: sys.exit(int(os.environ.get("FAKE_CHECK_RC", "0")))
if "--ruleset" in sys.argv: print("table inet enclave_net {}")
'''

class Fx:
    def __init__(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="a1fx-")); t = self.t
        self.bin = t / "bin"; self.bin.mkdir()
        for n, body in (("systemctl", FAKE_SYSTEMCTL), ("nft", FAKE_NFT), ("journalctl", "#!/bin/sh\nexit 0\n"), ("node", FAKE_NODE)):
            (self.bin / n).write_text(body); (self.bin / n).chmod(0o755)
        self.D = t / "dropins"; self.D.mkdir(); self.log = t / "calls.log"; self.log.write_text("")
        (t / "opt/old").mkdir(parents=True); (t / "opt/new").mkdir(parents=True); (t / "etc").mkdir()
        self.live_bundle = t / "opt/old/provider.mjs"; self.live_bundle.write_bytes(b"old bundle 464cad3")
        self.live_cfg = t / "etc/provider-pinned.json"; self.live_cfg.write_text(json.dumps({"publicAddress": "146.190.246.39", "roles": ["guard", "ingress", "egress"]}, indent=1) + "\n")
        self.rel = t / "opt/new"; (self.rel / "wg-provider.mjs").write_bytes(b"new bundle 39d1513b")
        self.cfg = {"a1": str(t / "etc/hs-a1.json"), "a5": str(t / "etc/hs-a5.json")}
        node = str(self.bin / "node")
        dropins = {"directories.conf": "[Service]\nExecStart=\nExecStart=%s %s/nan.mjs %s\n" % (node, t, self.live_cfg),
                   "zz-authority-pins.conf": "[Service]\nExecStart=\nExecStart=%s %s/pins.mjs %s\n" % (node, t, self.live_cfg),
                   "zzz-native-ingress.conf": "[Service]\nExecStart=\nExecStart=%s %s %s\n" % (node, self.live_bundle, self.live_cfg)}
        for n, b in dropins.items(): (self.D / n).write_text(b)
        self.node = node
    def params(self, mode, step, stage_sha=None, **over):
        p = A1.params("ca-east", mode, step, stage_sha)
        p.update(node=self.node, rel=str(self.rel), cfg=self.cfg, liveCfg=str(self.live_cfg), liveBundle=str(self.live_bundle), dropinDir=str(self.D),
                 liveBundleSha=sha(self.live_bundle.read_bytes()), liveConfigSha=sha(self.live_cfg.read_bytes()), bundleSha=sha((self.rel / "wg-provider.mjs").read_bytes()),
                 upload=str(self.rel / "wg-provider.mjs"), dropins={n: sha((self.D / n).read_bytes()) for n in A1.DROPINS}, files=[], sleepScale=0)
        live = [self.node, str(self.live_bundle), str(self.live_cfg)]
        a1 = [self.node, str(self.rel) + "/wg-provider.mjs", self.cfg["a1"]]; a5 = [self.node, str(self.rel) + "/wg-provider.mjs", self.cfg["a5"]]
        p["argvBefore"] = {("execute", "a1"): live, ("execute", "a5"): a1, ("rollback", "a5"): a5, ("rollback", "a1"): a1}.get((mode, step))
        p["argvAfter"] = {("execute", "a1"): a1, ("execute", "a5"): a5, ("rollback", "a5"): a1, ("rollback", "a1"): live}.get((mode, step))
        p.update(over); return p
    def remote(self, p, **env):
        prog = "import base64, json\nP = json.loads(base64.b64decode(%r))\n" % base64.b64encode(json.dumps(p).encode()).decode() + A1.REMOTE
        e = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_DROPINS": str(self.D), "FAKE_LOG": str(self.log), "FAKE_NEW": str(self.rel) + "/wg-provider.mjs", **env}
        r = subprocess.run([sys.executable, "-"], input=prog, capture_output=True, text=True, env=e, timeout=60)
        return json.loads(r.stdout.strip().splitlines()[-1])
    def stage(self, step, **env):
        r = self.remote(self.params("stage", step), **env); return r, r.get("stage", {}).get("configSha")
    def restarts(self): return [l for l in self.log.read_text().splitlines() if l.startswith("systemctl restart")]
    def ours(self): return (self.D / A1.DROPIN).exists()

GATE = 'iifname "eth0" oifname "wg-exit" ct status dnat udp dport 53 drop'

class A1Hardening(unittest.TestCase):
    def test_execute_a1_success_exact_rules_diff(self):
        fx = Fx(); _, c = fx.stage("a1")
        r = fx.remote(fx.params("execute", "a1", c))
        self.assertEqual(r.get("verdict"), "OK", r); self.assertTrue(r.get("prechecked"))
        self.assertEqual(r["diff"], {"added": [GATE], "removed": []}); self.assertTrue(fx.ours()); self.assertEqual(len(fx.restarts()), 1)

    def assertRefusedUntouched(self, fx, r, why):
        self.assertIn(why, r.get("refused", ""), r); self.assertFalse(fx.ours(), "no drop-in written"); self.assertEqual(fx.restarts(), [], "nothing restarted")
        self.assertNotIn("prechecked", r)

    def test_new_bundle_drift_refuses_before_any_change(self):
        fx = Fx(); _, c = fx.stage("a1"); p = fx.params("execute", "a1", c)
        (fx.rel / "wg-provider.mjs").write_bytes(b"tampered")
        self.assertRefusedUntouched(fx, fx.remote(p), "the release bundle is not")

    def test_derived_config_drift_refuses(self):
        fx = Fx(); _, c = fx.stage("a1"); p = fx.params("execute", "a1", c)
        with open(fx.cfg["a1"], "a") as f: f.write(" ")
        self.assertRefusedUntouched(fx, fx.remote(p), "is not the config derived")

    def test_stage_receipt_sha_mismatch_refuses(self):
        fx = Fx(); fx.stage("a1")
        self.assertRefusedUntouched(fx, fx.remote(fx.params("execute", "a1", "00" * 32)), "not the one the stage receipt approved")

    def test_original_bundle_or_live_config_drift_refuses(self):
        for target, why in (("live_bundle", "original bundle"), ("live_cfg", "live config")):
            fx = Fx(); _, c = fx.stage("a1"); p = fx.params("execute", "a1", c)
            getattr(fx, target).write_bytes(getattr(fx, target).read_bytes() + b"\n")
            self.assertRefusedUntouched(fx, fx.remote(p), why)

    def test_an_extra_override_dropin_refuses(self):
        fx = Fx(); _, c = fx.stage("a1"); p = fx.params("execute", "a1", c)
        # an override that leaves ExecStart alone (e.g. an injected Environment=): the argv CAS cannot see it, the set check must
        (fx.D / "zzzzzz-other.conf").write_text("[Service]\nEnvironment=ENCLAVE_PLATFORM_HOST_POLICY=off\n")
        self.assertRefusedUntouched(fx, fx.remote(p), "the drop-in set is")

    def test_stage_check_config_failure_is_not_ok_and_execute_refuses_locally(self):
        fx = Fx(); r, _ = fx.stage("a1", FAKE_CHECK_RC="1")
        self.assertEqual(r["stage"]["checkConfigRc"], 1); self.assertEqual(fx.restarts(), [], "a stage never restarts")
        d = pathlib.Path(tempfile.mkdtemp()); rec = d / "stage.json"
        rec.write_text(json.dumps({"what": "stage", "at": A1.now(), "front": "ca-east", "step": "a1", "ok": False, "result": r}))
        called = []; A1.remote = lambda *a, **k: called.append(a) or {}
        with self.assertRaises(SystemExit): A1.main(["ca-east", "--execute", "a1", "--stage-receipt", str(rec)])
        rec.write_text(json.dumps({"what": "stage", "at": A1.now(), "front": "ca-east", "step": "a1", "ok": True, "result": {"stage": {}}}))
        with self.assertRaises(SystemExit): A1.main(["ca-east", "--execute", "a1", "--stage-receipt", str(rec)])
        self.assertEqual(called, [], "nothing remote was asked")

    def test_unexpected_rules_diff_rolls_back_to_the_pinned_original(self):
        fx = Fx(); _, c = fx.stage("a1")
        r = fx.remote(fx.params("execute", "a1", c), FAKE_NFT_EXTRA="meta l4proto tcp accept")
        self.assertEqual(r.get("verdict"), "FAILED (verdict), rolled back", r); self.assertFalse(fx.ours(), "our drop-in removed")
        self.assertEqual(r["autoRollback"]["argv"], [fx.node, str(fx.live_bundle), str(fx.live_cfg)])

    def test_rollback_a1_restores_original_and_rollback_a5_checks_its_target(self):
        fx = Fx(); _, c = fx.stage("a1"); fx.remote(fx.params("execute", "a1", c))
        fx.log.write_text("")
        r = fx.remote(fx.params("rollback", "a1"))
        self.assertEqual(r.get("verdict"), "OK", r); self.assertFalse(fx.ours())
        # a5 in place by hand (DNS stays blocked; this only exercises the rollback target pin): a1 config drifted -> refused
        fx2 = Fx(); _, c1 = fx2.stage("a1"); fx2.stage("a5"); (fx2.D / A1.DROPIN).write_text(
            "[Service]\nExecStart=\nExecStart=%s %s/wg-provider.mjs %s\n" % (fx2.node, fx2.rel, fx2.cfg["a5"]))
        with open(fx2.cfg["a1"], "a") as f: f.write(" ")
        r = fx2.remote(fx2.params("rollback", "a5"))
        self.assertIn("is not the config derived", r.get("refused", ""), r); self.assertEqual(fx2.restarts(), [])

class FailurePaths(unittest.TestCase):
    """exceptions AFTER the drop-in write: one pinned rollback, reported; BEFORE it: nothing reversed (nothing changed)"""
    def run_exec(self, **env):
        fx = Fx(); _, c = fx.stage("a1")
        for f in fx.t.glob("count-*"): f.unlink()
        fx.log.write_text("")
        return fx, fx.remote(fx.params("execute", "a1", c, timeoutScale=0.02), **env)   # 0.02: restart 1.8 s, probes 1.2 s; hangs are 5 s
    def assertRolledBack(self, fx, r, err):
        self.assertIn(err, r.get("error", ""), r); self.assertTrue(r.get("mutated"))
        self.assertEqual(r.get("verdict"), "FAILED (exception after the drop-in write), rolled back", r)
        self.assertTrue(r["autoRollback"]["active"]); self.assertEqual(r["autoRollback"]["argv"], [fx.node, str(fx.live_bundle), str(fx.live_cfg)])
        self.assertFalse(fx.ours(), "our drop-in removed"); self.assertFalse((fx.D / (A1.DROPIN + ".tmp")).exists())
    def test_restart_nonzero_exit_rolls_back(self):
        fx, r = self.run_exec(FAKE_RESTART_FAIL_AT="1"); self.assertRolledBack(fx, r, "restart")
    def test_restart_timeout_rolls_back(self):
        fx, r = self.run_exec(FAKE_RESTART_HANG_AT="1"); self.assertRolledBack(fx, r, "TimeoutExpired")
    def test_daemon_reload_nonzero_exit_rolls_back(self):
        fx, r = self.run_exec(FAKE_RELOAD_FAIL_AT="1"); self.assertRolledBack(fx, r, "daemon-reload")
    def test_post_restart_probe_timeout_rolls_back(self):
        fx, r = self.run_exec(FAKE_NFT_HANG_AT="3")        # nft call 1 = facts(), 2 = the pre-mutation rules, 3 = after the restart
        self.assertRolledBack(fx, r, "TimeoutExpired")
    def test_pre_mutation_probe_timeout_is_not_rolled_back(self):
        fx, r = self.run_exec(FAKE_NFT_HANG_AT="2")        # the pre-mutation rules read
        self.assertIn("TimeoutExpired", r.get("error", ""), r); self.assertNotIn("mutated", r); self.assertNotIn("autoRollback", r)
        self.assertNotIn("verdict", r); self.assertFalse(fx.ours()); self.assertEqual(fx.restarts(), [])
    def test_rollback_that_raises_is_unknown_root_without_loops(self):
        fx, r = self.run_exec(FAKE_RESTART_FAIL_AT="1,2")
        self.assertTrue(r["verdict"].startswith("UNKNOWN: ROOT attention"), r); self.assertIn("error", r["autoRollback"])
        self.assertEqual(len(fx.restarts()), 2, "the change, then ONE rollback attempt: no loop")
    def test_rollback_mode_exception_is_unknown_not_reversed(self):
        fx = Fx(); _, c = fx.stage("a1"); fx.remote(fx.params("execute", "a1", c))
        for f in fx.t.glob("count-*"): f.unlink()
        fx.log.write_text("")
        r = fx.remote(fx.params("rollback", "a1", timeoutScale=0.02), FAKE_RESTART_FAIL_AT="1")
        self.assertTrue(r["verdict"].startswith("UNKNOWN: ROOT attention"), r); self.assertNotIn("autoRollback", r)
        self.assertEqual(len(fx.restarts()), 1)
    def test_local_exit_codes_for_the_new_verdicts(self):
        d = pathlib.Path(tempfile.mkdtemp()); rec = d / "stage.json"
        rec.write_text(json.dumps({"what": "stage", "at": A1.now(), "front": "ca-east", "step": "a1", "ok": True, "result": {"stage": {"configSha": "ab" * 32}}}))
        for verdict, code in (("OK", 0), ("FAILED (exception after the drop-in write), rolled back", 2), ("FAILED (verdict), rolled back", 2),
                              ("ROOT: failed (verdict) AND the rollback did not verify", 3), ("UNKNOWN: ROOT attention: x", 3), (None, 3)):
            A1.OUT = pathlib.Path(tempfile.mkdtemp()) / "runs"                 # one attempt journal per run, never reused
            A1.remote = lambda *a, **k: ({"verdict": verdict} if verdict else {"error": "x"})
            self.assertEqual(A1.main(["ca-east", "--execute", "a1", "--stage-receipt", str(rec)]), code, verdict)

if __name__ == "__main__":
    unittest.main(verbosity=2)
