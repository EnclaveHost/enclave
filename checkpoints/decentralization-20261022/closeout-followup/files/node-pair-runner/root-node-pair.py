#!/usr/bin/env python3
"""ROOT-ONLY runner for the node-only pair window helper node-pair-restart.ps1 on minipc. PREPARED by Claude (2026-10-22); NEVER
run by its author; no remote call was ever made with it. Importing it does nothing remote; every remote step is one explicit
command below. Reused VERBATIM: the transport ps() (work/nucbox-tls-20261021/root-activate-reviewed.py, loaded only when its
bytes are the c50aac8e pin) and the U/LOADER/LAUNCH/JOURNAL texts of work/root-control-rpc-final-20261022/control-package/
helper/root-node-hold.py (1d1b995c; test_root_node_pair.py proves them byte-identical). Nothing else of that runner (its
manifest, network/control file sets, cutover, budget or pins) is inherited.

ROOT supplies every pin: the reviewed helper (path + sha), the two candidate modules (chain.mjs, host.mjs: path + sha), and,
per run, an immutable params file + its sha (schema: PARAMS.md). This runner chooses no lease budget, no expectedIds and no
live identity: they come from root's params, and the helper's own gate stays authoritative.

  root-node-pair.py                                                  usage only (no remote)
  root-node-pair.py --stage --helper H --helper-sha X --chain C --chain-sha Y --host S --host-sha Z
        NEW C:\\ProgramData\\Enclave\\staging\\nodepair-<uuid12>, SYSTEM+Administrators only from its creation (protected
        DACL); uploads ONLY the helper, bundle-swap.ps1 21d85c69 and the two modules; every upload sha-verified -> runs/stage-*.json
  root-node-pair.py --run identify --stage-receipt R --params P --params-sha X        FIRST root step: helper -Mode identify
  root-node-pair.py --run apply    --stage-receipt R --params P --params-sha X        the window (helper -Mode apply)
  root-node-pair.py --run rollback --stage-receipt R --params P --params-sha X        root's explicit return (-Mode rollback)
  root-node-pair.py --status --stage-receipt R --run-id ID                            read the run's journal + task (read-only)

--run: local checks first (pins, params sha + schema, stage receipt), then an O_EXCL attempt record (an existing one REFUSES:
never retried), the params upload (sha-verified), ONE unique one-shot SYSTEM task \\EnclaveOps\\node-pair-<runId> (20-min
ExecutionTimeLimit) whose ScriptBlock loader runs the helper only from bytes hashing to the pin, with -ParamsSha; then the
journal is polled. An uncertain launch or upload is reported and NEVER retried. JOURNAL unregisters the task only after a final
line and only when it is not running. Never read: config values, keys, wallet data; the journal is hash/PID/count-only.
"""
import argparse, base64, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, uuid

HERE = pathlib.Path(__file__).resolve().parent; OUT = HERE / "runs"
W = next(p for p in HERE.parents if (p / "nucbox-tls-20261021").is_dir())     # the work tree
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
BUNDLE_SWAP = (W / "cron-startup-20261021/respawn-activation/bundle-swap.ps1", "21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103")
NODE_EXE = r"C:\Program Files\Enclave\runtime\node\node.exe"          # the installed agent's node.exe (root pins its sha)
NODEDIR = r"C:\Program Files\Enclave\control\windows\node"
PAIR = ("chain.mjs", "host.mjs")
HELPER = "node-pair-restart.ps1"
STAGE_RE = re.compile(r"^C:\\ProgramData\\Enclave\\staging\\nodepair-[0-9a-f]{12}$")
# a runId is <= 41 chars: it is in the task name AND, encoded twice, in the loader, and LAUNCH must stay under the transport's 7900
RUN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,40}$"); HEX = re.compile(r"^[0-9a-f]{64}$"); ID = re.compile(r"^0x[0-9a-f]{64}$")
MAX_BOUND = 1140                                                         # the helper's MAX_BOUND (task limit 20 min)
POLL_SEC, SLEEP = 1260, 20
q = lambda v: "'" + str(v).replace("'", "''") + "'"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

# ---------------------------------------------------------------- VERBATIM from root-node-hold.py 1d1b995c (L73, L126-138)
U = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
LOADER = ("$b=[IO.File]::ReadAllBytes('PS1X');if((-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|%{$_.ToString('x2')})) -ne 'PSHA'){exit 3};"
          "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -Mode 'MODEX' -ParamsFile 'PFX' -ParamsSha 'PFSHA'")
LAUNCH = U + (
    r"$tn=TNX;if(Get-ScheduledTask -TaskPath '\EnclaveOps\' -TaskName $tn -ErrorAction SilentlyContinue){@{decision='refused: the task exists'}|ConvertTo-Json -Compress;exit 0};"
    # (no hash check here: the task's loader hashes the script bytes it runs, and the script hashes its params bytes)
    r"$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ENCX');"
    r"$pr=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;"
    r"$st=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew;"
    r"$null=Register-ScheduledTask -TaskPath '\EnclaveOps\' -TaskName $tn -Action $a -Principal $pr -Settings $st;Start-ScheduledTask -TaskPath '\EnclaveOps\' -TaskName $tn;"
    r"Start-Sleep 3;[ordered]@{decision='started';state=[string](Get-ScheduledTask -TaskPath '\EnclaveOps\' -TaskName $tn).State}|ConvertTo-Json -Compress")
JOURNAL = U + (r"$j=JX;$o=[ordered]@{lines=@(if(Test-Path -LiteralPath $j){[IO.File]::ReadAllLines($j)|Select-Object -Last 40})};"
    r"$t=Get-ScheduledTask -TaskPath '\EnclaveOps\' -TaskName TNX -ErrorAction SilentlyContinue;$o.task=$(if($t){[string]$t.State}else{'absent'});"
    r"if($t -and [string]$t.State -ne 'Running' -and @($o.lines|Where-Object{$_.Contains([string][char]34+'final'+[char]34)}).Count){Unregister-ScheduledTask -TaskPath '\EnclaveOps\' -TaskName TNX -Confirm:$false;$o.task='unregistered after final'};$o|ConvertTo-Json -Compress -Depth 4")

# ---------------------------------------------------------------- NEW (small): the private stage, upload hashes, task facts
# the stage is created WITH its protected SYSTEM+Administrators DACL (never created open and tightened later); a pre-existing
# path refuses; the read-back reports protection, owner and the DACL's SIDs
MKSTAGE = U + (r"$d=DX;if(Test-Path -LiteralPath $d){@{decision='refused: the stage exists'}|ConvertTo-Json -Compress;exit 0};"
    r"$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false);"
    r"foreach($x in 'S-1-5-18','S-1-5-32-544'){$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $x),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};"
    r"[void][IO.Directory]::CreateDirectory($d,$ds);[void][IO.Directory]::CreateDirectory($d+'\files');$a=Get-Acl -LiteralPath $d;"
    r"[ordered]@{decision='created';created=$d;protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;"
    r"sids=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique)}|ConvertTo-Json -Compress")
SHAS = U + (r"$o=[ordered]@{};foreach($x in @(PX)){$o[$x]=FileSha $x};"
    r"$a=Get-Acl -LiteralPath DX;$o['@protected']=$a.AreAccessRulesProtected;$o['@sids']=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique);$o|ConvertTo-Json -Compress")
TASKINFO = U + (r"$i=Get-ScheduledTaskInfo -TaskPath '\EnclaveOps\' -TaskName TNX -ErrorAction SilentlyContinue;"
    r"$(if($i){[ordered]@{lastTaskResult=$i.LastTaskResult;lastRunTime=$(if($i.LastRunTime -is [datetime]){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null})}}else{@{task='absent'}})|ConvertTo-Json -Compress")

m = None                                                                 # the transport, loaded only by a remote command

def transport():
    global m
    if m is None:
        if sha(T[0]) != T[1]: raise SystemExit(f"the transport {T[0]} is not the reviewed c50aac8e bytes")
        spec = importlib.util.spec_from_file_location("transport", T[0]); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); m = mod
    return m

def scp(src, dst, secs):
    return subprocess.run(["timeout", str(secs), "scp", "-q", "-o", "BatchMode=yes", str(src), "minipc:/" + dst.replace("\\", "/")], capture_output=True, text=True)

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", OUT / name); return OUT / name

def attempt(name, body):
    try: save(name, {"what": "attempt", "at": now(), **body}); return True
    except FileExistsError: print(f"REFUSED: {OUT / name} exists; an attempt is never retried automatically (root inspects, then decides)"); return False

def pinned(path, want, what):
    """a local input, exactly the sha root supplied (checked before ANY remote call)"""
    if not HEX.match(str(want or "")): raise SystemExit(f"{what}: a lowercase sha256 is required")
    p = pathlib.Path(path or "")
    if not path or not p.is_file(): raise SystemExit(f"{what}: {path} is not a file")
    if sha(p) != want: raise SystemExit(f"{what}: {path} is not {want}")
    return p

def staged(stage, name): return stage + "\\files\\" + name

def stage_receipt(path):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != "stage" or o.get("ok") is not True or not STAGE_RE.match(str(o.get("stage", ""))): raise SystemExit(f"{path}: not a passing stage receipt")
    return o

def check_params(p, st, mode):
    """root's params against this stage and the helper's schema; the FINAL identities are required for apply/rollback.
    -> list of refusals (empty = acceptable). The helper re-checks everything at its pins (authoritative)."""
    r, s = [], st["stage"]
    allowed = {"stage", "runId", "boundSec", "runner", "nodeExe", "nodeSha", "bundleSwap", "files", "unchangedFiles", "task", "node",
               "scheduler", "manager", "privacy", "vms", "hyperv", "expectedIds", "lease"}
    if not isinstance(p, dict): return ["the params are not a JSON object"]
    if [k for k in p if k.startswith("test")]: r.append("test-harness keys (testRoot/testPrelude/testNode) never go to minipc")
    if set(p) - allowed: r.append(f"unknown params keys {sorted(set(p) - allowed)}")
    if p.get("stage") != s: r.append("params.stage is not this stage")
    if not RUN_RE.match(str(p.get("runId", ""))): r.append("params.runId must match " + RUN_RE.pattern)
    b = p.get("boundSec")
    if not isinstance(b, int) or isinstance(b, bool) or not 0 < b <= MAX_BOUND: r.append(f"params.boundSec must be an integer in 1..{MAX_BOUND}")
    if p.get("bundleSwap") != {"path": s + "\\bundle-swap.ps1", "sha": BUNDLE_SWAP[1]}: r.append("params.bundleSwap must be the staged bundle-swap.ps1 21d85c69")
    if p.get("nodeExe") != NODE_EXE: r.append(f"params.nodeExe must be {NODE_EXE}")
    if p.get("nodeSha") is not None and not HEX.match(str(p.get("nodeSha"))): r.append("params.nodeSha: 64 lowercase hex (or unset for identify)")
    fs = p.get("files") if isinstance(p.get("files"), list) else []
    by = {f.get("name"): f for f in fs if isinstance(f, dict)}
    if len(fs) != 2 or set(by) != set(PAIR): r.append("params.files must be exactly chain.mjs and host.mjs")
    final = mode in ("apply", "rollback")
    for n in PAIR:
        f = by.get(n) or {}
        if f.get("target") != NODEDIR + "\\" + n: r.append(f"{n}: target must be exactly {NODEDIR}\\{n}")
        if f.get("newFile") != staged(s, n): r.append(f"{n}: newFile must be the staged {staged(s, n)}")
        if f.get("workDir") != s + "\\swap-" + n: r.append(f"{n}: workDir must be {s}\\swap-{n}")
        if f.get("newSha") != (st.get("inputs", {}).get(n) or {}).get("sha"): r.append(f"{n}: newSha must be the staged candidate's sha")
        if (final or f.get("oldSha") is not None) and (not HEX.match(str(f.get("oldSha", ""))) or f.get("oldSha") == f.get("newSha")):
            r.append(f"{n}: oldSha must be root's identified live sha (64 lowercase hex, not newSha)")
    uf = p.get("unchangedFiles")
    if not isinstance(uf, list) or (final and not uf): r.append("params.unchangedFiles: a list (non-empty for apply/rollback)")
    for f in uf if isinstance(uf, list) else []:
        path = str((f or {}).get("path", ""))
        if not re.match(r"^C:\\[^'\"`$;|<>*?\r\n]+$", path) or ".." in path.split("\\") or path.lower().startswith(s.lower()) or path in [NODEDIR + "\\" + n for n in PAIR]:
            r.append(f"unchangedFiles: {path[:80]!r} is not an allowed absolute path")
        if (final or (f or {}).get("sha") is not None) and not HEX.match(str((f or {}).get("sha", ""))): r.append(f"unchangedFiles: {path[:80]!r} needs a 64-hex sha")
    if not final: return r
    # apply / rollback: every FINAL identity explicit (root's identify supplies them); the budget present (the helper judges it)
    if not HEX.match(str(p.get("nodeSha", ""))): r.append("params.nodeSha: the root-verified sha of " + NODE_EXE)
    if not ID.match(str(p.get("runner", ""))): r.append("params.runner: the 0x… runner id")
    t = p.get("task") or {}
    if not (isinstance(t.get("execute"), str) and t["execute"] and isinstance(t.get("arguments"), str)): r.append("params.task: the identified \\Enclave\\Node action (execute, arguments)")
    pos = lambda v: isinstance(v, int) and not isinstance(v, bool) and v > 0
    iso = lambda v: isinstance(v, str) and re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", v)
    nd = p.get("node") or {}
    if not (pos(nd.get("cmdPid")) and iso(nd.get("cmdStart")) and pos(nd.get("agentPid")) and iso(nd.get("agentStart"))): r.append("params.node: identified cmdPid/cmdStart/agentPid/agentStart")
    sc = p.get("scheduler") or {}
    if not (pos(sc.get("pid")) and iso(sc.get("start")) and isinstance(sc.get("name"), str) and sc["name"] and isinstance(sc.get("commandLike"), str) and sc["commandLike"]):
        r.append("params.scheduler: identified pid/start/name/commandLike")
    pv = p.get("privacy") or {}
    if not (pos(pv.get("pid")) and iso(pv.get("start"))): r.append("params.privacy: identified pid/start")
    for k in ("manager", "vms", "hyperv"):
        if not isinstance(p.get(k), str) or p.get(k) in ("", "unavailable") or "ROOT" in p.get(k): r.append(f"params.{k}: the identified value")
    ex = p.get("expectedIds")
    if not isinstance(ex, list) or not ex or not all(isinstance(i, str) and ID.match(i) for i in ex) or len(set(ex)) != len(ex):
        r.append("params.expectedIds: root's exact running set (unique 0x… ids; the helper refuses any other set)")
    lp = p.get("lease") or {}
    if not all(isinstance(lp.get(k), int) and not isinstance(lp.get(k), bool) for k in ("marginSec", "revertSec", "forwardMinSec", "startNodeSec")):
        r.append("params.lease: root's explicit budget (marginSec, revertSec, forwardMinSec, startNodeSec; reserve/returnPinsSec as the helper requires)")
    return r

def finals(j):
    """the helper's final decisions in a JOURNAL answer (a line that does not parse is never a final)"""
    out = []
    for l in (j.get("lines") or []) if isinstance(j, dict) else []:
        try: f = json.loads(l).get("final")
        except Exception: continue
        if isinstance(f, str): out.append(f)
    return out

def classify(final, mode):
    f = str(final)
    if mode == "identify": return "ok" if f == "IDENTIFIED" else "refused" if f.startswith("REFUSED") else "unknown"
    if (mode == "apply" and f.startswith("DONE:")) or (mode == "rollback" and f.startswith("ROLLED_BACK:")): return "ok"
    for pre, kind in (("RECOVERY_REQUIRED", "recovery"), ("REFUSED", "refused"), ("CRASHED", "crashed")):
        if f.startswith(pre): return kind
    if re.match(r"^[A-Z0-9_]+_CHECK:", f): return "check"
    if re.match(r"^(SWAP_REFUSED_OLD_PAIR_RESTARTED|RETURN_REFUSED_NEW_PAIR_RESTARTED):", f): return "pair-unchanged-restarted"
    return "unknown"

def cmd_stage(o):
    ins = {HELPER: pinned(o.helper, o.helper_sha, "--helper"), "chain.mjs": pinned(o.chain, o.chain_sha, "--chain"), "host.mjs": pinned(o.host, o.host_sha, "--host")}
    shas = {HELPER: o.helper_sha, "chain.mjs": o.chain_sha, "host.mjs": o.host_sha}
    if o.chain_sha == o.host_sha: raise SystemExit("--chain and --host are the same bytes")
    pinned(BUNDLE_SWAP[0], BUNDLE_SWAP[1], "bundle-swap.ps1"); tp = transport()
    d = r"C:\ProgramData\Enclave\staging\nodepair-" + uuid.uuid4().hex[:12]; ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    rec = {"what": "stage", "at": now(), "stage": d, "inputs": {n: {"local": str(p), "sha": shas[n]} for n, p in ins.items()} | {"bundle-swap.ps1": {"local": str(BUNDLE_SWAP[0]), "sha": BUNDLE_SWAP[1]}}}
    rec["mkdir"] = tp.ps(MKSTAGE.replace("DX", q(d)), 60)
    mk = rec["mkdir"]
    if not (isinstance(mk, dict) and mk.get("decision") == "created" and mk.get("created") == d and mk.get("protected") is True and mk.get("sids") == ["S-1-5-18", "S-1-5-32-544"]):
        rec["ok"] = False; save(f"stage-{ts}.json", rec); print(json.dumps(mk, indent=1)); print("STAGE NOT CREATED AS PRIVATE: nothing uploaded"); return 4
    want = {d + "\\" + HELPER: shas[HELPER], d + "\\bundle-swap.ps1": BUNDLE_SWAP[1], staged(d, "chain.mjs"): shas["chain.mjs"], staged(d, "host.mjs"): shas["host.mjs"]}
    src = {d + "\\" + HELPER: ins[HELPER], d + "\\bundle-swap.ps1": BUNDLE_SWAP[0], staged(d, "chain.mjs"): ins["chain.mjs"], staged(d, "host.mjs"): ins["host.mjs"]}
    for dst in want:
        c = scp(src[dst], dst, 300)
        if c.returncode: rec["uploadFailed"] = {"file": dst, "rc": c.returncode, "stderr": c.stderr[-300:]}; break
    v = tp.ps(SHAS.replace("PX", ",".join(q(x) for x in want)).replace("DX", q(d)), 90); rec["verify"] = v
    rec["ok"] = ("uploadFailed" not in rec and isinstance(v, dict) and "error" not in v and all(v.get(x) == h for x, h in want.items())
                 and v.get("@protected") is True and v.get("@sids") == ["S-1-5-18", "S-1-5-32-544"])
    save(f"stage-{ts}.json", rec); print(json.dumps({"stage": d, "ok": rec["ok"]}, indent=1)); return 0 if rec["ok"] else 4

def cmd_run(o):
    mode = o.run; st = stage_receipt(o.stage_receipt); stage = st["stage"]
    hs = (st.get("inputs", {}).get(HELPER) or {}).get("sha")
    if not HEX.match(str(hs or "")): raise SystemExit("the stage receipt names no helper sha")
    pp = pinned(o.params, o.params_sha, "--params"); p = json.loads(pp.read_bytes())
    bad = check_params(p, st, mode)
    if bad: print(json.dumps({"refused": bad}, indent=1)); return 2
    pinned(BUNDLE_SWAP[0], BUNDLE_SWAP[1], "bundle-swap.ps1"); tp = transport()
    run = p["runId"]; tn = "node-pair-" + run; remote_p = stage + f"\\params-{mode}-{run}.json"; ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not attempt(f"attempt-{mode}-{run}.json", {"mode": mode, "stage": stage, "helperSha": hs, "paramsSha": o.params_sha, "task": tn}): return 4
    res = {"what": "result", "mode": mode, "runId": run, "task": tn, "paramsSha": o.params_sha, "helperSha": hs}
    c = scp(pp, remote_p, 120)
    if c.returncode: save(f"{mode}-result-{run}.json", {**res, "at": now(), "error": f"params upload failed (scp rc {c.returncode}); nothing launched; NOT retried", "stderr": c.stderr[-300:]}); return 3
    v = tp.ps(SHAS.replace("PX", q(remote_p)).replace("DX", q(stage)), 60)
    if not isinstance(v, dict) or v.get(remote_p) != o.params_sha:
        save(f"{mode}-result-{run}.json", {**res, "at": now(), "error": "the uploaded params are not the supplied sha; nothing launched; NOT retried", "verify": v}); return 3
    loader = (LOADER.replace("PS1X", stage + "\\" + HELPER).replace("PSHA", hs).replace("PFX", remote_p).replace("PFSHA", o.params_sha).replace("MODEX", mode))
    enc = base64.b64encode(loader.encode("utf-16-le")).decode()
    r = tp.ps(LAUNCH.replace("TNX", q(tn)).replace("ENCX", enc), 90)
    print(json.dumps({"launch": r, "runId": run}, indent=1))
    if not isinstance(r, dict) or r.get("decision") != "started":
        save(f"{mode}-result-{run}.json", {**res, "at": now(), "launch": r, "outcome": "LAUNCH NOT CONFIRMED: the task may or may not exist/run; NOT retried"})
        print(f"LAUNCH NOT CONFIRMED: never re-run this attempt; read --status --run-id {run} (root decides)"); return 3
    end, j = time.time() + (POLL_SEC if o.poll_sec is None else o.poll_sec), {}
    while time.time() < end:
        time.sleep(SLEEP); j = tp.ps(JOURNAL.replace("JX", q(stage + f"\\pair-{run}.jsonl")).replace("TNX", q(tn)), 60)
        if finals(j): break
    fin = finals(j)
    kind = classify(fin[-1], mode) if fin else None
    save(f"{mode}-result-{run}.json", {**res, "at": now(), "launch": r, "journal": j, "final": fin[-1] if fin else None, "kind": kind})
    print(json.dumps({"final": fin[-1] if fin else None, "kind": kind}, indent=1))
    if not fin: print(f"NO FINAL YET: the task may still run; read --status --run-id {run}; NEVER start another run meanwhile")
    return 0 if kind == "ok" else 3

def cmd_status(o):
    st = stage_receipt(o.stage_receipt)
    if not RUN_RE.match(str(o.run_id or "")): raise SystemExit("--run-id must match " + RUN_RE.pattern)
    tp = transport(); tn = "node-pair-" + o.run_id
    info = tp.ps(TASKINFO.replace("TNX", q(tn)), 60)
    j = tp.ps(JOURNAL.replace("JX", q(st["stage"] + f"\\pair-{o.run_id}.jsonl")).replace("TNX", q(tn)), 60)
    print(json.dumps({"taskInfo": info, "journal": j}, indent=1)); return 0

def main(argv):
    a = argparse.ArgumentParser(description="ROOT-ONLY runner for node-pair-restart.ps1 (see the module docstring)"); x = a.add_mutually_exclusive_group()
    x.add_argument("--stage", action="store_true"); x.add_argument("--run", choices=["identify", "apply", "rollback"]); x.add_argument("--status", action="store_true")
    for k in ("helper", "helper-sha", "chain", "chain-sha", "host", "host-sha", "stage-receipt", "params", "params-sha", "run-id"): a.add_argument("--" + k)
    a.add_argument("--poll-sec", type=int, default=None)
    o = a.parse_args(argv)
    if o.stage: return cmd_stage(o)
    if o.run: return cmd_run(o)
    if o.status: return cmd_status(o)
    print(__doc__); return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
