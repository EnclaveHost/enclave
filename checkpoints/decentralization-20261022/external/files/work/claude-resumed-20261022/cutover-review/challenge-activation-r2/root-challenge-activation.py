#!/usr/bin/env python3
"""r2 (root review ROOT-INFLIGHT-REVIEW R1-R5). ROOT-ONLY driver for the PRIVACY half of the paired challenge activation on minipc (challenge-activate.ps1). PREPARED by Claude;
NEVER run by its author; no remote call was made with it. The hs2 half is the existing root-hs2-parallel.py (manifest 83e15e6d,
driver 1813a727, staged hs2up-txt-a2b349248b61) and runs FIRST; see RECIPE.txt for the whole bounded order and its rollback.
Reuse: the remote texts IDN / UPD / LOADER / LAUNCH / JOURNAL (and gupd_refusals) are parsed from the pinned rpc-integrated driver
1d1b995c (root-accepted, running in root-control-rpc-final) - never re-typed; transport c50aac8e.

  root-challenge-activation.py                                  PLAN only: pins + steps; no network
  root-challenge-activation.py --preflight-read --control-receipt C [--accept-control-check] --expected-receipt E
                               (--tunnel-verify-receipt V | --coverage-receipt K)      read-only -> runs/preflight-*.json
     E: a FRESH (<= 1800 s) root-node-hold preflight receipt: its coverage.expectedIds (non-empty, no blockers) are bound EXACTLY (R2)
     V: the reviewed tunnel kit's verify-<run> receipt with PASS (R5); the live listener is then proven here by path, owner, sshd service
        parent, managed Match block + keys restriction, loopback-only bind and the kit's own SOA probe; its PID+start are pinned
     K: a ROOT coverage receipt that permits an ABSENT 31053 (only when root proved the full required TXT-source coverage). Without V
        or K the tunnel is UNPROVEN and activation is withheld.
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
    "chact.ps1": (HERE / "challenge-activate.ps1", "f096aed4998c2e762f2c0a8e7919c4d9e97e7cce43e610ed0099b5e93dad39fc"),
}
RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"
RPC5 = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://base.drpc.org", "https://mainnet.base.org"]
NODE_EXE, NODE_SHA = r"C:\Program Files\nodejs\node.exe", "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
HS2_CONFIG = "5f75562c970c715e3be44d02992207001438b9ab0831687a90b3c2aebfcebf43"   # root-hs2-parallel.py's config (route-dns parallel TXT)
# R5: the reviewed tunnel kit (controller 3aaa0d0b): its own SOA probe text is reused verbatim (regex from the pinned file)
TUNNEL_KIT = (W / "host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install/tunnel_install.py", "3aaa0d0b9c75c7a5019cd631d17088481cbf5835ae524e6731e49f445a3a2f28")
SSHD_EXE = r"C:\Windows\System32\OpenSSH\sshd.exe"; TUNNEL_USER = "enc-ctl-tunnel"
KEYS_PREFIX = 'restrict,port-forwarding,permitlisten="127.0.0.1:31053",command="cmd.exe /c exit 1" '
FORWARD_S, RECOVERY_S = 330, 450            # challenge-activate.ps1's source-derived budget (it refuses below these)
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
def kit_soa():
    if sha(TUNNEL_KIT[0]) != TUNNEL_KIT[1]: raise SystemExit("the tunnel kit is not 3aaa0d0b")
    m = re.search(r'pos = ps\(r"""(.*?)""", secs=60\)', TUNNEL_KIT[0].read_text(), re.S)
    if not m: raise SystemExit("the kit's SOA probe text was not found"); return None
    return m.group(1)

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
# R2: the exact ids as the privacy agent and the node see them (deployment ids are public): routed (unexpired map), granted, running
CH3 = U + (r"$o=[ordered]@{};$pd='C:\ProgramData\Enclave\network\state';try{$e=[IO.File]::ReadAllText($pd+'\egress-routes.json')|ConvertFrom-Json;"
    r"$o.egressExpiresInMs=[int64]$e.expiresAt-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$o.egressIds=@($e.apps.PSObject.Properties|Where-Object{@($_.Value.proxies).Count -gt 0}|ForEach-Object{$_.Name.ToLower()})}catch{$o.egressIds=$null};"
    r"try{$s=[IO.File]::ReadAllText($pd+'\status.json')|ConvertFrom-Json;$o.allows=@($s.walletAdmission.allows|ForEach-Object{([string]$_).ToLower()})}catch{$o.allows=$null};"
    r"try{$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state';$o.running=@($h.deployments|Where-Object{[string]$_.status -eq 'running'}|ForEach-Object{([string]$_.id).ToLower()})}catch{$o.running=$null};"
    r"$o|ConvertTo-Json -Compress -Depth 4")
# R5: the listener's identity facts (read-only; no key material: the keys file is hashed and its lines counted/matched)
TUNNEL = U + (r"$o=[ordered]@{};$l=@(Get-NetTCPConnection -LocalPort 31053 -State Listen -ErrorAction SilentlyContinue);$o.listeners=@($l|ForEach-Object{[ordered]@{addr=[string]$_.LocalAddress;pid=[int]$_.OwningProcess}});"
    r"if($l.Count -eq 1){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$l[0].OwningProcess) -OperationTimeoutSec 20;$u=$null;try{$u=Invoke-CimMethod -InputObject $p -MethodName GetOwner}catch{};"
    r"$o.proc=[ordered]@{pid=[int]$p.ProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');path=[string]$p.ExecutablePath;parent=[int]$p.ParentProcessId;user=$(if($u){[string]$u.User}else{'unknown'})}};"
    r"$s=Get-CimInstance Win32_Service -Filter 'Name=''sshd''' -OperationTimeoutSec 20;$o.sshd=$(if($s){[ordered]@{state=[string]$s.State;pid=[int]$s.ProcessId}}else{'absent'});"
    r"$c='C:\ProgramData\ssh\sshd_config';$t=$(try{[IO.File]::ReadAllText($c)}catch{''});$o.config=[ordered]@{sha=FileSha $c;block=$t.Contains('# BEGIN UX (managed');match=([regex]::Matches($t,'(?m)^Match User UX\s*$')).Count;permitListen=([regex]::Matches($t,'(?m)^\s*PermitListen 127\.0\.0\.1:31053\s*$')).Count};"
    r"$k='C:\ProgramData\ssh\UX_authorized_keys';$o.keys=$(if(Test-Path -LiteralPath $k){$x=@([IO.File]::ReadAllLines($k)|Where-Object{$_.Trim()});[ordered]@{sha=FileSha $k;lines=$x.Count;restricted=@($x|Where-Object{$_.StartsWith('KPX')}).Count}}else{'absent'});"
    r"$a=Get-LocalUser -Name 'UX' -ErrorAction SilentlyContinue;$o.account=$(if($a){[ordered]@{enabled=[bool]$a.Enabled;admin=(@(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue|Where-Object{[string]$_.Name -like '*\UX'}).Count -gt 0)}}else{'absent'});"
    r"$o|ConvertTo-Json -Compress -Depth 4").replace("UX", TUNNEL_USER).replace("KPX", KEYS_PREFIX.replace("'", "''"))
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
    if c.get("policyUnavailable30min") != 0: r.append(f"P0 gate: {c.get('policyUnavailable30min')} chain-quorum/policy-unavailable lines in 30 min")
    if not (0 <= int(c.get("statusAgeMs", -1)) < 5000) or c.get("statusRunner") != RUNNER: r.append("the privacy status is not fresh or not enforcing this runner")
    mm = re.search(r"D:([A-Z]*)\(", str(c.get("cfgAcl") or ""))
    if not mm or "AI" not in mm.group(1): r.append("privacy-config.json DACL is not auto-inherited (the exact ACL round trip would refuse)")
    if c.get("nodeExe") != NODE_SHA: r.append("node.exe is not the root-proven binary")
    return r

def expected_ids(path):
    """R2: the exact expected ids from a FRESH root-node-hold preflight receipt (coverage.expectedIds, no blockers)"""
    if not path: return None, ["--expected-receipt: a fresh root-node-hold preflight receipt is required (the exact expected deployment ids)"]
    o = json.loads(pathlib.Path(path).read_text()); ids = [str(x).lower() for x in (o.get("coverage") or {}).get("expectedIds") or []]
    why = []
    if o.get("what") != "preflight": why.append("--expected-receipt is not a preflight receipt")
    try: age = time.time() - calendar.timegm(time.strptime(o["at"], "%Y-%m-%dT%H:%M:%SZ"))
    except Exception: age = None
    if age is None or age > FRESH_S: why.append(f"--expected-receipt is not fresh (<= {FRESH_S} s)")
    if (o.get("coverage") or {}).get("blockers"): why.append("--expected-receipt has coverage blockers")
    if not ids or len(set(ids)) != len(ids) or not all(re.fullmatch(r"0x[0-9a-f]{64}", i) for i in ids): why.append("--expected-receipt has no exact, unique expected ids (a vacuous core check)")
    return sorted(set(ids)), why

def ids_refusals(want, live):
    if not isinstance(live, dict) or live.get("error"): return [f"the exact-ids read failed: {live}"]
    r = []
    eg, al, run = live.get("egressIds"), live.get("allows"), live.get("running")
    if eg is None or al is None or run is None: return ["the egress map, the privacy status or the node host state is unreadable"]
    if sorted(set(eg)) != want: r.append(f"egress ids differ from the bound expected ids (missing {sorted(set(want) - set(eg))}, extra {sorted(set(eg) - set(want))})")
    if set(want) - set(al): r.append(f"expected ids not granted: {sorted(set(want) - set(al))}")
    if set(want) - set(run): r.append(f"expected ids not running on the node: {sorted(set(want) - set(run))}")
    if not isinstance(live.get("egressExpiresInMs"), int) or live["egressExpiresInMs"] <= 0: r.append("the egress map is expired")
    return r

def tunnel_gate(read, verify_receipt, coverage_receipt):
    """R5 -> (params.tunnel, refusals). PROVEN needs the kit's PASS verify receipt AND the live identity; absence needs ROOT coverage"""
    if not isinstance(read, dict) or read.get("error"): return None, [f"the tunnel identity read failed: {read}"]
    ls = read.get("listeners") or []
    if not ls:
        if not coverage_receipt: return None, ["127.0.0.1:31053 has no listener and no root coverage receipt permits that: the tunnel source is UNPROVEN; activation withheld (absence is never assumed to be covered)"]
        k = json.loads(pathlib.Path(coverage_receipt).read_text())
        if k.get("what") != "challenge-txt-coverage" or k.get("approvedBy") != "root" or "127.0.0.1:31053" in (k.get("requiredSources") or ["127.0.0.1:31053"]) or k.get("snpGap") != "acknowledged-unresolved":
            return None, ["the coverage receipt does not state a root-approved coverage without 31053 that keeps the SNP gap explicit"]
        return {"mode": "absent-permitted", "coverageSha": sha(coverage_receipt)}, []
    why, p, s, c, k, a = [], read.get("proc") or {}, read.get("sshd"), read.get("config") or {}, read.get("keys"), read.get("account")
    if not verify_receipt: why.append("no tunnel kit verify receipt: a listener on 127.0.0.1:31053 is UNPROVEN (a process name proves nothing)")
    else:
        v = json.loads(pathlib.Path(verify_receipt).read_text())
        if v.get("PASS") is not True or (v.get("negative") or {}).get("overall") != "PASS": why.append("the tunnel kit verify receipt did not PASS")
    if len(ls) != 1 or ls[0].get("addr") != "127.0.0.1": why.append(f"31053 must have exactly ONE listener bound to 127.0.0.1 only: {ls}")
    if str(p.get("path", "")).lower() != SSHD_EXE.lower(): why.append(f"the 31053 owner is not {SSHD_EXE}: {p.get('path')}")
    if p.get("user") != TUNNEL_USER: why.append(f"the 31053 owner does not run as {TUNNEL_USER}: {p.get('user')}")
    if not isinstance(s, dict) or s.get("state") != "Running" or p.get("parent") != s.get("pid"): why.append("the 31053 owner is not a session child of the running sshd service")
    if not (c.get("block") and c.get("match") == 1 and c.get("permitListen") == 1): why.append("sshd_config lacks exactly one managed enc-ctl-tunnel Match block with PermitListen 127.0.0.1:31053")
    if not isinstance(k, dict) or k.get("lines") != 1 or k.get("restricted") != 1: why.append("the enc-ctl-tunnel keys file is not exactly one restricted permitlisten line")
    if not isinstance(a, dict) or not a.get("enabled") or a.get("admin"): why.append("enc-ctl-tunnel is absent, disabled, or an administrator")
    soa = (read.get("soaProbe") or {}).get("soa") or {}
    if soa.get("rcode") != 0 or soa.get("aa") is not True: why.append("no authoritative SOA (rcode 0, aa) through 127.0.0.1:31053")
    if why: return None, why
    return {"mode": "proven", "pid": p["pid"], "start": p["start"], "verifySha": sha(verify_receipt), "configSha": c.get("sha"), "keysSha": k.get("sha")}, []

def plan():
    return {"mode": "PLAN ONLY (no network call made)", "staged": {k: h for k, (_, h) in STAGED.items()}, "reusedDriver": REUSE[1], "transport": TRANSPORT[1],
            "hs2Config": HS2_CONFIG, "release": RELEASE, "declaration": DECL, "ports": PORTS, "order": "RECIPE.txt"}

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group()
    for f in ("--preflight-read", "--stage", "--apply", "--status"): x.add_argument(f, action="store_true")
    x.add_argument("--rollback", metavar="RUN_ID")
    a.add_argument("--preflight"); a.add_argument("--stage-receipt"); a.add_argument("--run-id"); a.add_argument("--control-receipt"); a.add_argument("--accept-control-check", action="store_true")
    a.add_argument("--expected-receipt"); a.add_argument("--tunnel-verify-receipt"); a.add_argument("--coverage-receipt"); a.add_argument("--poll-sec", type=int, default=1200)
    o = a.parse_args(argv)
    verify_local(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not any([o.preflight_read, o.stage, o.apply, o.status, o.rollback]): print(json.dumps(plan(), indent=1)); return 0
    m = load_transport()
    if o.preflight_read:
        pre = {"identities": m.ps(R["IDN"], 120), "updateRead": m.ps(R["UPD"], 60), "challenge": challenge_read(m), "ids": m.ps(CH3, 90), "tunnelRead": m.ps(TUNNEL, 90)}
        if isinstance(pre["tunnelRead"], dict) and pre["tunnelRead"].get("listeners"): pre["tunnelRead"]["soaProbe"] = m.ps(kit_soa(), 60)   # the kit's own read-only probe
        want, ewhy = expected_ids(o.expected_receipt); tun, twhy = tunnel_gate(pre["tunnelRead"], o.tunnel_verify_receipt, o.coverage_receipt)
        pre.update({"expectedIds": want, "expectedReceipt": o.expected_receipt and {"path": o.expected_receipt, "sha": sha(o.expected_receipt)}, "tunnel": tun})
        ref = refusals(pre) + control_gate(o.control_receipt, o.accept_control_check) + ewhy + twhy + (ids_refusals(want, pre["ids"]) if want else [])
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
        ref = list(pre.get("refusals") or []) + refusals(pre) + control_gate(pre.get("controlReceipt"), pre.get("acceptControlCheck"))
        if not pre.get("expectedIds") or not pre.get("tunnel"): ref.append("the preflight bound no exact expected ids or no proven/permitted tunnel state")
        if ref: print(json.dumps({"refused": sorted(set(ref))}, indent=1)); return 2
        mode, run = "apply", ts.lower() + "-" + uuid.uuid4().hex[:6]
    else:
        run0 = o.rollback; rec = OUT / f"apply-result-{run0}.json"
        if not rec.exists(): raise SystemExit(f"{rec}: the apply's own result receipt (with its journal) is required")
        r0 = json.loads(rec.read_text()); lines = [json.loads(l) for l in r0["journal"]["lines"] if l.startswith("{")]
        bk = next((l for l in lines if l.get("step") == "backup"), None); cf = next((l for l in lines if l.get("step") == "config"), {})
        if not bk: raise SystemExit("the apply journal has no backup step: nothing to restore")
        if len(i.get("privacy", [])) != 1: raise SystemExit("not exactly one privacy agent")
        if not pre.get("expectedIds") or not pre.get("tunnel"): raise SystemExit("the preflight bound no exact expected ids or no proven/permitted tunnel state")
        mode, run = "rollback", run0 + "-rb"
    params = {"stage": stage, "runId": run, "boundSec": BOUND_S, "runner": RUNNER, "nodeExe": NODE_EXE, "nodeSha": NODE_SHA,
              "cutoverSha": STAGED["node-hold-cutover.ps1"][1], "editSha": STAGED["edit-privacy-config.mjs"][1], "blockSha": STAGED["challengeReplica.json"][1],
              "cfgSha": c.get("cfg"), "enKeys": c.get("enKeys"), "privacy": i["privacy"][0],
              "node": {"cmdPid": i["cmd"][0]["pid"], "cmdStart": i["cmd"][0]["start"], "agentPid": i["agent"][0]["pid"], "agentStart": i["agent"][0]["start"]},
              "chainRpc": RPC5, "hs2ConfigSha": HS2_CONFIG, "release": RELEASE, "declarationFile": DECL, "ports": PORTS,
              "challengeWaitSec": CHALLENGE_WAIT_S, "expectedIds": pre["expectedIds"], "forwardSec": FORWARD_S, "recoverySec": RECOVERY_S, "tunnel": pre["tunnel"]}
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
