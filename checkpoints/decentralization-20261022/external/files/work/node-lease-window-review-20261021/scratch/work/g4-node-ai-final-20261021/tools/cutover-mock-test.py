#!/usr/bin/env python3
"""Scenario tests of node-hold-cutover.ps1 (the package's bytes) under tools/cutover-mock.ps1 on Linux pwsh 7.
Proves the DECISIONS (order, the single revert coordinator, exact restores, RECOVERY_REQUIRED on every refusal, temp ACL
ordering, identity enforcement, refusals, lock, crash trap) - NOT native Windows behaviour.
G4 final package: + G-UPD (\\Enclave\\Update running / due inside the bound refuses), N3 (read principals), N2 (a throw before
the old '$phase = pins' line never reaches Revert; negative control: N2_BASELINE = the original e369c5e2 script)."""
import datetime, hashlib, json, os, pathlib, shutil, stat, subprocess, tempfile, unittest
T = pathlib.Path(__file__).resolve().parent; H = T.parent / "helper"; PWSH = os.environ.get("PWSH", str(T / "pwsh/pwsh"))
SCRIPT = pathlib.Path(os.environ.get("CUTOVER_SCRIPT", H / "node-hold-cutover.ps1"))
RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"
IDS = ["0x" + c * 64 for c in "abc"]
sha = lambda b: hashlib.sha256(b).hexdigest()
CFG = {"version": 2, "directory": "x", "apps": [], "enclaveNetwork": {k: k for k in ["relay", "checkers", "apps", "control", "wgBinary", "nodeBinary", "workerModule", "firewallBinary", "directories", "paid", "hostEgress", "paceMbps"]}}
LOCAL = b"@echo off\r\nrem caf\xc3\xa9 operator settings\r\nset SOMETHING=1"          # no final CRLF, one non-ASCII byte
START = "2026-10-21T15:01:03.6706520Z"
# LEASE DEADLINE proposal: the mock clock starts at 22:00:00Z; leases.json holds each expected id's leaseUntil (epoch s)
CLOCK0 = int(datetime.datetime(2026, 10, 21, 22, 0, 0, tzinfo=datetime.timezone.utc).timestamp())
LEASE = {"marginSec": 180, "revertSec": 300, "forwardMinSec": 180, "startNodeSec": 150}
def leases(r, offset, ids=None, status="running"):
    (r / "leases.json").write_text(json.dumps([{"id": i, "status": status, "leaseUntil": CLOCK0 + offset} for i in (IDS if ids is None else ids)]))
HYPERV = [{"Id": f"0000000{i}-1111-2222-3333-444444444444", "Name": f"vm-{i}", "State": "Running"} for i in range(4)]

def world():
    r = pathlib.Path(tempfile.mkdtemp(prefix="cutover-mock-"))
    for d in ("network/state", "logs", "stage"): (r / d).mkdir(parents=True)
    (r / "network/privacy-config.json").write_text(json.dumps(CFG, indent=2) + "\n"); (r / "node-config.local.cmd").write_bytes(LOCAL)
    (r / "run-node.cmd").write_bytes(b"@echo off\r\n:loop\r\n"); (r / "logs/node.log").write_text("22:00:00 boot\n")
    (r / "expected-ids.txt").write_text("\n".join(IDS) + "\n")
    (r / "vms.json").write_text(json.dumps([{"id": "hv" + i[2:10], "name": i, "status": "running"} for i in IDS] + [{"id": "hvzz", "name": "shield-readiness-v1", "status": "running"}]))
    (r / "hyperv.json").write_text(json.dumps(HYPERV))
    procs = [{"pid": 23976, "ppid": 1, "name": "cmd.exe", "cmd": 'cmd.exe /c "C:\\ProgramData\\Enclave\\run-node.cmd"', "start": START},
             {"pid": 8644, "ppid": 23976, "name": "node.exe", "cmd": '"node.exe" "C:\\Program Files\\Enclave\\control\\windows\\node\\agent.mjs"', "start": START},
             {"pid": 38416, "ppid": 3001, "name": "node.exe", "cmd": '"node.exe" "C:\\Program Files\\Enclave\\network\\privacy-agent.mjs" --config x', "start": "2026-10-21T00:05:03.7361540Z"},
             {"pid": 4001, "ppid": 1, "name": "node.exe", "cmd": "manager main.mjs", "start": "2026-10-21T12:13:07.5552110Z"}]
    (r / "procs.json").write_text(json.dumps(procs)); leases(r, 1700)
    return r

def vms_string(r): return ",".join(sorted(f"{v['id']}|{v['name']}|{v['status']}" for v in json.loads((r / "vms.json").read_text())))
def hv_string(r): return ",".join(sorted(f"{v['Id']}|{v['Name']}|{v['State']}" for v in json.loads((r / "hyperv.json").read_text())))

def params(r, run, **over):
    p = {"stage": str(r / "stage"), "runId": run, "boundSec": 900, "runner": RUNNER, "runNodeSha": sha((r / "run-node.cmd").read_bytes()),
         "localSha": sha(LOCAL), "cfgSha": sha((r / "network/privacy-config.json").read_bytes()), "files": [],
         "node": {"cmdPid": 23976, "cmdStart": START, "agentPid": 8644, "agentStart": START}, "manager": "4001@2026-10-21T12:13:07.5552110Z",
         "privacy": {"pid": 38416, "start": "2026-10-21T00:05:03.7361540Z"}, "vms": vms_string(r), "hyperv": hv_string(r), "expectedIds": IDS,
         "testRoot": str(r), "testNode": shutil.which("node"), "lease": LEASE}
    p.update(over); return p

def run(r, p, mode="cutover", scenario="ok"):
    pf = r / "stage" / f"params-{p['runId']}-{mode}.json"; pf.write_text(json.dumps(p)); ps = sha(pf.read_bytes())
    c = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(T / "cutover-mock.ps1"), "-Script", str(SCRIPT), "-Root", str(r), "-ParamsFile", str(pf),
                        "-ParamsSha", ps, "-Mode", mode, "-Scenario", scenario], capture_output=True, text=True, timeout=240)
    j = r / "stage" / f"cutover-{p['runId']}.jsonl"
    lines = [json.loads(l) for l in j.read_text().splitlines()] if j.exists() else []
    return lines, c

def final(lines): return next((l["final"] for l in reversed(lines) if "final" in l), "") or ""
def starts(r): return (r / "node-starts.txt").read_text().count("start") if (r / "node-starts.txt").exists() else 0
def flag(r): return b"ENCLAVE_NETWORK_WALLET_HOLD=1" in (r / "node-config.local.cmd").read_bytes()
def block(r): return "walletAdmission" in json.loads((r / "network/privacy-config.json").read_text())["enclaveNetwork"]
def temps(r): return [p.name for p in (r / "network").iterdir() if ".nh-" in p.name] + [p.name for p in r.iterdir() if ".nh-" in p.name]
def node_running(r): return any("node\\agent.mjs" in x["cmd"] for x in json.loads((r / ("procs-state.json" if (r / "procs-state.json").exists() else "procs.json")).read_text()))
def pins(lines): return next((l for l in lines if "updateTask" in l), {})

class Cutover(unittest.TestCase):
    def setUp(self): self.r = world()
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def ok(self, lines, c, prefix): self.assertTrue(final(lines).startswith(prefix), (final(lines), [l.get("recovery") for l in lines if l.get("recovery")], c.stderr[-900:]))

    # ---------------------------------------------------------------- the success path and the explicit rollback
    def test_ok_then_explicit_rollback(self):
        r = self.r; lines, c = run(r, params(r, "ok1")); self.ok(lines, c, "DONE:")
        self.assertEqual([l.get("step") for l in lines if l.get("step")], ["pins", "stop-node", "backups", "config", "flag", "privacy-restart", "start-node", "post"])
        pr = next(l for l in lines if l.get("step") == "privacy-restart"); self.assertTrue(pr["enforcing"]); self.assertEqual(pr["egressApps"], 0); self.assertTrue(pr["configsAsWritten"])
        cfg = json.loads((r / "network/privacy-config.json").read_text()); self.assertEqual(list(cfg["enclaveNetwork"])[-1], "walletAdmission")
        self.assertEqual((r / "node-config.local.cmd").read_bytes(), LOCAL + b"\r\nset ENCLAVE_NETWORK_WALLET_HOLD=1\r\n")
        post = lines[-1]; self.assertTrue(post["identityUnchanged"]); self.assertTrue(post["walletAclOk"]); self.assertTrue(post["hypervUnchanged"])
        self.assertEqual(temps(r), [], "no temp survives")
        st = json.loads((r / "procs-state.json").read_text()); node = [x for x in st if "node\\agent.mjs" in x["cmd"]][0]; cmd = [x for x in st if x["pid"] == node["ppid"]][0]
        pa = [x for x in st if "privacy-agent" in x["cmd"]][0]; (r / "procs.json").write_text(json.dumps(st))
        bk = next(l for l in lines if l.get("step") == "backups"); fl = next(l for l in lines if l.get("step") == "flag"); cf = next(l for l in lines if l.get("step") == "config")
        rb = params(r, "ok1-rb", node={"cmdPid": cmd["pid"], "cmdStart": cmd["start"], "agentPid": node["pid"], "agentStart": node["start"]}, privacy={"pid": pa["pid"], "start": pa["start"]},
                    before={"local": {"before": sha(LOCAL), "after": fl["after"], "backup": bk["localBackup"]}, "cfg": {"before": bk["cfg"], "after": cf["after"], "backup": bk["cfgBackup"]}})
        lines2, c2 = run(r, rb, mode="rollback"); self.ok(lines2, c2, "ROLLED_BACK:")
        self.assertEqual((r / "node-config.local.cmd").read_bytes(), LOCAL); self.assertEqual(sha((r / "network/privacy-config.json").read_bytes()), bk["cfg"])
        rv = next(l for l in lines2 if l.get("step") == "revert"); self.assertEqual((rv["local"], rv["cfg"]), ("restored", "restored")); self.assertTrue(rv["plain"])

    # ---------------------------------------------------------------- R1 / R2 complete reverts
    def test_r1_complete_revert(self):
        r = self.r; lines, c = run(r, params(r, "r1"), scenario="net-ignores-wallet"); self.ok(lines, c, "ROLLED_BACK_R1")
        self.assertFalse(flag(r)); self.assertFalse(block(r)); self.assertEqual(json.loads((r / "network/privacy-config.json").read_text()), CFG)
        self.assertEqual(starts(r), 1, "started once, after the verified revert"); self.assertTrue(lines[-1]["plain"])
    def test_r2_complete_revert(self):
        r = self.r; lines, c = run(r, params(r, "r2"), scenario="node-no-channel"); self.ok(lines, c, "ROLLED_BACK_R2")
        self.assertFalse(flag(r)); self.assertFalse(block(r)); self.assertEqual(starts(r), 2)

    # ---------------------------------------------------------------- R1 (root): every restore conflict / partial stop / stale status
    def test_root_reproduction_concurrent_local_edit_now_refuses(self):
        r = self.r; lines, c = run(r, params(r, "root"), scenario="root-concurrent-local-edit"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertTrue(flag(r), "the flag stays (it was changed by someone else: never overwritten)")
        self.assertTrue(block(r), "network enforcement is KEPT while the flag remains")
        self.assertEqual(starts(r), 0, "the node is NOT started"); self.assertFalse(node_running(r))
        self.assertIn("node flag was not restored", lines[-1]["recovery"])
    def test_concurrent_cfg_edit_restores_flag_then_stops(self):
        r = self.r; lines, c = run(r, params(r, "cfgedit"), scenario="concurrent-cfg-edit"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertFalse(flag(r), "the flag was restored first"); self.assertEqual((r / "node-config.local.cmd").read_bytes(), LOCAL)
        self.assertTrue(json.loads((r / "network/privacy-config.json").read_text()).get("operatorEdit"), "the operator's config is never overwritten")
        self.assertEqual(starts(r), 0); self.assertIn("network block was not restored", lines[-1]["recovery"])
    def test_r2_partial_stop_touches_nothing(self):
        r = self.r; lines, c = run(r, params(r, "r2stop"), scenario="node-no-channel-unkillable"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertTrue(flag(r)); self.assertTrue(block(r), "nothing restored while the node cannot be proven stopped")
        self.assertEqual(starts(r), 1, "no second start"); self.assertIn("could not be proven stopped", lines[-1]["recovery"])
    def test_stale_status_after_revert_keeps_node_stopped(self):
        r = self.r; lines, c = run(r, params(r, "stale"), scenario="revert-status-stale"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertFalse(flag(r)); self.assertFalse(block(r)); self.assertEqual(starts(r), 0, "never started without a fresh plain status from the NEW agent")
        self.assertIn("no fresh status WITHOUT walletAdmission", lines[-1]["recovery"])
    def test_missing_privacy_agent_after_revert_keeps_node_stopped(self):
        r = self.r; lines, c = run(r, params(r, "nopriv"), scenario="revert-no-privacy"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertFalse(flag(r)); self.assertFalse(block(r)); self.assertEqual(starts(r), 0)
    def test_initial_stop_failure_changes_nothing(self):
        r = self.r; lines, c = run(r, params(r, "stop"), scenario="agent-unkillable"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertIn("before any change", final(lines)); self.assertEqual((r / "node-config.local.cmd").read_bytes(), LOCAL); self.assertFalse(block(r)); self.assertEqual(starts(r), 0)

    # ---------------------------------------------------------------- R0 + R2 (tempfile safety)
    def test_flag_write_failure_reverts_block(self):
        r = self.r; lines, c = run(r, params(r, "r0"), scenario="flag-write-fails"); self.ok(lines, c, "ROLLED_BACK_R0")
        self.assertFalse(block(r)); self.assertFalse(flag(r)); self.assertEqual(starts(r), 1); self.assertEqual(temps(r), [])
    def test_temp_acl_before_bytes_and_cleanup_on_success(self):
        r = self.r; lines, c = run(r, params(r, "acl")); self.ok(lines, c, "DONE:")
        log = [l.rsplit("|", 1) for l in (r / "acl-log.txt").read_text().splitlines()]
        edits = [(p, int(n)) for p, n in log if ".nh-edit-" in p]; casw = [(p, int(n)) for p, n in log if ".nh-" in p and ".nh-edit-" not in p]
        self.assertEqual(len(edits), 1); self.assertEqual(edits[0][1], 0, "the edit temp got the config ACL while EMPTY")
        self.assertTrue(casw and all(n == 0 for _, n in casw), "every CAS temp got its ACL while EMPTY")
        self.assertEqual(temps(r), [])
    def test_failed_config_edit_leaves_no_temp(self):
        r = self.r; fake = r / "fake-node.sh"
        fake.write_text('#!/bin/sh\nprintf "PRIVATE-CONFIG-BYTES" > "$4"\nexit 1\n'); fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        lines, c = run(r, params(r, "editfail", testNode=str(fake))); self.ok(lines, c, "ROLLED_BACK_R0")
        self.assertEqual(temps(r), [], "the temp holding config bytes is removed in finally"); self.assertFalse(block(r)); self.assertFalse(flag(r))
        log = [l.rsplit("|", 1) for l in (r / "acl-log.txt").read_text().splitlines()]
        self.assertTrue(any(".nh-edit-" in p and int(n) == 0 for p, n in log), "its ACL was set before node wrote")

    # ---------------------------------------------------------------- R3 identities
    def test_hyperv_unavailable_refuses(self):
        r = self.r; lines, c = run(r, params(r, "hv", hyperv="unavailable"), scenario="hyperv-unavailable"); self.ok(lines, c, "REFUSED")
        self.assertIn("Hyper-V", final(lines)); self.assertEqual(starts(r), 0); self.assertFalse(block(r))
    def test_manager_unavailable_pin_refuses(self):
        r = self.r; lines, c = run(r, params(r, "mgr", vms="unavailable")); self.ok(lines, c, "REFUSED")
    def test_vm_replaced_is_done_check(self):
        r = self.r; lines, c = run(r, params(r, "vmrep"), scenario="vm-replaced"); self.ok(lines, c, "DONE_CHECK")
        self.assertFalse(lines[-1]["hypervUnchanged"])
    def test_other_task_change_is_done_check(self):
        r = self.r; lines, c = run(r, params(r, "other"), scenario="other-task-changed"); self.ok(lines, c, "DONE_CHECK")
        self.assertFalse(lines[-1]["othersUnchanged"])
    def test_channel_file_extra_writer_is_done_check(self):
        r = self.r; lines, c = run(r, params(r, "wacl"), scenario="wallet-acl-bad"); self.ok(lines, c, "DONE_CHECK")
        self.assertFalse(lines[-1]["walletAclOk"])
    def test_network_dir_extra_writer_refuses(self):
        r = self.r; lines, c = run(r, params(r, "nacl"), scenario="netdir-acl-bad"); self.ok(lines, c, "REFUSED")
        self.assertIn("network directory", final(lines))

    # ---------------------------------------------------------------- G4 final: G-UPD, N3, N2
    def test_update_task_running_or_due_refuses_and_changes_nothing(self):
        for sc in ("update-running", "update-due"):
            r = world(); before = (r / "network/privacy-config.json").read_bytes()
            try:
                lines, c = run(r, params(r, "u-" + sc), scenario=sc); self.ok(lines, c, "REFUSED")
                self.assertIn("Update task runs or is due", final(lines))
                self.assertEqual((starts(r), flag(r), (r / "network/privacy-config.json").read_bytes()), (0, False, before)); self.assertTrue(node_running(r), "the node was never stopped")
            finally: shutil.rmtree(r, ignore_errors=True)
    def test_update_task_ready_and_not_due_is_recorded_and_passes(self):
        r = self.r; lines, c = run(r, params(r, "u-ok")); self.ok(lines, c, "DONE:")
        p = pins(lines); self.assertEqual(p["updateTask"]["state"], "Ready"); self.assertTrue(p["updateTask"]["next"].startswith("2026-10-21T22:50"))
        self.assertEqual(sorted(p["networkDirReaders"]), ["S-1-5-18", "S-1-5-32-544"])
        self.assertEqual(sorted(p["programDataFileInheritReaders"]), ["S-1-5-18", "S-1-5-32-544"], "the live NON-inheritable BU read on the data dir passes")
    def test_n3_read_principals_refuse(self):
        for sc, why in (("netdir-read-bad", "network directory is readable"), ("pd-inherit-read-bad", "inherit READ")):
            r = world()
            try:
                lines, c = run(r, params(r, "n3-" + sc), scenario=sc); self.ok(lines, c, "REFUSED"); self.assertIn(why, final(lines))
                self.assertEqual((starts(r), flag(r), block(r), temps(r)), (0, False, False, [])); self.assertTrue(node_running(r))
            finally: shutil.rmtree(r, ignore_errors=True)
    def test_n2_a_throw_before_the_pins_never_stops_the_node(self):
        r = self.r; lines, c = run(r, params(r, "n2", stage=""))            # the only throwing statement root found (Join-Path $Stage)
        self.assertEqual((starts(r), flag(r), block(r)), (0, False, False)); self.assertTrue(node_running(r), ("node stopped", c.stderr[-600:]))
        # every function defined, the original's '$phase = pins' line not yet reached: a throw injected before the comment that
        # precedes it in BOTH scripts (a COPY in the scratch root; the package bytes are untouched)
        def injected(src, r):
            t = pathlib.Path(src).read_text(); k = t.index("\n# a terminating error still goes through the SAME coordinator"); dst = r / "injected.ps1"
            dst.write_text(t[:k] + "\nthrow 'N2-injected'" + t[k:]); return str(dst)
        def go(src, r, run_id):
            p = params(r, run_id); pf = r / "stage" / f"params-{run_id}-cutover.json"; pf.write_text(json.dumps(p))
            c = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(T / "cutover-mock.ps1"), "-Script", injected(src, r), "-Root", str(r), "-ParamsFile", str(pf),
                                "-ParamsSha", sha(pf.read_bytes()), "-Mode", "cutover", "-Scenario", "ok"], capture_output=True, text=True, timeout=240)
            j = r / "stage" / f"cutover-{run_id}.jsonl"
            return [json.loads(l) for l in j.read_text().splitlines()] if j.exists() else [], c
        r1 = world()
        try:
            lines, c = go(SCRIPT, r1, "n2i"); self.ok(lines, c, "CRASHED in phase pins")
            self.assertEqual((starts(r1), flag(r1), block(r1)), (0, False, False)); self.assertTrue(node_running(r1), "the node was never stopped")
            self.assertFalse(any(l.get("step") == "stop-node" for l in lines))
        finally: shutil.rmtree(r1, ignore_errors=True)
        base = pathlib.Path(os.environ.get("N2_BASELINE", T.parent.parent / "node-hold-package-20261021/helper/node-hold-cutover.ps1"))
        if base.exists():                                   # negative control: the ORIGINAL e369c5e2 under the same injection
            r2 = world()
            try:
                lines2, c2 = go(base, r2, "n2b")
                print("\nN2 baseline (original):", sha(base.read_bytes())[:8], "rc", c2.returncode, "final", final(lines2)[:160], "| node running", node_running(r2), "| starts", starts(r2))
                self.assertFalse(final(lines2).startswith("CRASHED in phase pins"), "the original does NOT see phase pins")
                self.assertFalse(node_running(r2), "root's N2 hazard reproduced on the original: its fallback stopped the live node")
            finally: shutil.rmtree(r2, ignore_errors=True)

    # ---------------------------------------------------------------- crash trap, refusals, lock, rollback refusal
    def test_crash_with_working_fallback_is_a_verified_revert(self):
        r = self.r; lines, c = run(r, params(r, "crash1"), scenario="crash-once"); self.ok(lines, c, "ROLLED_BACK_AFTER_CRASH")
        self.assertFalse(flag(r)); self.assertFalse(block(r)); self.assertEqual(starts(r), 1)
    def test_crash_whose_fallback_fails_is_recovery_required(self):
        r = self.r; lines, c = run(r, params(r, "crash"), scenario="crash-enforcing"); self.ok(lines, c, "RECOVERY_REQUIRED")
        self.assertEqual(starts(r), 0, "never started after a failed fallback"); self.assertFalse(flag(r), "the flag was restored first")
    def test_refusals_change_nothing_and_a_run_id_never_runs_twice(self):
        r = self.r; before = (r / "network/privacy-config.json").read_bytes()
        for over in ({"cfgSha": "0" * 64}, {"vms": "x|y|z"}, {"hyperv": "x|y|z"}, {"privacy": {"pid": 1, "start": "x"}}, {"manager": "1@x"}, {"localSha": "0" * 64}):
            rid = "ref-" + list(over)[0]; lines, c = run(r, params(r, rid, **over)); self.ok(lines, c, "REFUSED")
            self.assertEqual((r / "network/privacy-config.json").read_bytes(), before); self.assertEqual(starts(r), 0)
        lines, c = run(r, params(r, "ref-cfgSha", cfgSha="0" * 64)); self.assertIn("lock exists", lines[-1].get("decision", ""))
        pf = r / "stage/params-bad.json"; pf.write_text("{}")
        c = subprocess.run([PWSH, "-NoProfile", "-File", str(T / "cutover-mock.ps1"), "-Script", str(SCRIPT), "-Root", str(r), "-ParamsFile", str(pf), "-ParamsSha", "0" * 64], capture_output=True, text=True, timeout=60)
        self.assertEqual(c.returncode, 4, "a params file that is not the pinned sha never runs")
    def test_explicit_rollback_refuses_a_config_changed_since(self):
        r = self.r; lines, c = run(r, params(r, "rbx")); self.ok(lines, c, "DONE:")
        st = json.loads((r / "procs-state.json").read_text()); node = [x for x in st if "node\\agent.mjs" in x["cmd"]][0]; cmd = [x for x in st if x["pid"] == node["ppid"]][0]
        pa = [x for x in st if "privacy-agent" in x["cmd"]][0]; (r / "procs.json").write_text(json.dumps(st))
        bk = next(l for l in lines if l.get("step") == "backups"); fl = next(l for l in lines if l.get("step") == "flag"); cf = next(l for l in lines if l.get("step") == "config")
        with open(r / "network/privacy-config.json", "a") as fh: fh.write(" ")          # an operator touched it since
        rb = params(r, "rbx-rb", node={"cmdPid": cmd["pid"], "cmdStart": cmd["start"], "agentPid": node["pid"], "agentStart": node["start"]}, privacy={"pid": pa["pid"], "start": pa["start"]},
                    before={"local": {"before": sha(LOCAL), "after": fl["after"], "backup": bk["localBackup"]}, "cfg": {"before": bk["cfg"], "after": cf["after"], "backup": bk["cfgBackup"]}})
        lines2, c2 = run(r, rb, mode="rollback"); self.ok(lines2, c2, "REFUSED")
        self.assertTrue(flag(r)); self.assertTrue(block(r)); self.assertEqual(starts(r), 1, "the running node was not touched")

class AclPrecondition(unittest.TestCase):
    """AI precondition (node-hold-acl-normalization apply-ai-precondition.py): a config DACL without AI refuses at the pins"""
    def test_config_without_auto_inherited_dacl_refuses_before_anything(self):
        for scen, leaf in (("cfg-acl-no-ai", "privacy-config.json"), ("local-acl-no-ai", "node-config.local.cmd")):
            r = world(); before = (r / "network/privacy-config.json").read_bytes(); lines, c = run(r, params(r, scen), scenario=scen)
            try:
                self.assertTrue(final(lines).startswith("REFUSED"), (final(lines), c.stderr[-500:])); self.assertIn(leaf + " has a DACL that is not auto-inherited", final(lines))
                self.assertEqual((starts(r), flag(r), block(r), temps(r), (r / "network/privacy-config.json").read_bytes()), (0, False, False, [], before)); self.assertTrue(node_running(r))
                self.assertEqual([l.get("step") for l in lines if l.get("step")], ["pins"], "refused at the pins: the node was never stopped")
            finally: shutil.rmtree(r, ignore_errors=True)

def start_times(r): return [l.split(" ", 1)[1] for l in (r / "node-starts.txt").read_text().splitlines()] if (r / "node-starts.txt").exists() else []
def epoch(iso): return datetime.datetime.fromisoformat(iso[:26].rstrip("Z") + "+00:00").timestamp()
def step(lines, name): return next(l for l in lines if l.get("step") == name)

class LeaseDeadline(unittest.TestCase):
    """LEASE DEADLINE proposal (node-lease-window-review-20261021): the pins read the node's leaseUntil of every expected id;
    refused unless forward + revert + margin fit; the forward waits yield so the revert's node start precedes the first lease
    end by lease.marginSec. Negative control: UNPATCHED=<original script> runs the timing case against the original."""
    def setUp(self): self.r = world()
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def unchanged(self, r, lines):
        self.assertEqual([l.get("step") for l in lines if l.get("step")], ["pins"], "refused at the pins: the node was never stopped")
        self.assertEqual((starts(r), flag(r), block(r), temps(r)), (0, False, False, [])); self.assertTrue(node_running(r))
    def test_short_lease_refuses_at_the_pins(self):
        r = self.r; leases(r, 659); lines, c = run(r, params(r, "short"))
        self.assertTrue(final(lines).startswith("REFUSED"), (final(lines), c.stderr[-600:])); self.assertIn("lease deadline: the first lease", final(lines))
        self.assertIn(">= 660 s", final(lines)); self.unchanged(r, lines)
        self.assertEqual((lines[-1]["lease"]["secLeft"], lines[-1]["lease"]["forwardSec"]), (659, 179))
    def test_exact_need_passes_and_is_journaled(self):
        r = self.r; leases(r, 660); lines, c = run(r, params(r, "need")); self.assertTrue(final(lines).startswith("DONE:"), (final(lines), c.stderr[-600:]))
        lz = step(lines, "pins")["lease"]; self.assertEqual((lz["secLeft"], lz["forwardSec"], lz["firstId"]), (660, 180, IDS[0]))
    def test_unreadable_missing_or_not_running_refuses(self):
        for name, prep, scen, why in (("unread", lambda r: None, "lease-unreadable", "lease state (127.0.0.1:9600/v1/host/state) is unreadable"),
                                      ("missing", lambda r: leases(r, 1700, ids=IDS[:2]), "ok", "without a running record and a numeric leaseUntil: " + IDS[2]),
                                      ("held", lambda r: leases(r, 1700, status="held"), "ok", "without a running record")):
            r = world()
            try:
                prep(r); lines, c = run(r, params(r, name), scenario=scen)
                self.assertTrue(final(lines).startswith("REFUSED"), (name, final(lines))); self.assertIn(why, final(lines)); self.unchanged(r, lines)
            finally: shutil.rmtree(r, ignore_errors=True)
    def test_params_without_the_lease_budget_refuse(self):
        r = self.r; lines, c = run(r, params(r, "nobudget", lease=None)); self.assertIn("lease budget", final(lines)); self.unchanged(r, lines)
    def test_slow_privacy_tight_lease_starts_the_old_node_not_the_new(self):
        r = self.r; leases(r, 700); lines, c = run(r, params(r, "slowpriv"), scenario="privacy-slow")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_LEASE"), (final(lines), c.stderr[-600:]))
        self.assertEqual(starts(r), 1, "only the revert started a node (the old behaviour)"); self.assertFalse(flag(r)); self.assertFalse(block(r))
        self.assertLessEqual(epoch(start_times(r)[-1]), CLOCK0 + 700 - LEASE["marginSec"], "the old node started >= marginSec before the first lease end")
        self.assertGreaterEqual(lines[-1]["leaseLeft"], 0, "the revert began before its own deadline")
    def test_r2_channel_wait_yields_at_the_deadline(self):
        r = self.r; leases(r, 720); lines, c = run(r, params(r, "slowr2"), scenario="slow-no-channel")
        self.assertTrue(final(lines).startswith("ROLLED_BACK_R2"), (final(lines), c.stderr[-600:]))
        sn = step(lines, "start-node"); self.assertTrue(sn["nodeUp"]); self.assertLessEqual(abs(sn["leaseLeft"]), 2, "the channel wait was cut at the deadline (not its 120-s cap)")
        self.assertLessEqual(CLOCK0 + sn["sec"], CLOCK0 + 720 - LEASE["marginSec"] - LEASE["revertSec"] + 2)
        self.assertEqual(starts(r), 2); self.assertLessEqual(epoch(start_times(r)[-1]), CLOCK0 + 720 - LEASE["marginSec"])
        self.assertFalse(flag(r)); self.assertFalse(block(r))
        orig = os.environ.get("UNPATCHED")
        if orig:                                        # negative control: the original waits its full 120 s past the deadline
            r2 = world(); leases(r2, 720)
            try:
                p = params(r2, "slowr2-orig"); pf = r2 / "stage" / "params-orig.json"; pf.write_text(json.dumps(p))
                c2 = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(T / "cutover-mock.ps1"), "-Script", orig, "-Root", str(r2), "-ParamsFile", str(pf),
                                     "-ParamsSha", sha(pf.read_bytes()), "-Mode", "cutover", "-Scenario", "slow-no-channel"], capture_output=True, text=True, timeout=240)
                l2 = [json.loads(l) for l in (r2 / "stage" / "cutover-slowr2-orig.jsonl").read_text().splitlines()]
                sn2 = step(l2, "start-node"); print("\nUNPATCHED", sha(pathlib.Path(orig).read_bytes())[:8], "start-node sec", sn2["sec"], "deadline sec", 720 - 480, "final", final(l2)[:40])
                self.assertGreater(sn2["sec"], 720 - LEASE["marginSec"] - LEASE["revertSec"] + 2, "the original's revert begins AFTER the deadline")
            finally: shutil.rmtree(r2, ignore_errors=True)

if __name__ == "__main__": unittest.main()
