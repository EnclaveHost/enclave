#!/usr/bin/env python3
"""ROOT-ONLY driver for the PRIVACY half of the paired challenge activation on minipc (challenge-activate.ps1). PREPARED by Claude;
NEVER run by its author; no remote call was made with it. The hs2 half is the existing root-hs2-parallel.py (manifest 83e15e6d,
driver 1813a727, staged hs2up-txt-a2b349248b61) and runs FIRST; see RECIPE.txt for the whole bounded order and its rollback.
Reuse: the remote texts IDN / UPD / LOADER / LAUNCH / JOURNAL (and gupd_refusals) are parsed from the pinned rpc-integrated driver
1d1b995c (root-accepted, running in root-control-rpc-final) - never re-typed; transport c50aac8e.

  root-challenge-activation.py                                  PLAN only: pins + steps; no network
  root-challenge-activation.py --preflight-read --control-receipt C [--accept-control-check]   read-only -> runs/preflight-*.json
  root-challenge-activation.py --stage --preflight P            NEW C:\\ProgramData\\Enclave\\staging\\chact-<12hex>: 4 pinned files, verified
  root-challenge-activation.py --apply --stage-receipt S --preflight P [--tunnel-policy absent-or-sshd|sshd-required]
  root-challenge-activation.py --rollback RUN --stage-receipt S --preflight P
  root-challenge-activation.py --status --stage-receipt S --run-id R
Every mutating call writes an attempt record (O_EXCL) BEFORE the remote call; an existing record refuses (never retried). Output: shas,
key NAMES, PIDs, start times, public RPC URLs, counts; never a config value, key, proof key or log line.
"""
import argparse, ast, base64, calendar, hashlib, importlib.util, json, pathlib, re, subprocess, sys, time, uuid

HERE = pathlib.Path(__file__).resolve().parent; OUT = HERE / "runs"
W = next(p for p in HERE.parents if (p / "nucbox-tls-20261021").is_dir())
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
q = lambda v: "'" + str(v).replace("'", "''") + "'"
TRANSPORT = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
REUSE = (HERE / "inputs/root-node-hold.rpc-integrated.py", "1d1b995c134373c0d5e72a8a3ca83a5726595d3d7d1de0a8e4cfc08ca8f69f0a")
STAGED = {  # staged name -> (local path, sha256)
    "node-hold-cutover.ps1": (HERE / "inputs/node-hold-cutover.ps1", "df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8"),
    "edit-privacy-config.mjs": (HERE / "inputs/edit-privacy-config.mjs", "4d9c231e624e9c51bc83e1e86b06816aa53a38a168752881a0ec71a879a8d511"),
    "challengeReplica.json": (HERE / "inputs/challengeReplica.json", "2b644d22c3fe1517fcca13fd01c07363cd0f5f5a65ea7f16fb466d958d0b62ad"),
    "chact.ps1": (HERE / "challenge-activate.ps1", "a0bc41afa969edb0af3f00474bbed3121e3cde6f09fb8ed2aa77f0a0d39e7946"),
}
RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"
RPC5 = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://base.drpc.org", "https://mainnet.base.org"]
NODE_EXE, NODE_SHA = r"C:\Program Files\nodejs\node.exe", "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
HS2_CONFIG = "5f75562c970c715e3be44d02992207001438b9ab0831687a90b3c2aebfcebf43"   # root-hs2-parallel.py's config (route-dns parallel TXT)
RELEASE = {"dir": r"C:\Program Files\Enclave\challenge-replica\release-3e1560f94542",
           "dnsSha256": "3e1560f94542f57fb4c93aa6008ec35711fb21439c8adb74c9ee72fc22c90574", "runtimeBundleSha256": "3de76b54cf64fc06b5965bcc989290d6653de6e4f6e59f00b0da52e39218d76a"}
DECL = r"C:\ProgramData\Enclave\challenge-replica\challenge-front.json"
PORTS = {"dns": 18353, "api": 18354, "front": 18292, "tunnel": 31053}
BOUND_S, FRESH_S, APPLY_FRESH_S, CHALLENGE_WAIT_S = 900, 1800, 600, 240
STAGING = r"C:\ProgramData\Enclave\staging"; PREFIX = "chact-"

def reuse():
    """the reviewed texts and gupd_refusals, parsed from the pinned rpc-integrated driver (exact source, no import side effects)"""
    if sha(REUSE[0]) != REUSE[1]: raise SystemExit("the reused rpc-integrated driver is not 1d1b995c")
    tree = ast.parse(REUSE[0].read_text()); ns = {"calendar": calendar, "time": time, "CUT_FRESH_S": 600, "BOUND_S": BOUND_S}
    want = {"U", "IDN", "UPD", "LOADER", "LAUNCH", "JOURNAL"}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and getattr(node.targets[0], "id", None) in want | {"CUT_FRESH_S"}:
            exec(compile(ast.Module([node], []), str(REUSE[0]), "exec"), ns)
        if isinstance(node, ast.FunctionDef) and node.name == "gupd_refusals": exec(compile(ast.Module([node], []), str(REUSE[0]), "exec"), ns)
    if not want <= set(ns) or "gupd_refusals" not in ns: raise SystemExit("the reused driver lacks a text")
    return ns
R = reuse(); U = R["U"]

# challenge-specific READ-ONLY facts: config shape (key NAMES, public RPC URLs), the 4 loopback owners, hs2 config, release, declaration
# STATE (never its proof key), the privacy log length and the P0 count; one call
CH = U + (r"$o=[ordered]@{at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')};$pd='C:\ProgramData\Enclave';$cf=$pd+'\network\privacy-config.json';"
    r"$o.cfg=FileSha $cf;$c=[IO.File]::ReadAllText($cf)|ConvertFrom-Json;$o.enKeys=@($c.enclaveNetwork.PSObject.Properties.Name);$o.chainRpc=@($c.chain.rpc);"
    r"$o.cfgAcl=(Get-Acl -LiteralPath $cf).Sddl;$o|ConvertTo-Json -Compress -Depth 5")
CH2 = U + (r"$o=[ordered]@{};$pd='C:\ProgramData\Enclave';$o.ports=[ordered]@{};foreach($p in PORTSX){$l=@(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue);"
    r"$o.ports[[string]$p]=$(if($l.Count -eq 0){'absent'}elseif($l.Count -gt 1){'many'}else{$x=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$l[0].OwningProcess) -OperationTimeoutSec 20;"
    r"[ordered]@{pid=[int]$l[0].OwningProcess;name=[string]$x.Name;parent=[int]$x.ParentProcessId;path=[string]$x.ExecutablePath}})};"
    r"$o.hs2=FileSha 'C:\ProgramData\Enclave\host-services\hs2\config\host-services.json';$r='RELX';$o.release=[ordered]@{dns=FileSha ($r+'\dns.mjs');runtime=FileSha ($r+'\network-runtime.bundle.mjs')};"
    r"$d='DECLX';$o.declDir=Test-Path -LiteralPath (Split-Path -Parent $d);$o.decl=$(if(Test-Path -LiteralPath $d){try{$j=[IO.File]::ReadAllText($d)|ConvertFrom-Json;[ordered]@{state=[string]$j.state;pid=$j.pid}}catch{'unreadable'}}else{'absent'});"
    r"$o.netLog=$(try{(Get-Item -LiteralPath ($pd+'\logs\network.log')).Length}catch{-1});$o.nodeExe=FileSha 'NODEX';"
    r"$t=(Get-Date).ToUniversalTime().AddMinutes(-30).ToString('HH:mm');$n=(Get-Date).ToUniversalTime().ToString('HH:mm');"
    r"$o.policyUnavailable30min=@(Get-Content -LiteralPath ($pd+'\logs\node.log') -Tail 4000|Where-Object{$_ -like '*host wallet policy unavailable*' -or $_ -like '*chain quorum unavailable*'}|ForEach-Object{$_.Substring(0,5)}|Where-Object{if($t -le $n){$_ -ge $t -and $_ -le $n}else{$_ -ge $t -or $_ -le $n}}).Count;"
    r"try{$s=[IO.File]::ReadAllText($pd+'\network\state\status.json')|ConvertFrom-Json;$o.statusAgeMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[int64]$s.updatedAt;$o.statusRunner=[string]$s.walletAdmission.runner}catch{$o.statusAgeMs=-1};"
    r"try{$o.egressApps=@(([IO.File]::ReadAllText($pd+'\network\state\egress-routes.json')|ConvertFrom-Json).apps.PSObject.Properties).Count}catch{$o.egressApps=-1};$o|ConvertTo-Json -Compress -Depth 5"
    ).replace("PORTSX", ",".join(str(p) for p in PORTS.values())).replace("RELX", RELEASE["dir"]).replace("DECLX", DECL).replace("NODEX", NODE_EXE)
def challenge_read(m):   # two read-only calls (one text would exceed the transport margin), merged; an error in either is kept
    a, b = m.ps(CH, 90), m.ps(CH2, 120)
    if not isinstance(a, dict) or not isinstance(b, dict) or a.get("error") or b.get("error"): return {"error": f"{a.get('error') if isinstance(a, dict) else a} / {b.get('error') if isinstance(b, dict) else b}"}
    return {**a, **b}
VERIFY = U + r"$s=SX;$o=[ordered]@{};foreach($f in @(NAMESX)){$o[$f]=FileSha (Join-Path $s $f)};$o|ConvertTo-Json -Compress"

def load_transport():
    if sha(TRANSPORT[0]) != TRANSPORT[1]: raise SystemExit("transport is not c50aac8e")
    sp = importlib.util.spec_from_file_location("transport", TRANSPORT[0]); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m

def verify_local():
    bad = [k for k, (p, h) in STAGED.items() if sha(p) != h]
    if bad: raise SystemExit(f"local pins differ: {bad}")

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1)
    print("receipt:", OUT / name); return OUT / name

def attempt(name, body):
    try: save(name, {"what": "attempt", "at": now(), **body}); return True
    except FileExistsError: print(f"REFUSED: {OUT / name} exists; never retried automatically (root inspects, then moves it aside)"); return False

def fresh(path, what, limit):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != what: raise SystemExit(f"{path} is not a {what} receipt")
    if time.time() - calendar.timegm(time.strptime(o["at"], "%Y-%m-%dT%H:%M:%SZ")) > limit: raise SystemExit(f"{path} is older than {limit} s")
    return o

def control_gate(receipt, accept_check):
    """the control cutover must be root-verified first: DONE, or a DONE_CHECK root explicitly classified (--accept-control-check)"""
    if not receipt: return ["--control-receipt: the control cutover's result receipt is required (challenge activation follows a verified control cutover)"]
    r = json.loads(pathlib.Path(receipt).read_text()); fin = [json.loads(l)["final"] for l in r.get("journal", {}).get("lines", []) if '"final"' in l]
    f = fin[-1] if fin else ""
    if f.startswith("DONE:"): return []
    if f.startswith("DONE_CHECK:") and accept_check: return []
    return [f"the control cutover final is not DONE ({f[:80]!r}); root classifies it first (--accept-control-check only for a root-reviewed DONE_CHECK)"]

def refusals(pre):
    r, i, c = [], pre["identities"], pre["challenge"]
    for k, v in (("identities", i), ("challenge", c), ("update", pre.get("updateRead"))):
        if not isinstance(v, dict) or v.get("error"): r.append(f"{k} read failed: {v if not isinstance(v, dict) else v.get('error')}")
    if r: return r
    if len(i.get("cmd", [])) != 1 or len(i.get("agent", [])) != 1 or len(i.get("privacy", [])) != 1: r.append("not exactly one node cmd/agent and one privacy agent")
    r += R["gupd_refusals"]({**i, "update": pre["updateRead"].get("update"), "at": c.get("at")})
    if c.get("chainRpc") != RPC5: r.append("privacy-config chain.rpc is not the 5 (the control cutover is not in place)")
    keys = c.get("enKeys") or []
    if "walletAdmission" not in keys or keys[-1] != "walletAdmission": r.append("walletAdmission is not configured last (the control cutover is not in place)")
    if "challengeReplica" in keys: r.append("challengeReplica is already configured")
    if "hostServices" in keys: r.append("an enclaveNetwork.hostServices block exists: this recipe was prepared for none (root re-plans)")
    if c.get("hs2") != HS2_CONFIG: r.append("hs2 is not on the parallel-TXT config 5f75562c: root-hs2-parallel.py --execute first")
    if c.get("release") != {"dns": RELEASE["dnsSha256"], "runtime": RELEASE["runtimeBundleSha256"]}: r.append("the installed replica release is not the pinned bytes (prerequisite 31492)")
    if not c.get("declDir"): r.append("the declaration directory is missing (prerequisite 31492)")
    if isinstance(c.get("decl"), dict) and c["decl"].get("state") == "serving": r.append("a serving declaration already exists")
    for k in ("dns", "api", "front"):
        if c["ports"].get(str(PORTS[k])) != "absent": r.append(f"127.0.0.1:{PORTS[k]} ({k}) is in use: {c['ports'].get(str(PORTS[k]))}")
    t = c["ports"].get(str(PORTS["tunnel"]))
    if t != "absent" and not (isinstance(t, dict) and t.get("name") == "sshd.exe"): r.append(f"127.0.0.1:{PORTS['tunnel']} is owned by something other than sshd: {t} (route-dns would merge its TXT)")
    if c.get("policyUnavailable30min") != 0: r.append(f"P0 gate: {c.get('policyUnavailable30min')} chain-quorum/policy-unavailable lines in 30 min")
    if not (0 <= int(c.get("statusAgeMs", -1)) < 5000) or c.get("statusRunner") != RUNNER: r.append("the privacy status is not fresh or not enforcing this runner")
    mm = re.search(r"D:([A-Z]*)\(", str(c.get("cfgAcl") or ""))
    if not mm or "AI" not in mm.group(1): r.append("privacy-config.json DACL is not auto-inherited (the exact ACL round trip would refuse)")
    if c.get("nodeExe") != NODE_SHA: r.append("node.exe is not the root-proven binary")
    return r

def plan():
    return {"mode": "PLAN ONLY (no network call made)", "staged": {k: h for k, (_, h) in STAGED.items()}, "reusedDriver": REUSE[1], "transport": TRANSPORT[1],
            "hs2Config": HS2_CONFIG, "release": RELEASE, "declaration": DECL, "ports": PORTS, "order": "RECIPE.txt"}

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group()
    for f in ("--preflight-read", "--stage", "--apply", "--status"): x.add_argument(f, action="store_true")
    x.add_argument("--rollback", metavar="RUN_ID")
    a.add_argument("--preflight"); a.add_argument("--stage-receipt"); a.add_argument("--run-id"); a.add_argument("--control-receipt"); a.add_argument("--accept-control-check", action="store_true")
    a.add_argument("--tunnel-policy", choices=["absent-or-sshd", "sshd-required"], default="absent-or-sshd"); a.add_argument("--poll-sec", type=int, default=1200)
    o = a.parse_args(argv)
    verify_local(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not any([o.preflight_read, o.stage, o.apply, o.status, o.rollback]): print(json.dumps(plan(), indent=1)); return 0
    m = load_transport()
    if o.preflight_read:
        pre = {"identities": m.ps(R["IDN"], 120), "updateRead": m.ps(R["UPD"], 60), "challenge": challenge_read(m)}
        ref = refusals(pre) + control_gate(o.control_receipt, o.accept_control_check)
        save(f"preflight-{ts}-{uuid.uuid4().hex[:6]}.json", {"what": "preflight", "at": now(), **pre, "refusals": ref, "controlReceipt": o.control_receipt, "acceptControlCheck": o.accept_control_check})
        print(json.dumps({"refusals": ref}, indent=1)); return 0 if not ref else 2
    if o.stage:
        fresh(o.preflight, "preflight", FRESH_S); d = STAGING + "\\" + PREFIX + uuid.uuid4().hex[:12]
        if not attempt(f"attempt-stage-{ts}.json", {"stage": d}): return 4
        rec = {"what": "stage", "at": now(), "stage": d}
        rec["mkdir"] = m.ps(f"$d={q(d)};if(Test-Path -LiteralPath $d){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $d;@{{created=$d}}|ConvertTo-Json -Compress", 60)
        if rec["mkdir"].get("created") == d:
            for name, (p, _) in STAGED.items():
                c = subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", str(p), "minipc:/" + (d + "\\" + name).replace("\\", "/")], capture_output=True, text=True)
                if c.returncode: rec["uploadFailed"] = {"file": name, "stderr": c.stderr[-300:]}; break
            rec["verify"] = m.ps(VERIFY.replace("SX", q(d)).replace("NAMESX", ",".join(q(n) for n in STAGED)), 60)
        rec["ok"] = rec["mkdir"].get("created") == d and "uploadFailed" not in rec and all(rec.get("verify", {}).get(n) == h for n, (_, h) in STAGED.items())
        save(f"stage-{ts}-{uuid.uuid4().hex[:6]}.json", rec); print(json.dumps({k: rec[k] for k in ("stage", "ok")})); return 0 if rec["ok"] else 4
    st = fresh(o.stage_receipt, "stage", 7 * 86400)
    if not st.get("ok") or any(st["verify"].get(n) != h for n, (_, h) in STAGED.items()): raise SystemExit("--stage-receipt: a passing stage of THESE pinned files")
    stage = st["stage"]
    if o.status:
        print(json.dumps(m.ps(R["JOURNAL"].replace("JX", q(stage + f"\\challenge-{o.run_id}.jsonl")).replace("TNX", q("chal-act-" + o.run_id)), 60), indent=1)); return 0
    pre = fresh(o.preflight, "preflight", APPLY_FRESH_S); i, c = pre["identities"], pre["challenge"]
    if o.apply:
        ref = refusals(pre) + control_gate(pre.get("controlReceipt"), pre.get("acceptControlCheck"))
        if ref: print(json.dumps({"refused": ref}, indent=1)); return 2
        mode, run = "apply", ts.lower() + "-" + uuid.uuid4().hex[:6]
    else:
        run0 = o.rollback; rec = OUT / f"apply-result-{run0}.json"
        if not rec.exists(): raise SystemExit(f"{rec}: the apply's own result receipt (with its journal) is required")
        r0 = json.loads(rec.read_text()); lines = [json.loads(l) for l in r0["journal"]["lines"] if l.startswith("{")]
        bk = next((l for l in lines if l.get("step") == "backup"), None); cf = next((l for l in lines if l.get("step") == "config"), {})
        if not bk: raise SystemExit("the apply journal has no backup step: nothing to restore")
        if len(i.get("privacy", [])) != 1: raise SystemExit("not exactly one privacy agent")
        mode, run = "rollback", run0 + "-rb"
    params = {"stage": stage, "runId": run, "boundSec": BOUND_S, "runner": RUNNER, "nodeExe": NODE_EXE, "nodeSha": NODE_SHA,
              "cutoverSha": STAGED["node-hold-cutover.ps1"][1], "editSha": STAGED["edit-privacy-config.mjs"][1], "blockSha": STAGED["challengeReplica.json"][1],
              "cfgSha": c.get("cfg"), "enKeys": c.get("enKeys"), "privacy": i["privacy"][0],
              "node": {"cmdPid": i["cmd"][0]["pid"], "cmdStart": i["cmd"][0]["start"], "agentPid": i["agent"][0]["pid"], "agentStart": i["agent"][0]["start"]},
              "chainRpc": RPC5, "hs2ConfigSha": HS2_CONFIG, "release": RELEASE, "declarationFile": DECL, "ports": PORTS,
              "challengeWaitSec": CHALLENGE_WAIT_S, "tunnelPolicy": o.tunnel_policy}
    if mode == "rollback": params["before"] = {"cfg": {"before": r0["params"]["cfgSha"], "after": cf.get("after", ""), "backup": bk["backup"]}}
    OUT.mkdir(exist_ok=True); pf = OUT / f"params-{run}.json"; pf.write_text(json.dumps(params, indent=1)); psha = sha(pf)
    remote_p = stage + f"\\p-{run}.json"
    if not attempt(f"attempt-{mode}-{run}.json", {"params": params, "paramsSha": psha}): return 4
    cp = subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", str(pf), "minipc:/" + remote_p.replace("\\", "/")], capture_output=True, text=True)
    if cp.returncode: save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "error": "params upload failed"}); return 3
    ps1 = stage + "\\chact.ps1"; jx = stage + f"\\challenge-{run}.jsonl"; tn = "chal-act-" + run
    loader = R["LOADER"].replace("PS1X", ps1).replace("PSHA", STAGED["chact.ps1"][1]).replace("PFX", remote_p).replace("PFSHA", psha).replace("MODEX", mode)
    lr = m.ps(R["LAUNCH"].replace("TNX", q(tn)).replace("ENCX", base64.b64encode(loader.encode("utf-16-le")).decode()), 90)
    print(json.dumps({"launch": lr, "runId": run}, indent=1))
    if lr.get("decision") != "started": save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "launch": lr}); return 3
    end, j = time.time() + o.poll_sec, {}
    while time.time() < end:
        time.sleep(15); j = m.ps(R["JOURNAL"].replace("JX", q(jx)).replace("TNX", q(tn)), 60)
        if any('"final"' in l for l in j.get("lines", [])): break
    save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "runId": run, "params": params, "launch": lr, "journal": j})
    fin = [json.loads(l)["final"] for l in j.get("lines", []) if '"final"' in l]
    print(json.dumps({"final": fin}, indent=1))
    if not fin: print(f"NO FINAL YET: the task may still run; --status --run-id {run}; NEVER start another run meanwhile."); return 3
    return 0 if fin[-1].startswith("DONE:" if mode == "apply" else "ROLLED_BACK:") else 3

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
