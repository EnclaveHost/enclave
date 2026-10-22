#!/usr/bin/env python3
"""Offline tests of root-node-pair.py with a STUB transport and a STUB scp (no ssh, no network, no Windows). Run:
   python3 -m unittest -v test_root_node_pair.py"""
import ast, base64, copy, hashlib, importlib.util, io, json, os, pathlib, re, subprocess, sys, tempfile, unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
REAL_RUN = subprocess.run
CALLS = []                                   # every subprocess.run the runner makes (scp); ssh never happens (ps is stubbed)

def fake_run(argv, **kw):
    CALLS.append(list(argv))
    return FAKE_SCP(argv)
FAKE_SCP = lambda argv: subprocess.CompletedProcess(argv, 0, "", "")
subprocess.run = fake_run                    # BEFORE the import: an import that ran anything remote would be recorded

spec = importlib.util.spec_from_file_location("rnp", HERE / "root-node-pair.py"); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
IMPORT_CALLS = list(CALLS)
W = R.W
HOLD = W / "root-control-rpc-final-20261022/control-package/helper/root-node-hold.py"
sha = lambda b: hashlib.sha256(b).hexdigest()

class Remote:
    """the minipc side, scripted: files written by the stub scp; answers by remote text"""
    def __init__(self):
        self.files, self.texts, self.launch, self.journal, self.mk, self.corrupt = {}, [], {"decision": "started", "state": "Running"}, None, None, set()
    def ps(self, text, secs=150):
        self.texts.append(text)
        if "CreateDirectory" in text and text == R.MKSTAGE.replace("DX", re.search(r"\$d=('[^']*')", text).group(1)):
            d = re.search(r"\$d='([^']*)'", text).group(1)
            return self.mk if self.mk is not None else {"decision": "created", "created": d, "protected": True, "owner": "S-1-5-32-544", "sids": ["S-1-5-18", "S-1-5-32-544"]}
        if "foreach($x in @(" in text:
            paths = re.findall(r"'([^']*)'", text[text.index("@(") + 2:text.index("))") + 1])
            return {**{p: self.files.get(p, "absent") for p in paths}, "@protected": True, "@sids": ["S-1-5-18", "S-1-5-32-544"]}
        if "Register-ScheduledTask" in text: return self.launch
        if "Get-ScheduledTaskInfo" in text: return {"lastTaskResult": 0, "lastRunTime": None}
        if "ReadAllLines" in text: return self.journal or {"lines": [], "task": "Running"}
        raise AssertionError("unexpected remote text: " + text[:120])

def scp_into(remote):
    def f(argv):
        if argv[:3] != ["timeout", argv[1], "scp"]: raise AssertionError(argv)
        src, dst = argv[-2], argv[-1]
        assert dst.startswith("minipc:/C:/ProgramData/Enclave/staging/nodepair-"), dst
        b = pathlib.Path(src).read_bytes()
        win = dst[len("minipc:/"):].replace("/", "\\")
        remote.files[win] = sha(b) if win not in remote.corrupt else "0" * 64
        remote.uploads.append((src, win, (R.OUT / f"attempt-{remote.mode}-{remote.run}.json").exists() if getattr(remote, "run", None) else None))
        return subprocess.CompletedProcess(argv, 0, "", "")
    remote.uploads = []
    return f

class Base(unittest.TestCase):
    def setUp(self):
        global FAKE_SCP
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="rnp-test-")); R.OUT = self.t / "runs"; R.SLEEP = 0.01; R.POLL_SEC = 1
        self.helper = self.t / "node-pair-restart.ps1"; self.helper.write_bytes(b"# HELPER-CONTENT-MARKER\nparam($Mode)\n")
        self.chain = self.t / "chain.mjs"; self.chain.write_bytes(b"export const chain = 'NEW-CHAIN';\n")
        self.host = self.t / "host.mjs"; self.host.write_bytes(b"export const host = 'NEW-HOST';\n")
        self.H, self.C, self.S = (sha(p.read_bytes()) for p in (self.helper, self.chain, self.host))
        self.remote = Remote(); R.m = self.remote; FAKE_SCP = scp_into(self.remote); CALLS.clear()
    def main(self, argv):
        out = io.StringIO()
        with redirect_stdout(out): rc = R.main(argv)
        self.out = out.getvalue(); return rc
    def stage_args(self, **kw):
        a = {"helper": self.helper, "helper-sha": self.H, "chain": self.chain, "chain-sha": self.C, "host": self.host, "host-sha": self.S} | kw
        return ["--stage"] + sum([["--" + k, str(v)] for k, v in a.items()], [])
    def staged(self):
        self.assertEqual(self.main(self.stage_args()), 0, self.out)
        self.rec = next(R.OUT.glob("stage-*.json")); self.st = json.loads(self.rec.read_text()); return self.st
    def params(self, mode="apply", **over):
        s = self.st["stage"]
        p = {"stage": s, "runId": f"{mode}-run-0001", "boundSec": 1140, "nodeExe": R.NODE_EXE, "nodeSha": "a" * 64, "runner": "0x" + "b" * 64,
             "bundleSwap": {"path": s + "\\bundle-swap.ps1", "sha": R.BUNDLE_SWAP[1]},
             "files": [{"name": n, "target": R.NODEDIR + "\\" + n, "oldSha": o, "newSha": h, "newFile": s + "\\files\\" + n, "workDir": s + "\\swap-" + n}
                       for n, o, h in (("chain.mjs", "1" * 64, self.C), ("host.mjs", "2" * 64, self.S))],
             "unchangedFiles": [{"path": r"C:\ProgramData\Enclave\run-node.cmd", "sha": "3" * 64}],
             "task": {"execute": r"C:\Windows\System32\cmd.exe", "arguments": r'/c "C:\ProgramData\Enclave\run-node.cmd"'},
             "node": {"cmdPid": 100, "cmdStart": "2026-10-22T20:00:00.0000000Z", "agentPid": 101, "agentStart": "2026-10-22T20:00:01.0000000Z"},
             "scheduler": {"pid": 9, "start": "2026-10-20T00:00:00.0000000Z", "name": "svchost.exe", "commandLike": "*Schedule*"},
             "manager": "200@2026-10-21T00:00:00.0000000Z", "privacy": {"pid": 300, "start": "2026-10-22T02:22:18.0000000Z"},
             "vms": "vm|0x" + "c" * 64 + "|running", "hyperv": "g|0x" + "c" * 64 + "|Running", "expectedIds": ["0x" + "c" * 64],
             "lease": {"reserve": "full-return", "marginSec": 120, "revertSec": 600, "forwardMinSec": 540, "startNodeSec": 480, "returnPinsSec": 60}}
        for k, v in over.items():
            if v is DEL: p.pop(k, None)
            else: p[k] = v
        f = self.t / f"params-{len(list(self.t.glob('params-*')))}.json"; f.write_text(json.dumps(p)); return f, sha(f.read_bytes()), p
    def run_args(self, mode, f, h): return ["--run", mode, "--stage-receipt", str(self.rec), "--params", str(f), "--params-sha", h]
DEL = object()

class ImportAndHelp(Base):
    def test_import_is_inert(self):
        self.assertEqual(IMPORT_CALLS, [], "the import ran a subprocess")
        self.assertTrue(R.m is None or isinstance(R.m, Remote))   # the transport is loaded only by a command
    def test_usage_and_help_make_no_remote_call(self):
        R.m = None
        self.assertEqual(self.main([]), 0); self.assertIn("ROOT-ONLY", self.out)
        with self.assertRaises(SystemExit) as e, redirect_stdout(io.StringIO()): R.main(["--help"])
        self.assertEqual(e.exception.code, 0); self.assertEqual(CALLS, []); self.assertIsNone(R.m, "help loaded the transport")

class LocalPinsFirst(Base):
    def test_mismatched_helper_sha_before_any_remote(self):
        with self.assertRaises(SystemExit) as e: self.main(self.stage_args(**{"helper-sha": "f" * 64}))
        self.assertIn("is not", str(e.exception)); self.assertEqual((CALLS, self.remote.texts), ([], []))
    def test_missing_module_and_missing_sha_before_any_remote(self):
        for kw in ({"chain": self.t / "absent.mjs"}, {"host-sha": ""}, {"chain-sha": "ABC"}):
            with self.assertRaises(SystemExit): self.main(self.stage_args(**kw))
        self.assertEqual((CALLS, self.remote.texts), ([], []))
    def test_same_bytes_for_both_modules_refused(self):
        with self.assertRaises(SystemExit): self.main(self.stage_args(host=self.chain, **{"host-sha": self.C}))
        self.assertEqual(self.remote.texts, [])
    def test_transport_pin(self):
        self.assertEqual(sha(R.T[0].read_bytes()), "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
        bad = self.t / "transport.py"; bad.write_text("def ps(t, s=0): raise SystemExit('ran')\n")
        old, R.T, R.m = R.T, (bad, R.T[1]), None
        try:
            with self.assertRaises(SystemExit) as e: R.transport()
            self.assertIn("not the reviewed", str(e.exception))
        finally: R.T = old
    def test_params_sha_mismatch_before_any_remote(self):
        self.staged(); f, h, _ = self.params(); n = len(self.remote.texts); CALLS.clear()
        with self.assertRaises(SystemExit): self.main(self.run_args("apply", f, "e" * 64))
        self.assertEqual((CALLS, len(self.remote.texts)), ([], n)); self.assertEqual(list(R.OUT.glob("attempt-*")), [])

class Stage(Base):
    def test_private_stage_and_verified_uploads(self):
        st = self.staged(); d = st["stage"]
        self.assertRegex(d, R.STAGE_RE)
        mk = self.remote.texts[0]
        self.assertIn("SetAccessRuleProtection($true,$false)", mk); self.assertIn("'S-1-5-18','S-1-5-32-544'", mk)
        self.assertIn("refused: the stage exists", mk); self.assertLess(mk.index("Test-Path"), mk.index("CreateDirectory"))
        self.assertEqual(sorted(w for _, w, _ in self.remote.uploads), sorted([d + "\\node-pair-restart.ps1", d + "\\bundle-swap.ps1", d + "\\files\\chain.mjs", d + "\\files\\host.mjs"]))
        self.assertTrue(st["ok"]); self.assertEqual(st["inputs"]["chain.mjs"]["sha"], self.C)
        self.assertNotIn("HELPER-CONTENT-MARKER", self.rec.read_text(), "a receipt never holds file content")
    def test_pre_existing_stage_uploads_nothing(self):
        self.remote.mk = {"decision": "refused: the stage exists"}
        self.assertEqual(self.main(self.stage_args()), 4); self.assertEqual(self.remote.uploads, [])
    def test_open_stage_acl_uploads_nothing(self):
        self.remote.mk = {"decision": "created", "created": "x", "protected": False, "sids": ["S-1-1-0"]}
        self.assertEqual(self.main(self.stage_args()), 4); self.assertEqual(self.remote.uploads, [])
    def test_remote_hash_mismatch_fails_the_stage(self):
        orig = self.remote.ps
        def ps(text, secs=150):
            r = orig(text, secs)
            if isinstance(r, dict) and r.get("decision") == "created": self.remote.corrupt.add(r["created"] + "\\files\\host.mjs")
            return r
        self.remote.ps = ps
        self.assertEqual(self.main(self.stage_args()), 4)
        self.assertFalse(json.loads(next(R.OUT.glob("stage-*.json")).read_text())["ok"])
    def test_a_failing_stage_receipt_is_refused_for_runs(self):
        self.staged(); bad = json.loads(self.rec.read_text()); bad["ok"] = False; p = self.t / "bad.json"; p.write_text(json.dumps(bad))
        f, h, _ = self.params(); self.rec = p
        with self.assertRaises(SystemExit): self.main(self.run_args("apply", f, h))
        bad["ok"] = True; bad["stage"] = r"C:\ProgramData\Enclave\staging\..\network"; p.write_text(json.dumps(bad))
        with self.assertRaises(SystemExit): self.main(self.run_args("apply", f, h))

class ParamsGate(Base):
    def refused(self, mode="apply", **over):
        f, h, _ = self.params(mode, **over); n = len(self.remote.texts); CALLS.clear(); before = set(R.OUT.glob("attempt-*"))
        rc = self.main(self.run_args(mode, f, h))
        self.assertEqual(rc, 2, self.out); self.assertEqual((CALLS, len(self.remote.texts)), ([], n), "a refusal made a remote call")
        self.assertEqual(set(R.OUT.glob("attempt-*")), before, "a refusal wrote an attempt record"); return json.loads(self.out)["refused"]
    def test_examples_with_unset_identities_never_apply(self):
        self.staged()
        ex = json.loads((HERE / "params.apply.example.json").read_text()); ex["stage"] = self.st["stage"]; ex["runId"] = "apply-example-01"
        f = self.t / "ex.json"; f.write_text(json.dumps(ex)); n = len(self.remote.texts)
        self.assertEqual(self.main(self.run_args("apply", f, sha(f.read_bytes()))), 2)
        why = " ".join(json.loads(self.out)["refused"])
        for k in ("params.node", "params.scheduler", "params.expectedIds", "params.lease", "params.task", "params.nodeSha", "oldSha", "newSha"): self.assertIn(k, why)
        self.assertEqual(len(self.remote.texts), n)
    def test_each_final_identity_is_required(self):
        self.staged()
        for k in ("node", "scheduler", "privacy", "manager", "vms", "hyperv", "expectedIds", "lease", "task", "nodeSha", "runner"):
            self.assertTrue(self.refused(**{k: DEL}), k)
        self.assertTrue(self.refused(expectedIds=[]))
        self.assertTrue(self.refused(expectedIds=["0x" + "c" * 64, "0x" + "c" * 64]))
        self.assertTrue(self.refused(lease={"marginSec": 120}))
        self.assertTrue(self.refused(vms="unavailable"))
    def test_quoting_and_path_bounds(self):
        self.staged(); s = self.st["stage"]
        for rid in ("x'; Remove-Item C:\\ -Recurse; '", "run id", "RUN-UPPER", "a", "../../etc", "r" * 80):
            self.assertTrue(self.refused(runId=rid), rid)
        fs = lambda **kw: [dict(f, **kw.get(f["name"], {})) for f in self.params()[2]["files"]]
        self.assertTrue(self.refused(files=fs(**{"chain.mjs": {"target": R.NODEDIR + "\\..\\..\\network\\privacy-agent.mjs"}})))
        self.assertTrue(self.refused(files=fs(**{"host.mjs": {"newFile": r"C:\ProgramData\Enclave\network\host.mjs"}})))
        self.assertTrue(self.refused(files=fs(**{"host.mjs": {"workDir": s + "\\swap-chain.mjs"}})))
        self.assertTrue(self.refused(files=fs(**{"chain.mjs": {"newSha": "d" * 64}})))
        self.assertTrue(self.refused(files=fs()[:1]))
        self.assertTrue(self.refused(stage=r"C:\ProgramData\Enclave\staging\nodepair-000000000000"))
        self.assertTrue(self.refused(bundleSwap={"path": s + "\\bundle-swap.ps1", "sha": "f" * 64}))
        self.assertTrue(self.refused(nodeExe=r"C:\Program Files\nodejs\node.exe"))
        self.assertTrue(self.refused(boundSec=1200)); self.assertTrue(self.refused(boundSec=True))
        for path in (r"C:\ProgramData\Enclave\..\x", s + "\\params.json", "D:\\x", r"C:\x'$(evil)", R.NODEDIR + "\\host.mjs"):
            self.assertTrue(self.refused(unchangedFiles=[{"path": path, "sha": "3" * 64}]), path)
        self.assertTrue(self.refused(testRoot="/tmp/x")); self.assertTrue(self.refused(extra=1))
        self.assertEqual(R.q("a'b"), "'a''b'")
    def test_identify_allows_unset_identities(self):
        self.staged()
        f, h, p = self.params("identify", node=DEL, scheduler=DEL, privacy=DEL, manager=DEL, vms=DEL, hyperv=DEL, expectedIds=DEL, lease=DEL, task=DEL, runner=DEL, nodeSha=None)
        p["files"] = [dict(x, oldSha=None) for x in p["files"]]; p["unchangedFiles"] = [{"path": r"C:\ProgramData\Enclave\run-node.cmd", "sha": None}]
        f.write_text(json.dumps(p)); h = sha(f.read_bytes())
        self.remote.journal = {"lines": [json.dumps({"step": "identify", "final": "IDENTIFIED"})], "task": "unregistered after final"}
        self.assertEqual(self.main(self.run_args("identify", f, h)), 0, self.out)
        loader = self.decoded_loader(); self.assertIn("-Mode 'identify'", loader)
    def decoded_loader(self):
        t = next(x for x in self.remote.texts if "Register-ScheduledTask" in x)
        enc = re.search(r"-EncodedCommand ([A-Za-z0-9+/=]+)'", t).group(1)
        return base64.b64decode(enc).decode("utf-16-le")

class Runs(ParamsGate):
    def test_uncertain_launch_is_never_retried(self):
        self.staged(); f, h, p = self.params()
        self.remote.launch = {"error": "no output (ssh rc 255)", "stderr": ""}
        self.assertEqual(self.main(self.run_args("apply", f, h)), 3); self.assertIn("LAUNCH NOT CONFIRMED", self.out)
        launches = [t for t in self.remote.texts if "Register-ScheduledTask" in t]; self.assertEqual(len(launches), 1)
        res = json.loads((R.OUT / f"apply-result-{p['runId']}.json").read_text()); self.assertIn("NOT retried", res["outcome"])
        n, CALLS[:] = len(self.remote.texts), []
        self.assertEqual(self.main(self.run_args("apply", f, h)), 4); self.assertIn("never retried", self.out)
        self.assertEqual((len(self.remote.texts), CALLS), (n, []), "the second invocation made a remote call")
    def test_params_upload_mismatch_launches_nothing(self):
        self.staged(); f, h, p = self.params(); self.remote.corrupt.add(self.st["stage"] + f"\\params-apply-{p['runId']}.json")
        self.assertEqual(self.main(self.run_args("apply", f, h)), 3)
        self.assertFalse([t for t in self.remote.texts if "Register-ScheduledTask" in t])
    def test_scp_failure_launches_nothing(self):
        self.staged(); f, h, p = self.params()
        global FAKE_SCP; FAKE_SCP = lambda argv: subprocess.CompletedProcess(argv, 1, "", "lost connection")
        self.assertEqual(self.main(self.run_args("apply", f, h)), 3)
        self.assertFalse([t for t in self.remote.texts if "Register-ScheduledTask" in t])
    def test_apply_done(self):
        self.staged(); f, h, p = self.params(); self.remote.mode, self.remote.run = "apply", p["runId"]
        self.remote.journal = {"lines": [json.dumps({"step": "pins"}), json.dumps({"step": "post", "final": "DONE: the node runs the NEW pair"})], "task": "unregistered after final"}
        self.assertEqual(self.main(self.run_args("apply", f, h)), 0, self.out)
        s = self.st["stage"]; pu = [u for u in self.remote.uploads if "params-" in u[1]]
        self.assertEqual([(w, before) for _, w, before in pu], [(s + f"\\params-apply-{p['runId']}.json", True)], "the attempt record precedes the params upload")
        launch = next(t for t in self.remote.texts if "Register-ScheduledTask" in t)
        self.assertIn(R.q("node-pair-" + p["runId"]), launch); self.assertIn("-ExecutionTimeLimit (New-TimeSpan -Minutes 20)", launch)
        self.assertIn("\\EnclaveOps\\", launch); self.assertIn("-UserId 'SYSTEM'", launch)
        loader = self.decoded_loader()
        self.assertEqual(loader, R.LOADER.replace("PS1X", s + "\\node-pair-restart.ps1").replace("PSHA", self.H).replace("PFX", s + f"\\params-apply-{p['runId']}.json")
                         .replace("PFSHA", h).replace("MODEX", "apply"))
        for t in self.remote.texts + [loader]:
            for bad in ("-File", "ExecutionPolicy", "Bypass", "Set-ExecutionPolicy"): self.assertNotIn(bad, t)
        j = next(t for t in self.remote.texts if "ReadAllLines" in t); self.assertIn(R.q(s + f"\\pair-{p['runId']}.jsonl"), j)
        res = json.loads((R.OUT / f"apply-result-{p['runId']}.json").read_text()); self.assertEqual(res["kind"], "ok")
    def test_recovery_final_is_not_success(self):
        self.staged(); f, h, p = self.params()
        self.remote.journal = {"lines": ["not json \"final\"", json.dumps({"final": "RECOVERY_REQUIRED: a swap outcome is unknown"})], "task": "Ready"}
        self.assertEqual(self.main(self.run_args("apply", f, h)), 3)
        self.assertEqual(json.loads((R.OUT / f"apply-result-{p['runId']}.json").read_text())["kind"], "recovery")
    def test_rollback_needs_the_same_finalized_params(self):
        self.staged(); f, h, p = self.params("rollback", lease={"reserve": "terminal-return", "marginSec": 120, "revertSec": 0, "forwardMinSec": 540, "startNodeSec": 480})
        self.remote.journal = {"lines": [json.dumps({"final": "ROLLED_BACK: the node runs the OLD pair (returned)"})], "task": "unregistered after final"}
        self.assertEqual(self.main(self.run_args("rollback", f, h)), 0, self.out); self.assertIn("-Mode 'rollback'", self.decoded_loader())
        self.assertTrue(self.refused("rollback", node=DEL))
    def test_no_final_reports_and_does_not_succeed(self):
        self.staged(); f, h, p = self.params()
        self.assertEqual(self.main(self.run_args("apply", f, h) + ["--poll-sec", "0"]), 3); self.assertIn("NO FINAL YET", self.out)
    def test_status_reads_only_task_and_journal(self):
        self.staged(); n = len(self.remote.texts)
        self.assertEqual(self.main(["--status", "--stage-receipt", str(self.rec), "--run-id", "apply-run-0001"]), 0)
        new = self.remote.texts[n:]; self.assertEqual(len(new), 2)
        self.assertIn("Get-ScheduledTaskInfo", new[0]); self.assertIn("ReadAllLines", new[1]); self.assertEqual(CALLS[-4:], CALLS[-4:])
        with self.assertRaises(SystemExit): self.main(["--status", "--stage-receipt", str(self.rec), "--run-id", "x'y"])

class Verbatim(unittest.TestCase):
    def test_loader_launch_journal_are_verbatim(self):
        self.assertEqual(sha(HOLD.read_bytes()), "1d1b995c134373c0d5e72a8a3ca83a5726595d3d7d1de0a8e4cfc08ca8f69f0a")
        tree, env = ast.parse(HOLD.read_text()), {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ("U", "LOADER", "LAUNCH", "JOURNAL"):
                env[node.targets[0].id] = eval(compile(ast.Expression(node.value), "hold", "eval"), {}, dict(env))
        for k in ("U", "LOADER", "LAUNCH", "JOURNAL"): self.assertEqual(getattr(R, k), env[k], k)
    def test_every_remote_text_fits_the_transport(self):
        spec = importlib.util.spec_from_file_location("transport_check", R.T[0]); tm = importlib.util.module_from_spec(spec); spec.loader.exec_module(tm)
        d = r"C:\ProgramData\Enclave\staging\nodepair-0123456789ab"; run = "r" * 41; tn = R.q("node-pair-" + run)
        self.assertTrue(R.RUN_RE.match(run)) ; self.assertFalse(R.RUN_RE.match(run + "r"))   # the LONGEST accepted run id
        loader = R.LOADER.replace("PS1X", d + "\\node-pair-restart.ps1").replace("PSHA", "a" * 64).replace("PFX", d + f"\\params-rollback-{run}.json").replace("PFSHA", "b" * 64).replace("MODEX", "rollback")
        texts = {"launch": R.LAUNCH.replace("TNX", tn).replace("ENCX", base64.b64encode(loader.encode("utf-16-le")).decode()),
                 "mkstage": R.MKSTAGE.replace("DX", R.q(d)), "shas": R.SHAS.replace("PX", ",".join(R.q(d + x) for x in ("\\node-pair-restart.ps1", "\\bundle-swap.ps1", "\\files\\chain.mjs", "\\files\\host.mjs"))).replace("DX", R.q(d)),
                 "journal": R.JOURNAL.replace("JX", R.q(d + f"\\pair-{run}.jsonl")).replace("TNX", tn), "taskinfo": R.TASKINFO.replace("TNX", tn)}
        for k, t in texts.items():
            n = len(base64.b64encode((tm.HEAD.replace("SECS", "90") + t).encode("utf-16-le")))
            self.assertLessEqual(n, 7900, k)
    def test_classify(self):
        c = R.classify
        self.assertEqual([c("DONE: x", "apply"), c("DONE: x", "rollback"), c("ROLLED_BACK: x", "rollback"), c("IDENTIFIED", "identify"), c("IDENTIFIED", "apply")],
                         ["ok", "unknown", "ok", "ok", "unknown"])
        self.assertEqual([c("DONE_CHECK: x", "apply"), c("RECOVERY_REQUIRED: x", "apply"), c("REFUSED: x", "rollback"), c("CRASHED in phase pins", "apply"),
                          c("SWAP_REFUSED_OLD_PAIR_RESTARTED: x", "apply"), c("??", "apply")], ["check", "recovery", "refused", "crashed", "pair-unchanged-restarted", "unknown"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
