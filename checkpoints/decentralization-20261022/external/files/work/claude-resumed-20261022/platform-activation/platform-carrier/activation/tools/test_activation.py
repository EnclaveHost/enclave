#!/usr/bin/env python3
"""tools/test_activation.py - helper/node-policy-activation.ps1 under tools/policy-mock.ps1 (Linux pwsh 7; NOT Windows evidence).
Every scenario builds a fresh scratch world (configs with an ENFORCED wallet hold, procs, VMs, leases, a REAL gate-proof.mjs child
against tools/fake-bundle.mjs), runs the composed coordinator UNCHANGED and checks its journal and the exact file bytes.
Also: the reused base functions are byte-identical to df2e58f2's (pwsh AST), and the OLD coordinator (the root-accepted
rpc-integrated cutover) REFUSES this wallet-already-enforced state without changing anything (old negative control).
  PWSH=<pwsh> python3 tools/test_activation.py -v      [MUTANT=<path to a mutated coordinator> runs the suite against it]"""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, unittest
A = pathlib.Path(__file__).resolve().parents[1]
PWSH = os.environ.get("PWSH") or str(A.parents[3] / "node-hold-package-20261021/tools/pwsh/pwsh")
SCRIPT = pathlib.Path(os.environ.get("MUTANT") or (A / "helper/node-policy-activation.ps1"))
BASE = A / "base/node-hold-cutover.ps1"; MOCK = A / "tools/policy-mock.ps1"
RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"
IDS = ["0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c", "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c",
       "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33"]
G0 = "5058e0c42e9631f4fd4400980ab557f2"
R5 = "https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org"
LOCAL0 = b'@echo off\r\nrem This box\'s own node settings, read after node-config.cmd. Updates never write this file.\r\nset NODE_APP_RAM_GB=24\r\nset ENCLAVE_NETWORK_WALLET_HOLD=1\r\n'
sha = lambda b: hashlib.sha256(b).hexdigest()
T0 = 1792643400            # 2026-10-22T04:30:00Z, the mock's clock

def world(scn, option="R", gate="not-activated", local=LOCAL0, mode="activate", before=None, lease_s=1500, persisted=None, node_cfg_extra=b""):
    d = pathlib.Path(tempfile.mkdtemp(prefix="pa-")); (d / "network/state").mkdir(parents=True); (d / "logs").mkdir(); (d / "node").mkdir(); st = d / "stage"; st.mkdir()
    (d / "node-config.local.cmd").write_bytes(local)
    (d / "node-config.cmd").write_bytes(b"@echo off\r\nset APPS=1\r\nset NODE_DIR=C:\\ProgramData\\Enclave\\node\r\n" + node_cfg_extra + b"if exist \"C:\\ProgramData\\Enclave\\node-config.local.cmd\" call \"C:\\ProgramData\\Enclave\\node-config.local.cmd\"\r\n")
    (d / "run-node.cmd").write_bytes(b"@echo off\r\ncall \"C:\\ProgramData\\Enclave\\node-config.cmd\"\r\n:loop\r\n\"node.exe\" agent.mjs\r\ngoto loop\r\n")
    (d / "network/privacy-config.json").write_text(json.dumps({"chain": {"rpc": R5.split(",")}, "enclaveNetwork": {"walletAdmission": {"file": "C:\\ProgramData\\Enclave\\network\\wallet-admission.json"}, "apps": []}}, indent=2) + "\n")
    (d / "logs/node.log").write_text("old line\n" * 20)
    (d / "gen0.txt").write_text(G0)
    (d / "expected-ids.txt").write_text("\n".join(IDS))
    (d / "leases.json").write_text(json.dumps([{"id": i, "status": "running", "leaseUntil": T0 + lease_s + 30 * k} for k, i in enumerate(IDS)]))
    (d / "vms.json").write_text(json.dumps([{"id": f"hv{k}", "name": i, "status": "running"} for k, i in enumerate(IDS)]))
    (d / "hyperv.json").write_text(json.dumps([{"Id": f"0000000{k}-0000-0000-0000-000000000000", "Name": f"enclave-app-hv{k}", "State": "Running"} for k in range(len(IDS))]))
    procs = [{"pid": 23976, "ppid": 1, "name": "cmd.exe", "cmd": 'cmd.exe /c "C:\\ProgramData\\Enclave\\run-node.cmd"', "start": "2026-10-22T03:37:27.6000000Z"},
             {"pid": 33032, "ppid": 23976, "name": "node.exe", "cmd": '"C:\\Program Files\\Enclave\\runtime\\node\\node.exe" "C:\\Program Files\\Enclave\\control\\windows\\node\\agent.mjs"', "start": "2026-10-22T03:37:27.6506510Z"},
             {"pid": 13932, "ppid": 1, "name": "node.exe", "cmd": '"node.exe" "C:\\Program Files\\Enclave\\network\\privacy-agent.mjs" --config x', "start": "2026-10-22T03:37:14.0971470Z"},
             {"pid": 4001, "ppid": 1, "name": "node.exe", "cmd": '"node.exe" "C:\\Program Files\\Enclave\\control\\windows\\vbslike\\manager\\main.mjs"', "start": "2026-10-21T12:13:07.5552110Z"}]
    (d / "procs.json").write_text(json.dumps(procs))
    if persisted is not None: (d / "node/platform-host-admission.json").write_text(json.dumps(persisted))
    shutil.copy(A / "tools/fake-bundle.mjs", d / "bundle.mjs"); (d / "fake-gate.json").write_text(json.dumps({"mode": gate}))
    shutil.copy(A / "gate/gate-proof.mjs", st / "gate-proof.mjs")
    # the mock's clock-dependent pins (procs' starts) are taken from the initial Sim the harness runs before the script
    p = {"stage": str(st), "runId": scn, "boundSec": 1080, "runner": RUNNER, "endpoint": "https://api.enclave.host/t/nucbox-k11-4", "option": option,
         "runNodeSha": sha((d / "run-node.cmd").read_bytes()), "nodeConfigSha": sha((d / "node-config.cmd").read_bytes()), "cfgSha": sha((d / "network/privacy-config.json").read_bytes()),
         "localSha": sha(local), "bundleSha": sha((d / "bundle.mjs").read_bytes()), "lease": {"revertSec": 340, "marginSec": 180, "forwardMinSec": 325, "startNodeSec": 150},
         "files": [{"path": str(d / "bundle.mjs"), "sha": sha((d / "bundle.mjs").read_bytes())}],
         "node": {"cmdPid": 23976, "cmdStart": "2026-10-22T03:37:27.6000000Z", "agentPid": 33032, "agentStart": "2026-10-22T03:37:27.6506510Z"},
         "manager": None, "privacy": {"pid": 13932, "start": None}, "vms": ",".join(sorted(f"hv{k}|{i}|running" for k, i in enumerate(IDS))),
         "hyperv": ",".join(sorted(f"0000000{k}-0000-0000-0000-000000000000|enclave-app-hv{k}|Running" for k in range(len(IDS)))), "expectedIds": IDS,
         "testRoot": str(d), "testNode": shutil.which("node"), "testBundle": str(d / "bundle.mjs")}
    if before: p["before"] = before
    return d, p

def iso(start):   # the mock sets CreationDate = parsed start (exact), the script compares 'o' text
    return subprocess.run([PWSH, "-NoProfile", "-Command", f"[datetime]::Parse('{start}').ToUniversalTime().ToString('o')"], capture_output=True, text=True).stdout.strip()

ISO = {}
def run(d, p, scenario="ok", mode="activate", script=None):
    for k in ("cmdStart", "agentStart"): ISO.setdefault(p["node"][k], iso(p["node"][k])); p["node"][k] = ISO[p["node"][k]]
    ISO.setdefault("priv", iso("2026-10-22T03:37:14.0971470Z")); p["privacy"]["start"] = ISO["priv"]
    ISO.setdefault("mgr", iso("2026-10-21T12:13:07.5552110Z")); p["manager"] = "4001@" + ISO["mgr"]
    pf = d / f"params-{mode}.json"; pf.write_text(json.dumps(p, indent=1)); ps = sha(pf.read_bytes())
    r = subprocess.run([PWSH, "-NoProfile", "-File", str(MOCK), "-Script", str(script or SCRIPT), "-Root", str(d), "-ParamsFile", str(pf), "-ParamsSha", ps, "-Mode", mode, "-Scenario", scenario],
                       capture_output=True, text=True, timeout=300)
    j = d / "stage" / f"policy-{p['runId']}.jsonl"
    lines = [json.loads(l) for l in j.read_text().splitlines()] if j.exists() else []
    return r, lines

def final(lines): return next((l["final"] for l in reversed(lines) if "final" in l), None)
def step(lines, s): return next((l for l in lines if l.get("step") == s), None)
def starts(d): return (d / "node-starts.txt").read_text().splitlines() if (d / "node-starts.txt").exists() else []
R4 = 'https://base-rpc.publicnode.com,https://mainnet.base.org,https://base-rpc.polkachu.com,https://base.drpc.org'   # the gate's own quorum for R / RC (root native 04:35:38Z)
POLICY_R = b'set ENCLAVE_PLATFORM_HOST_POLICY=production\r\nset "ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + R4.encode() + b'"\r\n'
CARRIERS = '{"importDir":"C:/ProgramData/Enclave/node/policy-import"}'
CARRIER_LINE = b'set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=' + CARRIERS.encode() + b'"\r\n'

class Activation(unittest.TestCase):
    def go(self, scn, scenario="ok", **kw):
        d, p = world(scn, **kw); r, lines = run(d, p, scenario, kw.get("mode", "activate")); self.d, self.p = d, p
        self.assertTrue(lines, f"no journal; rc={r.returncode} stdout={r.stdout[-1500:]} stderr={r.stderr[-1500:]}"); return lines

    def test_ok_R_done(self):
        lines = self.go("okR")
        self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0 + POLICY_R)          # exact byte append, nothing else
        g = step(lines, "gate"); self.assertEqual(g["proof"]["verdict"], "ADMISSIBLE"); self.assertEqual(g["proof"]["minAgree"], 3); self.assertEqual(len(g["proof"]["rpcHosts"]), 4)
        calls = [json.loads(l) for l in (self.d / "fake-gate-calls.jsonl").read_text().splitlines()]
        self.assertEqual(calls[0]["env"], {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R4})
        self.assertEqual(calls[0]["book"], None); self.assertEqual(calls[0]["stateDir"], None)
        sn = step(lines, "start-node"); self.assertTrue(sn["applied"]); self.assertNotEqual(sn["channelGeneration"], G0)
        post = step(lines, "post"); self.assertEqual(post["oldGeneration"], G0); self.assertTrue(post["privacyUnchanged"]); self.assertTrue(post["othersAsPinned"])
        self.assertEqual(post["log"]["admitted"], 1); self.assertEqual(post["log"]["channelStarted"], 1)
        self.assertEqual(len(starts(self.d)), 1); self.assertIn("policyOn=True", starts(self.d)[0])
        self.assertFalse((self.d / "privacy-kills.txt").exists())                                        # never a privacy restart
        bk = step(lines, "backups"); self.assertEqual(pathlib.Path(bk["localBackup"]).read_bytes(), LOCAL0)
        for f in ("run-node.cmd", "node-config.cmd", "network/privacy-config.json"): self.assertEqual(sha((self.d / f).read_bytes()), self.p[{"run-node.cmd": "runNodeSha", "node-config.cmd": "nodeConfigSha", "network/privacy-config.json": "cfgSha"}[f]])

    def test_ok_P_done(self):
        lines = self.go("okP", option="P", local=LOCAL0[:-2])          # no final CRLF: one separator is added, never re-encoded
        self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0 + b"set ENCLAVE_PLATFORM_HOST_POLICY=production\r\n")
        self.assertEqual(json.loads((self.d / "fake-gate-calls.jsonl").read_text().splitlines()[0])["env"], {"ENCLAVE_PLATFORM_HOST_POLICY": "production"})

    def test_stale_retire_line_is_not_an_expected_retire(self):
        lines = self.go("stale", "retire-stale"); self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        l = step(lines, "post")["log"]; self.assertEqual(l["retiredExpected"], 0); self.assertEqual(l["retiredOther"], 1)

    def test_expected_retire_is_check(self):
        lines = self.go("exp", "retire-expected"); self.assertTrue(final(lines).startswith("DONE_CHECK:"), final(lines))

    def assertUnchanged(self, lines):
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0); self.assertEqual(starts(self.d), [])
        self.assertFalse((self.d / "node-stops.txt").exists()); self.assertIsNone(step(lines, "stop-node"))

    def test_gate_unknown_refuses_before_anything(self):
        lines = self.go("gu", gate="unreadable"); self.assertTrue(final(lines).startswith("REFUSED: the installed gate did not prove"), final(lines)); self.assertUnchanged(lines)

    def test_gate_ban_refuses_before_anything(self):
        lines = self.go("gb", gate="ban"); self.assertIn("NOT_ADMISSIBLE", final(lines)); self.assertUnchanged(lines)

    def test_gate_inactive_row_refuses(self):
        lines = self.go("gi", gate="inactive"); self.assertTrue(final(lines).startswith("REFUSED"), final(lines)); self.assertUnchanged(lines)

    def test_policy_already_named_refuses(self):
        for name, kw in (("loc", {"local": LOCAL0 + b"set ENCLAVE_PLATFORM_HOST_POLICY=off\r\n"}), ("ncfg", {"node_cfg_extra": b'set "ENCLAVE_PLATFORM_HOST_POLICY_RPCS=x"\r\n'})):
            with self.subTest(name):
                lines = self.go("pn" + name, **kw); self.assertIn("already assigns ENCLAVE_PLATFORM_HOST_POLICY", final(lines)); self.assertEqual(starts(self.d), [])

    def test_wallet_not_enforced_refuses(self):
        d, p = world("wne"); (d / "gen0.txt").write_text("not-a-generation"); r, lines = run(d, p)
        self.assertIn("the wallet hold is not enforced as pinned", final(lines)); self.assertEqual(starts(d), [])

    def test_no_hold_flag_refuses(self):
        lines = self.go("nh", local=LOCAL0.replace(b"set ENCLAVE_NETWORK_WALLET_HOLD=1\r\n", b"")); self.assertIn("exactly one wallet hold flag", final(lines))

    def test_persisted_refusal_refuses(self):
        lines = self.go("pr", persisted={"hostId": RUNNER, "knownRefusal": {"status": "current", "reason": "x", "at": 1}})
        self.assertIn("already holds a platform refusal", final(lines)); self.assertUnchanged(lines)

    def test_lease_short_refuses(self):
        lines = self.go("ls", lease_s=600); self.assertIn("lease deadline", final(lines)); self.assertUnchanged(lines)

    def test_update_due_refuses(self):
        lines = self.go("ud", "update-due"); self.assertIn("Update", final(lines)); self.assertUnchanged(lines)

    def test_local_acl_not_ai_refuses(self):
        lines = self.go("acl", "local-acl-no-ai"); self.assertIn("not auto-inherited", final(lines)); self.assertUnchanged(lines)

    def test_gate_never_admits_rolls_back_exactly(self):
        lines = self.go("gn", "gate-never")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_R2:"), final(lines))
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0)
        st = starts(self.d); self.assertEqual(len(st), 2); self.assertIn("policyOn=True", st[0]); self.assertIn("policyOn=False", st[1])
        rv = step(lines, "revert") or next(l for l in lines if "final" in l)
        self.assertTrue(rv.get("channelApplied")); self.assertNotIn(rv["channelGeneration"], (G0,))
        self.assertFalse((self.d / "privacy-kills.txt").exists())

    def test_explicit_ban_after_start_is_never_rolled_back(self):
        lines = self.go("ban", "gate-bans")
        self.assertTrue(final(lines).startswith("REFUSED_BY_POLICY:"), final(lines))
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0 + POLICY_R)           # the gate stays ON
        self.assertEqual(len(starts(self.d)), 1); self.assertIsNone(step(lines, "revert"))

    def test_flap_once_is_check_not_rollback(self):
        lines = self.go("flap", "gate-flap-once"); self.assertTrue(final(lines).startswith("DONE_CHECK:"), final(lines))
        self.assertEqual(step(lines, "post")["log"]["notServing"], 1); self.assertEqual(len(starts(self.d)), 1)

    def test_network_ignores_new_generation_rolls_back_then_check(self):
        lines = self.go("ign", "net-ignores-new-gen")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_R2_CHECK:"), final(lines))      # the revert's own channel cannot apply either
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0)

    def test_concurrent_local_edit_is_recovery_not_overwrite(self):
        lines = self.go("cle", "concurrent-local-edit-gate-never")
        f = final(lines)
        self.assertTrue(f.startswith("RECOVERY_REQUIRED"), f); self.assertIn(b"rem concurrent operator change", (self.d / "node-config.local.cmd").read_bytes())

    def test_write_failure_rolls_back_r0(self):
        lines = self.go("wf", "local-write-fails"); self.assertTrue(final(lines).startswith("ROLLED_BACK_R0:"), final(lines))
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0); self.assertIn("policyOn=False", starts(self.d)[-1])

    def test_acl_failure_after_replace_is_recovery_never_a_guess(self):
        # the base's rule: a write that may have landed is 'unknown-write'; the revert's CAS then refuses -> RECOVERY_REQUIRED, node stopped
        lines = self.go("wa", "local-acl-after-replace"); f = final(lines)
        self.assertTrue(f.startswith("RECOVERY_REQUIRED: node-config.local.cmd was not restored"), f); self.assertEqual(starts(self.d), [])
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0 + POLICY_R)

    def test_task_api_throw_after_stop_goes_through_the_one_revert(self):
        # (mock path: the task cmdlet throws after stopping; the native Invoke-TaskCommand 'unknown outcome' path is the base's,
        # unchanged, and ends RECOVERY_REQUIRED without any retry)
        lines = self.go("tk", "throw-after-task-stop")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_AFTER_CRASH:"), final(lines)); self.assertEqual(len(starts(self.d)), 1)
        self.assertEqual((self.d / "node-config.local.cmd").read_bytes(), LOCAL0); self.assertIn("policyOn=False", starts(self.d)[0])

    def test_rollback_after_done(self):
        d, p = world("rbbase"); r, lines = run(d, p); self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        bk, pol = step(lines, "backups"), step(lines, "policy")
        # the rollback is pinned to the CURRENT node (the activation's) and the current local (its after sha)
        cur = json.loads((d / "procs-state.json").read_text()); cmd = next(x for x in cur if x["name"] == "cmd.exe" and "run-node" in x["cmd"]); ag = next(x for x in cur if "node\\agent.mjs" in x["cmd"])
        q = dict(p); q["runId"] = "rbbase-rb"; q["localSha"] = pol["after"]; q["node"] = {"cmdPid": cmd["pid"], "cmdStart": cmd["start"], "agentPid": ag["pid"], "agentStart": ag["start"]}
        q["before"] = {"local": {"before": p["localSha"], "after": pol["after"], "backup": bk["localBackup"]}}
        (d / "procs.json").write_text(json.dumps(cur)); (d / "gen0.txt").write_text(step(lines, "start-node")["channelGeneration"])
        r2, l2 = run(d, q, "ok", "rollback")
        self.assertTrue(final(l2).startswith("ROLLED_BACK:"), final(l2)); self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0)
        self.assertIn("policyOn=False", starts(d)[-1])

    def test_rollback_refused_while_a_refusal_is_persisted(self):
        d, p = world("rbp", persisted={"hostId": RUNNER, "knownRefusal": {"status": "current", "reason": "x", "at": 1}}, local=LOCAL0 + POLICY_R)
        p["before"] = {"local": {"before": sha(LOCAL0), "after": sha(LOCAL0 + POLICY_R), "backup": str(d / "bk")}}; (d / "bk").write_bytes(LOCAL0)
        r, lines = run(d, p, "ok", "rollback"); self.assertIn("would bypass the admin decision", final(lines)); self.assertEqual(starts(d), [])

class CarrierOptions(unittest.TestCase):     # platform-carrier
    def test_rc_appends_the_carrier_line_and_the_gate_proof_sees_it(self):
        d, p = world("okRC", option="RC"); r, lines = run(d, p)
        self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0 + POLICY_R + CARRIER_LINE)
        env = json.loads((d / "fake-gate-calls.jsonl").read_text().splitlines()[0])["env"]
        self.assertEqual(env, {"ENCLAVE_PLATFORM_HOST_POLICY": "production", "ENCLAVE_PLATFORM_HOST_POLICY_RPCS": R4, "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS": CARRIERS})
        self.assertEqual(json.loads(env["ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS"]), {"importDir": "C:/ProgramData/Enclave/node/policy-import"})
    def test_pc_appends_exactly_two_lines(self):
        d, p = world("okPC", option="PC"); r, lines = run(d, p)
        self.assertTrue(final(lines).startswith("DONE:"), final(lines))
        self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0 + b"set ENCLAVE_PLATFORM_HOST_POLICY=production\r\n" + CARRIER_LINE)
    def test_rc_rollback_restores_exact_bytes(self):
        d, p = world("rcgn", option="RC"); r, lines = run(d, p, "gate-never")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_R2:"), final(lines)); self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0)
    def test_unknown_option_refused(self):
        d, p = world("optX", option="RX"); r, lines = run(d, p); self.assertIn("no pinned policy option", final(lines)); self.assertEqual(starts(d), [])

class Structure(unittest.TestCase):
    def fns(self, path):
        code = ("$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('" + str(path) + "',[ref]$t,[ref]$e);"
                "$o=[ordered]@{errors=$e.Count;fns=[ordered]@{}};foreach($f in $a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){$o.fns[$f.Name]=$f.Extent.Text};$o|ConvertTo-Json -Depth 4 -Compress")
        return json.loads(subprocess.run([PWSH, "-NoProfile", "-Command", code], capture_output=True, text=True).stdout)
    def test_reused_functions_identical_to_base(self):
        b, n = self.fns(BASE), self.fns(SCRIPT); self.assertEqual(n["errors"], 0)
        reused = ["Iso", "Left", "NowS", "LeaseLeft", "ForwardLeft", "Lim", "NeedForward", "UpdateDecision", "UpdateState", "Now", "NowMs", "IsoMs", "ShaBytes", "Sha", "Log", "Final",
                  "Invoke-BoundedQuery", "Query", "PollRoom", "Utc", "ProcessRows", "ById", "Same", "NodeProcs", "Privacy", "Listeners", "Manager", "Others", "HostState", "Vms", "HyperV",
                  "Known", "ReadinessNumber", "LeaseReady", "OwnsAgentPort", "AgentUp", "Status", "EgressApps", "LogFrom", "Writers", "Readers", "CasWrite",
                  "WaitNodeGone", "Invoke-TaskCommand", "NodeTask", "StopNode", "NodeStopped", "StartNode", "FreshStatus", "RestoreOne", "Recovery", "Identity"]
        for f in reused:
            with self.subTest(f): self.assertEqual(n["fns"].get(f), b["fns"][f])
        self.assertNotIn("RestartPrivacy", n["fns"]); self.assertNotIn("RunNodeEdit", n["fns"])   # no privacy restart, no launcher edit
    def test_compose_reproduces(self):
        before = sha((A / "helper/node-policy-activation.ps1").read_bytes())
        subprocess.run([sys.executable, str(A / "helper/compose.py")], check=True, capture_output=True)
        self.assertEqual(sha((A / "helper/node-policy-activation.ps1").read_bytes()), before)
    def test_writes_only_node_config_local(self):
        t = SCRIPT.read_text()
        targets = set(re.findall(r"CasWrite \$(\w+)", t)); self.assertEqual(targets - {"path"}, {"LOCAL"})
        self.assertNotIn("Stop-Process -Id $pin.pid", t.split("function StopNode")[0])   # no privacy-agent kill outside the base StopNode
        self.assertNotRegex(t, r"Start-ScheduledTask[^\n]*Network|Stop-ScheduledTask[^\n]*Network")
    def test_log_patterns_are_distinct_case_insensitively(self):
        t = SCRIPT.read_text(); pats = re.search(r"\$LOGPATS = @\((.*?)\)\n", t, re.S).group(1)
        keys = re.findall(r"'([^']*)'", pats); self.assertEqual(len({k.lower() for k in keys}), len(keys), keys)

class TempSafetyR5(unittest.TestCase):     # platform-carrier r5: exclusive temp, never deleting what this run did not create
    def run_fn(self, script, scenario):
        """the coordinator's ProtectedTemp, its random suffix fixed to 'deadbeef' (test-only text substitution), with stub ACL cmdlets"""
        fns = Structure().fns(script)["fns"]; body = fns["ProtectedTemp"].replace("[guid]::NewGuid().ToString('N').Substring(0, 8)", "'deadbeef'")
        d = pathlib.Path(tempfile.mkdtemp(prefix="pa-temp-")); ref = d / "node-config.local.cmd"; ref.write_bytes(b"x"); tmp = pathlib.Path(str(ref) + ".nh-deadbeef")
        if scenario.startswith("foreign"): tmp.write_bytes(b"FOREIGN")
        setacl = "throw 'mock: ACL refused'" if scenario.endswith("aclfail") else ""
        code = ("function Get-Acl { param($LiteralPath) [pscustomobject]@{ Sddl = 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)' } }; function Set-Acl { param($LiteralPath, $AclObject) " + setacl + " }; "
                + body + "; try { $t = ProtectedTemp '" + str(ref) + "' '.nh-'; 'RET ' + $t } catch { 'THREW ' + $_.Exception.Message }")
        out = subprocess.run([PWSH, "-NoProfile", "-Command", code], capture_output=True, text=True).stdout.strip()
        return out, (tmp.read_bytes() if tmp.exists() else None)
    def test_existing_name_is_never_truncated_or_deleted(self):
        out, left = self.run_fn(SCRIPT, "foreign-aclfail"); self.assertTrue(out.startswith("THREW"), out); self.assertEqual(left, b"FOREIGN")
        out, left = self.run_fn(SCRIPT, "foreign"); self.assertTrue(out.startswith("THREW"), out); self.assertEqual(left, b"FOREIGN")
    def test_own_temp_created_empty_and_removed_only_on_its_own_failure(self):
        out, left = self.run_fn(SCRIPT, "ok"); self.assertTrue(out.startswith("RET "), out); self.assertEqual(left, b"")
        out, left = self.run_fn(SCRIPT, "aclfail"); self.assertTrue(out.startswith("THREW"), out); self.assertIsNone(left)
    def test_negative_control_base_truncates_and_deletes_a_foreign_file(self):
        out, left = self.run_fn(BASE, "foreign-aclfail"); self.assertTrue(out.startswith("THREW"), out); self.assertIsNone(left, "the base deleted a file it did not create")
        out, left = self.run_fn(BASE, "foreign"); self.assertTrue(out.startswith("RET"), out); self.assertEqual(left, b"", "the base truncated a file it did not create")
    def test_backup_exclusive_and_existing_private_dir_checked(self):
        t = SCRIPT.read_text()
        self.assertNotIn("WriteAllBytes($before.local.backup", t); self.assertIn("[IO.File]::Open($before.local.backup, [IO.FileMode]::CreateNew", t)
        pd = Structure().fns(SCRIPT)["fns"]["PrivDir"]; self.assertIn("AreAccessRulesProtected", pd); self.assertIn("ReparsePoint", pd); self.assertIn("GetOwner", pd)
        self.assertNotIn("WriteAllBytes($tmp, [byte[]]@())", Structure().fns(SCRIPT)["fns"]["ProtectedTemp"])
        cw = Structure().fns(SCRIPT)["fns"]["CasWrite"]; self.assertIn("aclKept = ((Get-Acl -LiteralPath $path).Sddl -eq $acl.Sddl)", cw)   # full SDDL incl. owner

class OldNegativeControl(unittest.TestCase):
    def test_base_cutover_refuses_the_enforced_state(self):
        """the root-accepted rpc-integrated cutover (df2e58f2) must NOT be rerun now: it REFUSES, nothing changes"""
        d, p = world("old"); p.update({"runNodeNewSha": "0" * 64, "nodeExe": "x", "nodeSha": "x"})
        r, _ = run(d, p, "ok", "cutover", script=BASE)
        j = [json.loads(l) for l in (d / "stage" / "cutover-old.jsonl").read_text().splitlines()]
        f = final(j); self.assertTrue(f.startswith("REFUSED"), f); self.assertIn("a wallet-admission.json already exists", f); self.assertIn("already names the flag", f)
        self.assertEqual((d / "node-config.local.cmd").read_bytes(), LOCAL0); self.assertEqual(starts(d), [])

if __name__ == "__main__": unittest.main()
