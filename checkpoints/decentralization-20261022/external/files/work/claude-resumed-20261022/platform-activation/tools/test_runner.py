#!/usr/bin/env python3
"""tools/test_runner.py - helper/root-policy-activation.py with a FAKE transport (no SSH, no remote call is possible: the real ps is
replaced before the helper can load it). Checks: reused texts are the frozen ones, every remote text fits the transport and parses in
pwsh 7, the gate wrapper's own PowerShell runs a real node child against the fake bundle, the refusal rules (one perturbation each),
outcome classes, and the --activate path end to end (attempt O_EXCL, params, loader/launch texts, journal poll)."""
import copy, hashlib, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time, types, unittest
A = pathlib.Path(__file__).resolve().parents[1]; W = A.parents[1]
PWSH = os.environ.get("PWSH") or str(W / "node-hold-package-20261021/tools/pwsh/pwsh")
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
R = load("rpa", A / "helper/root-policy-activation.py")
PF = load("postflight", W / "root-control-rpc-final-20261022/control-package/postflight/postflight.py")
TRANSPORT = load("transport_text", W / "nucbox-tls-20261021/root-activate-reviewed.py")     # HEAD only; its ps is never called
CALLS = []
def fake_ps(script, secs=150): CALLS.append(script); return FAKE(script)
FAKE = lambda s: {"error": "unset"}
R.H.m.HEAD = TRANSPORT.HEAD; R.H.m.ps = fake_ps          # verify_local() keeps an existing ps: the real transport is never loaded
sha = lambda b: hashlib.sha256(b).hexdigest()
EXP = R.expected_ids()

def good_pre(at="2026-10-22T04:30:00Z"):
    lu = R.iso_epoch(at) + 1500
    return {"identities": {"cmd": [{"pid": 1, "start": "s1"}], "agent": [{"pid": 2, "parent": 1, "start": "s2"}], "privacy": [{"pid": 3, "start": "s3"}], "manager": "4@s4",
                           "vms": ",".join(f"hv{k}|{i}|running" for k, i in enumerate(EXP)) + ",hvx|shield-readiness-v1|running", "hyperv": "g|n|Running"},
            "configs": {"at": at, "node-config.cmd": {"sha": "a" * 64, "policy": 0, "hold": 0, "dacl": "AI"}, "node-config.local.cmd": {"sha": R.LOCAL_NOW, "policy": 0, "hold": 1, "dacl": "PAI"},
                        "run-node.cmd": {"sha": R.RUN_NODE_NOW, "policy": 0, "hold": 0, "dacl": "AI"}, "cfg": "c" * 64, "nodeExe": R.NODE_SHA, "persisted": {"present": False}, "policyStore": False,
                        "pdInheritReaders": ["S-1-5-18", "S-1-5-32-544"]},
            "channel": {"doc": {"generation": "5" * 32, "runnerOk": True, "expiresInMs": 20000, "allows": EXP}, "status": {"ageMs": 300, "generation": "5" * 32, "runnerOk": True, "fresh": True, "applied": True, "errorNull": True, "allows": EXP},
                        "egress": EXP, "walletWriters": ["S-1-5-18", "S-1-5-32-544"], "walletOwner": "S-1-5-18", "records": [{"id": i, "status": "running", "walletHeld": False, "leaseUntil": lu} for i in EXP]},
            "update": {"update": {"state": "Ready", "enabled": True, "next": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime(R.iso_epoch(at) + 2616))}}, "files": dict(R.F1), "localAt": time.time(), "errors": {}}
def good_gate(v="ADMISSIBLE"):
    return {"what": "gate", "bundle": R.BUNDLE_SHA, "nodeExe": R.NODE_SHA, "js": sha(R.GATEJS.read_bytes()), "runs": [{"option": "P", "result": {"verdict": v}}, {"option": "R", "result": {"verdict": v}}]}

class Texts(unittest.TestCase):
    def test_reused_texts_are_the_frozen_ones(self):
        for k in ("IDN", "UPD", "LOADER", "LAUNCH", "JOURNAL", "U", "LIMIT"): self.assertIs(getattr(R, k), getattr(R.H, k))
        self.assertEqual(R.PARSE, PF.PARSE); self.assertEqual(R.H.T[1], "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
    def test_every_remote_text_fits_and_parses(self):
        texts = {"GATE": R.gate_text(r"C:\ProgramData\Enclave\staging\policyact-0123456789ab\gate-proof.mjs"), "POL": R.POL, "CHAN": R.CHAN, "UPD": R.UPD, "IDN": R.IDN,
                 "FILES": R.FILESHA.replace("PATHSX", ",".join(R.q(p) for p in R.F1)), "PARSEFILE": R.PARSEFILE.replace("PX", r"C:\ProgramData\Enclave\staging\policyact-0123456789ab\node-policy-activation.ps1")}
        texts["GATE-parse"] = R.parse_text(texts["GATE"])
        for k, t in texts.items():
            with self.subTest(k):
                self.assertLessEqual(R.enc_len(R.H.m, t, 150), R.LIMIT)
                code = "$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseInput($env:TXT,[ref]$t,[ref]$e);$e.Count"
                out = subprocess.run([PWSH, "-NoProfile", "-Command", code], env={**os.environ, "TXT": R.H.m.HEAD.replace("SECS", "150") + t}, capture_output=True, text=True).stdout.strip()
                self.assertEqual(out, "0")
        self.assertNotIn("knownRefusal.reason", R.POL)                                   # categories only, never a reason text
    def test_gate_wrapper_runs_a_real_bounded_child(self):
        d = pathlib.Path(tempfile.mkdtemp(prefix="gw-")); shutil.copy(A / "tools/fake-bundle.mjs", d / "bundle.mjs"); (d / "fake-gate.json").write_text('{"mode":"not-activated"}')
        shutil.copy(R.GATEJS, d / "gate-proof.mjs"); node = shutil.which("node")
        t = (R.GATE.replace("BUNDLEX", str(d / "bundle.mjs")).replace("NODEX", node).replace("JSX", str(d / "gate-proof.mjs")).replace("BSHA", sha((d / "bundle.mjs").read_bytes()))
             .replace("NSHA", sha(pathlib.Path(node).resolve().read_bytes())).replace("JSHA", sha(R.GATEJS.read_bytes())).replace("OPTSX", "@(" + ",".join(f"@('{k}','{v}')" for k, v in R.OPTIONS.items()) + ")")
             .replace("RUNNERX", R.RUNNER).replace("EPX", R.ENDPOINT))
        pre = "function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}};"
        out = subprocess.run([PWSH, "-NoProfile", "-Command", pre + t], capture_output=True, text=True, timeout=200).stdout.strip().splitlines()[-1]
        o = json.loads(out); self.assertEqual([x["option"] for x in o["runs"]], ["P", "R"])
        for x in o["runs"]: self.assertEqual(x["result"]["verdict"], "ADMISSIBLE"); self.assertTrue(x["exited"]); self.assertEqual(x["code"], 0)
        self.assertEqual(o["runs"][1]["result"]["config"]["rpcHosts"], [u.split("//")[1] for u in R.R5.split(",")])
        envs = [json.loads(l)["env"] for l in (d / "fake-gate-calls.jsonl").read_text().splitlines()]
        self.assertEqual(envs, [{"ENCLAVE_PLATFORM_HOST_POLICY": "production"}, {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R.R5}])
        (d / "fake-gate.json").write_text('{"mode":"hang"}'); t0 = time.time()
        o = json.loads(subprocess.run([PWSH, "-NoProfile", "-Command", pre + t], capture_output=True, text=True, timeout=200).stdout.strip().splitlines()[-1])
        self.assertEqual([x["result"]["verdict"] for x in o["runs"]], ["UNKNOWN", "UNKNOWN"]); self.assertLess(time.time() - t0, 2 * 58)

class Refusals(unittest.TestCase):
    def test_good_state_passes_for_both_options(self):
        for opt in ("P", "R"): self.assertEqual(R.refusals(good_pre(), "activate", good_gate(), opt), [])
    def test_each_perturbation_refuses(self):
        cases = {
            "policy already assigned": lambda p, g: p["configs"]["node-config.cmd"].update(policy=1),
            "local changed": lambda p, g: p["configs"]["node-config.local.cmd"].update(sha="0" * 64),
            "no hold flag": lambda p, g: p["configs"]["node-config.local.cmd"].update(hold=0),
            "local DACL not AI": lambda p, g: p["configs"]["node-config.local.cmd"].update(dacl=""),
            "run-node changed": lambda p, g: p["configs"]["run-node.cmd"].update(sha="0" * 64),
            "persisted refusal": lambda p, g: p["configs"].update(persisted={"present": True, "hostIdOk": True, "refusal": "current"}),
            "doc expired": lambda p, g: p["channel"]["doc"].update(expiresInMs=-1),
            "status not applied": lambda p, g: p["channel"]["status"].update(applied=False),
            "status other gen": lambda p, g: p["channel"]["status"].update(generation="6" * 32),
            "id not allowed": lambda p, g: p["channel"]["status"].update(allows=EXP[1:]),
            "id not routed": lambda p, g: p.__setitem__("channel", {**p["channel"], "egress": EXP[:-1]}),
            "wallet writer": lambda p, g: p["channel"].update(walletWriters=["S-1-5-11"]),
            "held record": lambda p, g: p["channel"]["records"][0].update(walletHeld=True),
            # the window is preflight validity 600 + bound 1080 + 60 = 1740 s after the preflight (04:30): 04:55 is inside it
            "update due": lambda p, g: p["update"]["update"].update(next="2026-10-22T04:55:00Z"),
            "update queued": lambda p, g: p["update"]["update"].update(state="Queued"),
            "lease short": lambda p, g: [r.update(leaseUntil=R.iso_epoch("2026-10-22T04:30:00Z") + 800) for r in p["channel"]["records"]],
            "vm set": lambda p, g: p["identities"].update(vms="hv0|" + EXP[0] + "|running"),
            "file differs": lambda p, g: p["files"].update({R.BUNDLE: "0" * 64}),
            "node.exe": lambda p, g: p["configs"].update(nodeExe="0" * 64),
            "two agents": lambda p, g: p["identities"]["agent"].append({"pid": 9}),
            "gate unknown": lambda p, g: [x["result"].update(verdict="UNKNOWN") for x in g["runs"]],
            "gate bundle": lambda p, g: g.update(bundle="0" * 64),
            "N3": lambda p, g: p["configs"].update(pdInheritReaders=["S-1-5-32-545"]),
        }
        for name, f in cases.items():
            with self.subTest(name):
                p, g = good_pre(), good_gate(); f(p, g); self.assertTrue(R.refusals(p, "activate", g, "R"), name)
    def test_rollback_refused_on_a_persisted_refusal_only_by_policy_reason(self):
        p = good_pre(); p["configs"]["node-config.local.cmd"]["policy"] = 2
        self.assertEqual(R.refusals(p, "rollback"), [])                                  # the policy lines are expected for a rollback
        p["configs"]["persisted"] = {"present": True, "hostIdOk": True, "refusal": "current"}
        self.assertTrue(any("no OFF rollback" in x for x in R.refusals(p, "rollback")))
    def test_classify(self):
        self.assertEqual(R.classify("REFUSED_BY_POLICY: x"), "policy-refused"); self.assertEqual(R.classify("REFUSED: x"), "refused")
        self.assertEqual(R.classify("DONE: x"), "done"); self.assertEqual(R.classify("DONE_CHECK: x"), "check"); self.assertEqual(R.classify("ROLLED_BACK_R2_CHECK: x"), "check")
        self.assertEqual(R.classify("ROLLED_BACK_R2: x"), "rolled-back"); self.assertEqual(R.classify("RECOVERY_REQUIRED: x"), "recovery")

class ActivatePath(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="rpa-")); R.OUT = self.tmp; CALLS.clear()
        self.scp = []; R.subprocess = types.SimpleNamespace(run=lambda a, **k: (self.scp.append(a), types.SimpleNamespace(returncode=0, stderr=""))[1])
        R.time = types.SimpleNamespace(**{k: getattr(time, k) for k in ("time", "strftime", "gmtime", "strptime")}, sleep=lambda s: None)
    def tearDown(self): R.subprocess = subprocess; R.time = time
    def write(self, name, obj): p = self.tmp / name; p.write_text(json.dumps(obj)); return str(p)
    def test_activate_end_to_end(self):
        st = self.write("stage.json", {"what": "stage", "at": R.now(), "stage": r"C:\ProgramData\Enclave\staging\policyact-0123456789ab", "ok": True})
        pre = self.write("pre.json", {"what": "preflight", "at": R.now(), **good_pre(at=R.now())})
        gate = self.write("gate.json", {**good_gate(), "at": R.now()})
        global FAKE
        FAKE = lambda s: ({"decision": "started", "state": "Running"} if "Register-ScheduledTask" in s else
                          {"lines": ['{"step":"pins"}', '{"step":"post","final":"DONE: ok"}'], "task": "unregistered after final"} if "ReadAllLines" in s else {"error": "unexpected"})
        rc = R.main(["--activate", "--option", "R", "--stage-receipt", st, "--preflight", pre, "--gate-receipt", gate])
        self.assertEqual(rc, 0)
        att = next(self.tmp.glob("attempt-activate-*.json")); a = json.loads(att.read_text()); prm = a["params"]
        self.assertEqual(prm["option"], "R"); self.assertEqual(prm["localSha"], R.LOCAL_NOW); self.assertEqual(prm["lease"], R.LEASE); self.assertEqual(prm["expectedIds"], EXP)
        self.assertEqual(prm["bundleSha"], R.BUNDLE_SHA); self.assertEqual(len(prm["files"]), 9); self.assertEqual(prm["boundSec"], 1080); self.assertEqual(prm["endpoint"], R.ENDPOINT)
        self.assertNotIn("testRoot", prm)
        launch = next(c for c in CALLS if "Register-ScheduledTask" in c); self.assertIn("policy-act-" + a["params"]["runId"], launch)
        import base64; enc = re.search(r"-EncodedCommand ([A-Za-z0-9+/=]+)", launch).group(1); loader = base64.b64decode(enc).decode("utf-16-le")
        self.assertIn(sha(R.COORD.read_bytes()), loader); self.assertIn("-Mode 'activate'", loader); self.assertIn(a["paramsSha"], loader)
        self.assertTrue(any("params-" in " ".join(x) for x in self.scp))
        # the same attempt is never retried
        self.assertFalse(R.attempt(att.name, {}))
    def test_activate_refuses_without_an_admissible_gate(self):
        st = self.write("stage.json", {"what": "stage", "at": R.now(), "stage": "S", "ok": True}); pre = self.write("pre.json", {"what": "preflight", "at": R.now(), **good_pre(at=R.now())})
        gate = self.write("gate.json", {**good_gate("UNKNOWN"), "at": R.now()})
        self.assertEqual(R.main(["--activate", "--option", "P", "--stage-receipt", st, "--preflight", pre, "--gate-receipt", gate]), 2)
        self.assertEqual(list(self.tmp.glob("attempt-*")), []); self.assertFalse([c for c in CALLS if "Register-ScheduledTask" in c])
        with self.assertRaises(SystemExit): R.main(["--activate", "--option", "P", "--stage-receipt", st, "--preflight", pre])

class PostVerdict(unittest.TestCase):
    def setUp(self):
        self.r0 = {"params": {"option": "R", "expectedIds": EXP}}; g = "7" * 32
        self.step = {"policy": {"after": "e" * 64}, "start-node": {"channelGeneration": g}}
        pre = good_pre(); pre["configs"]["node-config.local.cmd"].update(sha="e" * 64, policy=2)
        pre["channel"]["doc"]["generation"] = g; pre["channel"]["status"]["generation"] = g
        self.post = {"configs": pre["configs"], "channel": pre["channel"], "log": {"length": 9, "admitted": 1, "notServing": 0, "notServingChange": 0, "channelOff": 0, "channelNotWritten": 0, "channelStarted": 1, "spawned": 0, "retired": 0}}
    def test_pass(self): self.assertEqual(R.post_verdict(self.r0, self.step, self.post)["verdict"], "PASS")
    def test_not_serving_since_is_fail(self): self.post["log"]["notServing"] = 1; self.assertEqual(R.post_verdict(self.r0, self.step, self.post)["verdict"], "FAIL")
    def test_policy_line_removed_is_fail(self): self.post["configs"]["node-config.local.cmd"]["policy"] = 0; self.assertEqual(R.post_verdict(self.r0, self.step, self.post)["verdict"], "FAIL")
    def test_persisted_refusal_is_fail(self): self.post["configs"]["persisted"] = {"present": True, "hostIdOk": True, "refusal": "current"}; self.assertEqual(R.post_verdict(self.r0, self.step, self.post)["verdict"], "FAIL")
    def test_rotated_is_unknown(self): self.post["log"]["rotated"] = True; self.assertEqual(R.post_verdict(self.r0, self.step, self.post)["verdict"], "UNKNOWN")
    def test_postlog_keys_distinct(self):
        keys = re.findall(r"(\w+)='([^']*)'", R.POSTLOG.split("$pats=[ordered]@{")[1].split("};")[0])
        self.assertEqual(len({v.lower() for _, v in keys}), len(keys)); self.assertEqual(len({k.lower() for k, _ in keys}), len(keys))

if __name__ == "__main__": unittest.main()
