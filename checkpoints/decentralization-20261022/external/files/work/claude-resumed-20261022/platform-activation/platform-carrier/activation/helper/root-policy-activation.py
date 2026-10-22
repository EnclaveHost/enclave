#!/usr/bin/env python3
"""ROOT-ONLY: activate the EXISTING platform host policy gate on nucbox-k11-4 (minipc) - the postflight A1 gap (ENCLAVE_PLATFORM_HOST_POLICY
unset in node-config.cmd / node-config.local.cmd / run-node.cmd; host.mjs:148 passes book:null, so unset = OFF). PREPARED by Claude
(platform-activation 20261022); NEVER run by its author; no remote call was ever made with it. It reuses, by IMPORT of the frozen
helper (work/root-control-rpc-final-20261022/control-package/helper/root-node-hold.py, sha pinned below), the transport pin c50aac8e
and its remote texts IDN / UPD / LOADER / LAUNCH / JOURNAL verbatim, and the postflight's native PARSE wrapper verbatim.

  root-policy-activation.py --stage                              NEW C:\\ProgramData\\Enclave\\staging\\policyact-<uuid12>: the coordinator
                                                                 + gate-proof.mjs (scp), sha-verified, then natively PARSED (never run)
  root-policy-activation.py --gate --stage-receipt S             READ-ONLY gate proof of the INSTALLED bundle for options P and R
                                                                 (parse-only call first; nothing persisted; public chain reads only)
  root-policy-activation.py --stage-receipt S                    READ-ONLY preflight -> runs/preflight-*.json + refusals per option
  root-policy-activation.py --activate --option R --stage-receipt S --preflight P --gate G      THE switch-on (one-shot SYSTEM task)
  root-policy-activation.py --status --stage-receipt S --run-id R                                read the remote journal (read-only)
  root-policy-activation.py --rollback RUN --stage-receipt S --preflight P                       exact restore of node-config.local.cmd
Every mutating call writes an attempt record (O_EXCL) BEFORE the remote call; an existing record refuses (never retried).
Never read: config values (only shas, counts of assignment NAMES, DACL flags), keys, logs (node.log pattern COUNTS only).
"""
import argparse, base64, calendar, gzip, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, uuid
HERE = pathlib.Path(__file__).resolve().parent; A = HERE.parent; OUT = A / "runs"
W = next(p for p in A.parents if (p / "nucbox-tls-20261021").is_dir())
FROZEN = W / "root-control-rpc-final-20261022/control-package"
OLDH = (FROZEN / "helper/root-node-hold.py", "1d1b995c134373c0d5e72a8a3ca83a5726595d3d7d1de0a8e4cfc08ca8f69f0a")
CUT = (FROZEN / "helper/runs/cutover-result-20261022t033638z-f12f68.json", None)      # the 03:36 cutover receipt (expected ids, journal shas)
COORD = HERE / "node-policy-activation.ps1"; GATEJS = A / "gate/gate-proof.mjs"; COMPOSE = HERE / "compose.json"
RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"; ENDPOINT = "https://api.enclave.host/t/nucbox-k11-4"
PD, PF = r"C:\ProgramData\Enclave", r"C:\Program Files\Enclave"
BUNDLE, BUNDLE_SHA = PF + r"\control\windows\node\host-admission.bundle.mjs", "40e8ba71d83c627e85af21d58b9ab0d8b3052504a0e7d9ee47b429948c40bd25"   # platform-carrier CANDIDATE (swap first)
NODE_EXE, NODE_SHA = r"C:\Program Files\nodejs\node.exe", "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
RUN_NODE_NOW = "0fdc3699228c9d7a4c2e971d05804b49f978a56a4c1d9f7a06f3546f3ced09fd"      # run-node.cmd after root's rpc-integrated cutover
LOCAL_NOW = "405db912b15c73e57334bef4ad2c1071695495010bb95e67c72f200c48e382f0"         # node-config.local.cmd after it (journal 'flag')
# platform-carrier: the launcher shas the activation expects; root may pin the shas AFTER its config-persistence migration
# (--expect-local / --expect-run-node, exact lowercase sha256): the activation then appends to, and rolls back to, those bytes
EXPECT = {"local": LOCAL_NOW, "runNode": RUN_NODE_NOW}
R5 = "https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org"
R4 = "https://base-rpc.publicnode.com,https://mainnet.base.org,https://base-rpc.polkachu.com,https://base.drpc.org"   # root native 04:35:38Z: ADMISSIBLE 3 of 4
OPTIONS = {"P": "", "R": R4, "PC": "", "RC": R4}
CARRIERS = '{"importDir":"C:/ProgramData/Enclave/node/policy-import"}'      # PC / RC: the operator-import carrier (platform-carrier)
CARRIER_OF = lambda k: CARRIERS if k in ("PC", "RC") else ""
# postflight F1: the 9 semantic files of the running control/network bundle (frozen bytes) + the gate's own bundle
F1 = {PF + r"\control\windows\node\agent.mjs": "76cac3559713313251a0c0ab618fc31980c750496b6d55d94969d30b32c083a1",
      PF + r"\control\windows\node\host.mjs": "9634cb40c60b74f92eff8497f687dcaa1ec04a33c21cbd22dc745d773b1da396",
      PF + r"\control\windows\node\network-enroll.mjs": "a9729786598107e69d24d5163ea8592d114f93a9b6693106a7fa3414c95430d6",
      BUNDLE: BUNDLE_SHA,
      PF + r"\control\network\wallet-admission.mjs": "0fa7678f7586388b4725f1432683fa4ab172fd1d57c163d9a63195fbb2f445ee",
      PF + r"\control\network\host-service-names.mjs": "a46123cbb70ab666f9dfb23b5b545fe76d87658c6bf82c7f7574579d0c65b32c",
      PF + r"\control\network\host-service-transport.mjs": "de5bb98a2e77ffd90ccf65211f564d9515f667b4cd6d17cbb3644fb2ca454e06",
      PF + r"\network\privacy-agent.mjs": "cfb69370a00dea147340c64bbd712f118eb8cb825237ac79b3b053b586350801",
      PF + r"\network\host-service-ingress.mjs": "c952dce4fe007c48c81e1726a743d850dc2f5231204d01466349bfa5ffcc62d3"}
# lease budget (node-policy-activation.ps1 pins: revert >= 340; forward = StopNode 135 + CAS 10 + readiness 150 + channel 30)
LEASE = {"revertSec": 340, "marginSec": 180, "forwardMinSec": 325, "startNodeSec": 150}; LEASE_NEED = 845
FRESH_S, ACT_FRESH_S, BOUND_S = 1800, 600, 1080
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
ID = re.compile(r"^0x[0-9a-f]{64}$"); GEN = re.compile(r"^[0-9a-f]{32}$"); ADMIN = ("S-1-5-18", "S-1-5-32-544")

def _old():
    if sha(OLDH[0]) != OLDH[1]: raise SystemExit("the frozen root-node-hold.py is not the pinned bytes")
    spec = importlib.util.spec_from_file_location("root_node_hold", OLDH[0]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
H = _old()                                  # its module-level code only reads local files (manifest), never remote
q, U, IDN, UPD, LOADER, LAUNCH, JOURNAL = H.q, H.U, H.IDN, H.UPD, H.LOADER, H.LAUNCH, H.JOURNAL
LIMIT = H.LIMIT
# postflight.py PARSE (verbatim copy; tools/test_runner.py compares it with the frozen postflight's)
PARSE = (r"$z=[Convert]::FromBase64String('B64X');$ms=New-Object IO.MemoryStream(,$z);$gz=New-Object IO.Compression.GZipStream($ms,[IO.Compression.CompressionMode]::Decompress);"
         r"$sr=New-Object IO.StreamReader($gz,[Text.Encoding]::UTF8);$t=$sr.ReadToEnd();$sr.Close();$tk=$null;$er=$null;$null=[Management.Automation.Language.Parser]::ParseInput($t,[ref]$tk,[ref]$er);"
         r"[ordered]@{what='parse';sha256=(-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t))|%{$_.ToString('x2')}));chars=$t.Length;"
         r"errors=@($er).Count;ids=@($er|Select-Object -First 3|%{[string]$_.ErrorId})}|ConvertTo-Json -Compress")
def parse_text(text): return PARSE.replace("B64X", base64.b64encode(gzip.compress(text.encode("utf-8"), mtime=0)).decode())
def parsed_ok(r, text): return isinstance(r, dict) and "error" not in r and r.get("what") == "parse" and r.get("errors") == 0 and r.get("sha256") == hashlib.sha256(text.encode("utf-8")).hexdigest()

# -------------------------------------------------------------------------------------------------- new remote texts (read-only)
# the gate proof: the STAGED gate-proof.mjs (sha) fed on stdin to the pinned node.exe, importing the INSTALLED bundle (sha), once per
# option, each child bounded (55 s, killed, exit confirmed). Output: the proof's own JSON line per option (ids/hosts/booleans/status)
GATE = U + (r"$o=[ordered]@{what='gate';at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')};$b='BUNDLEX';$n='NODEX';$js='JSX';$o.bundle=FileSha $b;$o.nodeExe=FileSha $n;$o.js=FileSha $js;"
    r"if($o.bundle -ne 'BSHA' -or $o.nodeExe -ne 'NSHA' -or $o.js -ne 'JSHA'){$o.verdict='REFUSED';$o.why='a pin differs';$o|ConvertTo-Json -Compress -Depth 8;return};"
    r"$src=[IO.File]::ReadAllText($js);$o.runs=@();foreach($opt in OPTSX){$si=New-Object Diagnostics.ProcessStartInfo;$si.FileName=$n;$si.Arguments='--input-type=module';"
    r"$si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardInput=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true;"
    r"foreach($k in @('GATE_BUNDLE',$b),@('GATE_HOST','RUNNERX'),@('GATE_ENDPOINT','EPX'),@('GATE_POLICY','production'),@('GATE_RPCS',$opt[1]),@('GATE_CARRIERS',$opt[2]),@('GATE_OPTION',$opt[0])){$si.EnvironmentVariables[$k[0]]=[string]$k[1]};"
    r"$p=[Diagnostics.Process]::Start($si);$so=$p.StandardOutput.ReadToEndAsync();$se=$p.StandardError.ReadToEndAsync();$p.StandardInput.Write($src);$p.StandardInput.Close();"
    r"$x=$p.WaitForExit(55000);if(-not $x){try{$p.Kill()}catch{};$x=$p.WaitForExit(3000)};$r=[ordered]@{option=$opt[0];exited=$x;code=$(if($x){$p.ExitCode}else{$null})};"
    r"if($x -and $so.Wait(3000)){$l=@(([string]$so.Result -split [char]10)|?{$_.Trim().StartsWith('{')}|Select-Object -Last 1);if($l.Count){$r.result=$l[0]|ConvertFrom-Json}};$p.Dispose();$o.runs+=$r};"
    r"$o|ConvertTo-Json -Compress -Depth 8")
def gate_opts(names=None):
    """(PowerShell prefix, OPTSX) - platform-carrier: the RPC list and the carrier JSON appear ONCE, each option references them:
    @(name, rpcs, carriers). names: the options to prove (default all; --gate proves the carrier pair, or one --option)"""
    ref = lambda v: "$R4" if v == R4 else "''"
    return (f"$R4={q(R4)};$C={q(CARRIERS)};",
            "@(" + ",".join(f"@('{k}',{ref(v)},{'$C' if CARRIER_OF(k) else chr(39) * 2})" for k, v in OPTIONS.items() if names is None or k in names) + ")")
def gate_text(js_remote, names=("RC",)):
    pre, opts = gate_opts(names)
    return pre + (GATE.replace("BUNDLEX", BUNDLE).replace("NODEX", NODE_EXE).replace("JSX", js_remote).replace("BSHA", BUNDLE_SHA).replace("NSHA", NODE_SHA)
            .replace("JSHA", sha(GATEJS)).replace("OPTSX", opts).replace("RUNNERX", RUNNER).replace("EPX", ENDPOINT))
# configs: shas, COUNTS of policy assignments and hold flags, DACL flags; the gate's persisted state; the pinned binaries
POL = U + (r"$o=[ordered]@{at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')};$pd='PDX';$rx='(?im)^\s*set\s+\x22?ENCLAVE_PLATFORM_HOST_POLICY';$hx='(?m)^set ENCLAVE_NETWORK_WALLET_HOLD=1\r?$';"
    r"foreach($f in 'node-config.cmd','node-config.local.cmd','run-node.cmd'){$p=$pd+'\'+$f;$t=$(try{[IO.File]::ReadAllText($p)}catch{$null});"
    r"$o[$f]=[ordered]@{sha=FileSha $p;policy=$(if($null -eq $t){-1}else{[regex]::Matches($t,$rx).Count});hold=$(if($null -eq $t){-1}else{[regex]::Matches($t,$hx).Count});dacl=[regex]::Match([string](Get-Acl -LiteralPath $p).Sddl,'D:([A-Z]*)\(').Groups[1].Value}};"
    r"$o.cfg=FileSha ($pd+'\network\privacy-config.json');$o.nodeExe=FileSha 'NODEX';$a=$pd+'\node\platform-host-admission.json';"
    r"$o.persisted=$(if(Test-Path -LiteralPath $a){try{$j=[IO.File]::ReadAllText($a)|ConvertFrom-Json;[ordered]@{present=$true;hostIdOk=([string]$j.hostId -ceq 'RUNNERX');refusal=$(if($null -ne $j.knownRefusal){[string]$j.knownRefusal.status}else{$null})}}catch{[ordered]@{present=$true;unreadable=$true}}}else{[ordered]@{present=$false}});"
    r"$o.policyStore=Test-Path -LiteralPath ($pd+'\node\platform-host-policy.json');"
    r"$o.pdInheritReaders=@((Get-Acl -LiteralPath $pd).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|?{$_.AccessControlType -eq 'Allow' -and ([string]$_.InheritanceFlags -match 'ObjectInherit') -and ((([int]$_.FileSystemRights -band 0x10000001) -ne 0) -or ([int]$_.FileSystemRights -lt 0))}|%{$_.IdentityReference.Value}|Sort-Object -Unique);"
    r"$o|ConvertTo-Json -Compress -Depth 5").replace("PDX", PD).replace("NODEX", NODE_EXE).replace("RUNNERX", RUNNER)
# the enforced wallet channel: document generation/runner/expiry/allow ids, the network status's view, routes, channel-file writers
CHAN = U + (r"$pd='PDX';$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$o=[ordered]@{};$wf=$pd+'\network\wallet-admission.json';"
    r"$d=$(try{[IO.File]::ReadAllText($wf)|ConvertFrom-Json}catch{$null});$o.doc=$(if($d){[ordered]@{generation=[string]$d.generation;runnerOk=([string]$d.runner -ceq 'RUNNERX');expiresInMs=[int64]$d.expiresAt-$now;allows=@($d.allows.PSObject.Properties.Name)}}else{$null});"
    r"$s=$(try{[IO.File]::ReadAllText($pd+'\network\state\status.json')|ConvertFrom-Json}catch{$null});$w=$s.walletAdmission;"
    r"$o.status=$(if($s){[ordered]@{ageMs=$now-[int64]$s.updatedAt;generation=[string]$w.generation;runnerOk=([string]$w.runner -ceq 'RUNNERX');fresh=($w.fresh -eq $true);applied=($w.applied -eq $true);errorNull=($null -eq $w.error);allows=@($w.allows)}}else{$null});"
    r"$o.egress=$(try{@(([IO.File]::ReadAllText($pd+'\network\state\egress-routes.json')|ConvertFrom-Json).apps.PSObject.Properties.Name)}catch{@()});"
    r"$wa=$(try{Get-Acl -LiteralPath $wf}catch{$null});$o.walletWriters=$(if($wa){@($wa.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|?{$_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x116)}|%{$_.IdentityReference.Value}|Sort-Object -Unique)}else{@('unreadable')});"
    r"$o.walletOwner=$(if($wa){$wa.GetOwner([Security.Principal.SecurityIdentifier]).Value}else{$null});"
    r"try{$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state';$o.records=@($h.deployments|%{[ordered]@{id=[string]$_.id;status=[string]$_.status;walletHeld=($_.walletHeld -eq $true);leaseUntil=$_.leaseUntil}})}catch{$o.records=$null};"
    r"$o|ConvertTo-Json -Compress -Depth 5").replace("PDX", PD).replace("RUNNERX", RUNNER)
FILESHA = U + r"$o=[ordered]@{};foreach($x in @(PATHSX)){$o[$x]=FileSha $x};$o|ConvertTo-Json -Compress"
# node.log pattern COUNTS after an offset (postflight LOGS CountIn, keyed by NAME so no two patterns share a case-insensitive key)
POSTLOG = U + (r"$p='PDX\logs\node.log';$off=OFFX;$pats=[ordered]@{admitted='[host-policy] this host is ADMITTED';notServing='[host-policy] this host is not serving';"
    r"notServingChange='this host is NOT serving:';channelOff='wallet hold channel OFF';channelNotWritten='wallet hold channel NOT written';channelStarted='written EMPTY';spawned='isolation spawned';retired='isolated domain retired'};"
    r"$r=[ordered]@{};try{$fs=[IO.File]::Open($p,'Open','Read','ReadWrite,Delete');try{$r.length=$fs.Length;if($fs.Length -lt $off){$r.rotated=$true}else{[void]$fs.Seek($off,'Begin');$t=(New-Object IO.StreamReader($fs)).ReadToEnd()}}finally{$fs.Close()};"
    r"if(-not $r.rotated){foreach($k in $pats.Keys){$r[$k]=([regex]::Matches($t,[regex]::Escape($pats[$k]))).Count}}}catch{$r.error='unreadable'};$r|ConvertTo-Json -Compress").replace("PDX", PD)
# platform-carrier NATIVE cmd.exe FIXTURE: the exact carrier line in a throwaway batch file inside THIS run's staging dir, called by
# cmd.exe exactly as node-config.cmd calls node-config.local.cmd; prints only the variable cmd set (a public path setting), then deletes it
CMDFIX = U + (r"$d=STAGEX+'\cmdfix-'+[guid]::NewGuid().ToString('N').Substring(0,8);$null=New-Item -ItemType Directory -Path $d;$o=[ordered]@{what='cmdfix'};"
    r"try{$nl=[string][char]13+[char]10;[IO.File]::WriteAllText($d+'\local.cmd','@echo off'+$nl+'LINEX'+$nl,[Text.Encoding]::ASCII);"
    r"[IO.File]::WriteAllText($d+'\run.cmd','@echo off'+$nl+'call '+$d+'\local.cmd'+$nl+'set ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS'+$nl,[Text.Encoding]::ASCII);"
    r"$o.out=@(& cmd.exe /d /c ($d+'\run.cmd'));$o.exit=$LASTEXITCODE}finally{Remove-Item -LiteralPath $d -Recurse -Force;$o.cleaned=-not(Test-Path -LiteralPath $d)};$o|ConvertTo-Json -Compress")
def cmdfix_text(stage): return CMDFIX.replace("STAGEX", q(stage)).replace("LINEX", 'set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=' + CARRIERS + '"')
PARSEFILE = U + r"$p='PX';$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e);[ordered]@{what='parsefile';sha=FileSha $p;errors=@($e).Count;ids=@($e|Select-Object -First 3|%{[string]$_.ErrorId})}|ConvertTo-Json -Compress"

def enc_len(m, text, secs): return len(base64.b64encode((m.HEAD.replace("SECS", str(secs)) + text).encode("utf-16-le")))
def transport():
    H.verify_local(); return H.m        # pins the transport (c50aac8e) and loads it ONCE
def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", OUT / name); return OUT / name
def attempt(name, body):
    try: save(name, {"what": "attempt", "at": now(), **body}); return True
    except FileExistsError: print(f"REFUSED: {OUT / name} exists; an attempt is never retried automatically (root inspects, then moves it aside)"); return False
def fresh(path, what, limit):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != what: raise SystemExit(f"{path} is not a {what} receipt")
    if time.time() - calendar.timegm(time.strptime(o["at"], "%Y-%m-%dT%H:%M:%SZ")) > limit: raise SystemExit(f"{path} is older than {limit} s")
    return o
def cutover_receipt():
    r = json.loads(CUT[0].read_text()); lines = [json.loads(l) for l in r["journal"]["lines"]]
    return r, {l.get("step"): l for l in lines}
def expected_ids(): return sorted(cutover_receipt()[0]["params"]["expectedIds"])
def iso_epoch(s): return calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S"))

# platform-carrier D1: the host-admission bundle CAS swap through the FROZEN helper's pinned bundle-swap.ps1 (21d85c69: inspect / apply
# with private backup + node --check on the exact bytes + journal / rollback by CAS). Inert for the running agent (module loaded at start).
LIVE_BUNDLE_SHA = "6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18"     # installed now (root postflight F1)
CAND_FILE, CAND_NAME = A.parent / "out/candidate.host-admission.bundle.mjs", "host-admission.bundle.candidate.mjs"
SWAP = H.SCRIPTS["bundle-swap.ps1"]                                                  # (path, 21d85c69...) pinned by the frozen helper
def swap_params(stage, mode):
    p = {"Mode": mode, "Target": BUNDLE, "WorkDir": stage + "\\swap-host-admission", "OldSha": LIVE_BUNDLE_SHA}
    p.update({"ExpectCurrent": BUNDLE_SHA} if mode == "rollback" else {"NewFile": stage + "\\" + CAND_NAME, "NewSha": BUNDLE_SHA})
    return p
SWAP_OK = {"inspect": lambda d: d == "would apply", "apply": lambda d: d.startswith("applied") or d.startswith("noop"), "rollback": lambda d: d == "rolled back"}
# platform-carrier persistence check (READ-ONLY): the variable NAMES (never values) each launcher file assigns, in order, so root can
# move the hand-edited run-node.cmd settings into node-config.local.cmd before any installer regeneration (update-host.ps1 ->
# install-host.ps1 rewrites run-node.cmd and node-config.cmd; node-config.local.cmd is never written)
NAMES = U + (r"$pd='PDX';$o=[ordered]@{what='names'};foreach($f in 'run-node.cmd','node-config.cmd','node-config.local.cmd'){$p=$pd+'\'+$f;"
    r"$o[$f]=$(try{[ordered]@{sha=FileSha $p;names=@([regex]::Matches([IO.File]::ReadAllText($p),'(?im)^\s*set\s+\x22?([A-Za-z0-9_]+)=')|%{$_.Groups[1].Value});"
    r"calls=@([regex]::Matches([IO.File]::ReadAllText($p),'(?im)^\s*call\s+\x22?[^\x22\r\n]*\\([A-Za-z0-9_.-]+\.cmd)')|%{$_.Groups[1].Value})}}catch{'unreadable'})};$o|ConvertTo-Json -Compress -Depth 4").replace("PDX", PD)
def names_report(r):
    """names only in run-node.cmd (lost on regeneration unless moved) and the last writer of each name in launch order"""
    if not isinstance(r, dict) or "error" in r: return {"error": "unreadable"}
    rn, nc, lo = ((r.get(f) or {}).get("names") or [] for f in ("run-node.cmd", "node-config.cmd", "node-config.local.cmd"))
    return {"onlyInRunNode": sorted(set(rn) - set(nc) - set(lo)), "inRunNodeAndLocal": sorted(set(rn) & set(lo)), "local": sorted(set(lo)),
            "platformPolicyNames": sorted(n for n in set(rn) | set(nc) | set(lo) if n.startswith("ENCLAVE_PLATFORM_HOST_POLICY"))}
def check_local():
    c = json.loads(COMPOSE.read_text())
    bad = [n for n, ok in (("coordinator", sha(COORD) == c["output"]["sha256"]), ("gate-proof", sha(GATEJS) == c["gateProof"])) if not ok]
    if bad: raise SystemExit(f"local pins differ from compose.json: {bad} (re-run helper/compose.py and the suite)")
    _, steps = cutover_receipt()
    if steps.get("flag", {}).get("after") != LOCAL_NOW or steps.get("run-node", {}).get("after") != RUN_NODE_NOW: raise SystemExit("the cutover receipt is not the 03:36 run these pins come from")

def preflight(m):
    t_local = time.time(); pre = {"identities": m.ps(IDN, 120), "configs": m.ps(POL, 90), "channel": m.ps(CHAN, 90), "update": m.ps(UPD, 60)}
    pre["files"] = m.ps(FILESHA.replace("PATHSX", ",".join(q(p) for p in F1)), 90)
    pre["localAt"] = t_local; pre["errors"] = {k: v.get("error") for k, v in pre.items() if isinstance(v, dict) and v.get("error")}
    return pre

def gupd_refusals(u, at):
    """root-node-hold.py gupd_refusals (verbatim decision rules) with THIS run's window: preflight validity + BOUND_S + 60 s"""
    if not isinstance(u, dict): return [f"the \\Enclave\\Update task is absent or unreadable ({u!r}): refused (G-UPD)"]
    st, en, nxt = u.get("state"), u.get("enabled"), u.get("next")
    if st in ("Running", "Queued"): return [f"the \\Enclave\\Update task runs or is due inside the window ({u}) (G-UPD)"]
    if not isinstance(en, bool): return [f"the \\Enclave\\Update task Enabled flag is not a boolean ({u}) (G-UPD)"]
    if st == "Disabled": return [] if en is False and not nxt else [f"the \\Enclave\\Update task is Disabled but enabled or with a next run ({u}) (G-UPD)"]
    if st != "Ready" or en is not True: return [f"the \\Enclave\\Update task state is not accepted ({u}) (G-UPD)"]
    if not nxt: return [f"the \\Enclave\\Update task has no known next run ({u}) (G-UPD)"]
    try: due = iso_epoch(nxt)
    except Exception: return [f"the \\Enclave\\Update next run time is unreadable ({nxt!r}) (G-UPD)"]
    return [f"the \\Enclave\\Update task is due inside the window ({u}): wait until after its run (G-UPD)"] if due < at + ACT_FRESH_S + BOUND_S + 60 else []

def refusals(pre, mode="activate", gate=None, option=None):
    r, i, c, ch = [], pre["identities"], pre["configs"], pre["channel"]
    if pre["errors"]: r.append(f"preflight errors {pre['errors']}")
    if len(i.get("cmd", [])) != 1 or len(i.get("agent", [])) != 1 or len(i.get("privacy", [])) != 1 or not i.get("manager"): r.append("identities are not exactly one node cmd/agent, one privacy agent, one manager")
    if i.get("vms") in (None, "", "unavailable") or i.get("hyperv") in (None, "", "unavailable"): r.append("the manager's or Hyper-V's VM list is unavailable (never compared as unchanged)")
    bad = [p for p, h in F1.items() if (pre.get("files") or {}).get(p) != h]
    if bad: r.append(f"files not the frozen bytes: {bad}")
    if c.get("nodeExe") != NODE_SHA: r.append(f"{NODE_EXE} is not the root-proven node.exe")
    exp = expected_ids(); vmids = sorted(v.split("|")[1] for v in str(i.get("vms", "")).split(",") if "|" in v and ID.match(v.split("|")[1]))
    if vmids != exp: r.append(f"the VM-backed deployment set is not the cutover's 9 expected ids (now {len(vmids)}): root re-derives coverage")
    recs = {x["id"]: x for x in (ch.get("records") or [])}
    if any(recs.get(e, {}).get("status") != "running" or recs.get(e, {}).get("walletHeld") for e in exp): r.append("an expected id is not a running, non-held node record")
    if mode == "activate":
        for f in ("node-config.cmd", "node-config.local.cmd", "run-node.cmd"):
            if (c.get(f) or {}).get("policy") != 0: r.append(f"{f} already assigns ENCLAVE_PLATFORM_HOST_POLICY* ({(c.get(f) or {}).get('policy')}) or is unreadable: root decides")
        if (c.get("run-node.cmd") or {}).get("sha") != EXPECT["runNode"]: r.append(f"run-node.cmd is not the expected {EXPECT['runNode'][:8]} (cutover 0fdc3699 unless root pinned --expect-run-node)")
        if (c.get("node-config.local.cmd") or {}).get("sha") != EXPECT["local"]: r.append(f"node-config.local.cmd is not the expected {EXPECT['local'][:8]} (cutover 405db912 unless root pinned --expect-local): root decides")
        if "AI" not in str((c.get("node-config.local.cmd") or {}).get("dacl")): r.append("node-config.local.cmd has a DACL that is not auto-inherited")
    if (c.get("node-config.local.cmd") or {}).get("hold") != 1: r.append("node-config.local.cmd does not carry exactly one wallet hold flag")
    p = c.get("persisted") or {}
    if p.get("present") and not (p.get("hostIdOk") and p.get("refusal") is None and not p.get("unreadable")): r.append(f"the node's gate state holds a platform refusal or another host's state ({p}): {'no OFF rollback (admin decision)' if mode == 'rollback' else 'root decides'}")
    if [x for x in (c.get("pdInheritReaders") if c.get("pdInheritReaders") is not None else ["unknown"]) if x not in ADMIN]: r.append("new files in C:\\ProgramData\\Enclave inherit READ for more than SYSTEM/Administrators (N3)")
    d, s = ch.get("doc") or {}, ch.get("status") or {}
    if not (GEN.match(str(d.get("generation"))) and d.get("runnerOk") and 0 < int(d.get("expiresInMs") or 0) <= 31000): r.append("the wallet channel document is not THIS runner's fresh generation")
    if not (0 <= int(s.get("ageMs", -1)) < 5000 and s.get("generation") == d.get("generation") and s.get("runnerOk") and s.get("fresh") and s.get("applied") and s.get("errorNull")): r.append("the network does not apply the node's current channel (fresh status, same generation, applied, no error)")
    if [e for e in exp if e not in (s.get("allows") or []) or e not in (ch.get("egress") or [])]: r.append("an expected id is not allowed by the channel or has no egress route")
    if [w for w in (ch.get("walletWriters") or ["unknown"]) if w not in ADMIN] or ch.get("walletOwner") not in ADMIN: r.append("the wallet channel file is writable by more than SYSTEM/Administrators")
    try: at = iso_epoch(c.get("at"))
    except Exception: at = None
    u = (pre.get("update") or {}).get("update", "unreadable")
    r.extend(gupd_refusals(u, at) if at else ["the preflight's remote clock is unreadable (G-UPD)"])
    if mode == "activate":
        ends = [recs.get(e, {}).get("leaseUntil") for e in exp]
        if not ends or not all(isinstance(e, (int, float)) and not isinstance(e, bool) for e in ends) or at is None: r.append("lease window unknown")
        else:
            est = min(ends) - (at + (time.time() - pre["localAt"]))
            if est < LEASE_NEED: r.append(f"lease window: the first lease ends in ~{int(est)} s, the activation needs >= {LEASE_NEED} s (revert {LEASE['revertSec']} + margin {LEASE['marginSec']} + forward {LEASE['forwardMinSec']}): preflight again right after the next renewals")
        if gate is not None:
            run = next((x for x in gate.get("runs") or [] if x.get("option") == option), {})
            res = run.get("result") or {}
            if gate.get("bundle") != BUNDLE_SHA or gate.get("nodeExe") != NODE_SHA or gate.get("js") != sha(GATEJS): r.append("the gate receipt was not made with the pinned bundle / node.exe / gate-proof.mjs")
            if res.get("verdict") != "ADMISSIBLE": r.append(f"the gate proof for option {option} is not ADMISSIBLE ({res.get('verdict')}: {res.get('why')}): never activate on an unproven gate")
    return r

def post_verdict(r0, step, post):
    """A1 for THIS activation, read later (>= agent start + 420 s): the gate ON (the policy lines in node-config.local.cmd, nothing else
    assigns it), ADMITTED by the new process, never not-serving since the run's offset, no persisted refusal; the wallet hold still
    enforced for every expected id. Missing evidence is UNKNOWN, never PASS."""
    c, ch, lg, exp = post["configs"], post["channel"], post["log"], r0["params"]["expectedIds"]
    want = {"P": 1, "R": 2, "PC": 2, "RC": 3}[r0["params"]["option"]]; why = []
    if any(isinstance(x, dict) and x.get("error") for x in (c, ch, lg)) or lg.get("rotated"): return {"verdict": "UNKNOWN", "why": ["a read failed or node.log rotated"]}
    if (c.get("node-config.local.cmd") or {}).get("policy") != want or (c.get("node-config.cmd") or {}).get("policy") != 0 or (c.get("run-node.cmd") or {}).get("policy") != 0: why.append("policy assignments are not exactly the activation's lines")
    if (c.get("node-config.local.cmd") or {}).get("sha") != step["policy"]["after"]: why.append("node-config.local.cmd changed since the activation")
    p = c.get("persisted") or {}
    if p.get("present") and not (p.get("hostIdOk") and p.get("refusal") is None): why.append(f"a platform refusal is persisted ({p})")
    if not lg.get("admitted"): why.append("no '[host-policy] this host is ADMITTED' since the run's offset")
    if lg.get("notServing") or lg.get("notServingChange"): why.append(f"the gate reported not serving {lg.get('notServing')}/{lg.get('notServingChange')} time(s) since the run")
    if lg.get("channelOff") or lg.get("channelNotWritten"): why.append("the wallet hold channel went OFF / was not written")
    s, d = ch.get("status") or {}, ch.get("doc") or {}
    if not (s.get("fresh") and s.get("applied") and s.get("generation") == d.get("generation") and d.get("runnerOk")): why.append("the network does not apply the node's channel now")
    if [e for e in exp if e not in (s.get("allows") or []) or e not in (ch.get("egress") or [])]: why.append("an expected id is not allowed/routed now")
    recs = {x["id"]: x for x in (ch.get("records") or [])}
    if [e for e in exp if recs.get(e, {}).get("status") != "running" or recs.get(e, {}).get("walletHeld")]: why.append("an expected id is not a running, non-held record")
    if d.get("generation") != step["start-node"]["channelGeneration"]: why.append("the channel generation changed since the activation (a node restart happened): root reads node.log")
    return {"verdict": "FAIL" if why else "PASS", "why": why, "log": lg}

def classify(final):
    f = str(final)
    if f.startswith("DONE:"): return "done"
    if f.startswith("REFUSED_BY_POLICY"): return "policy-refused"
    if f.startswith("RECOVERY_REQUIRED"): return "recovery"
    if f.startswith("REFUSED"): return "refused"
    if re.match(r"^[A-Z0-9_]+_CHECK:", f) or f.startswith("DONE_PARTIAL:"): return "check"
    if re.match(r"^(ROLLED_BACK(_[A-Z0-9_]+)?|CRASHED_RESTORED):", f): return "rolled-back"
    return "unknown"
OUTCOME = {"recovery": "RECOVERY_REQUIRED: the run STOPPED at a refusal; journal fields recovery/nodeStopped/localSha/taskCommand say exactly what. Nothing automatic follows: RECIPE.txt RECOVERY.",
           "policy-refused": "REFUSED_BY_POLICY: the admin's platform policy explicitly refuses this host; the gate is ON (policy line kept) and the node runs fail-closed. NO rollback (it would bypass the admin decision); root/admin decide.",
           "rolled-back": "ROLLED_BACK: node-config.local.cmd is the exact before-bytes again (gate OFF as before), the node answered and runs a new channel generation.",
           "check": "CHECK: the path completed but a post-check failed or grants are missing (see post/fields); NOT verified; root decides, nothing automatic.",
           "refused": "REFUSED: the script refused before changing anything (see its reasons).", "unknown": "UNKNOWN FINAL: root reads the journal."}

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group()
    x.add_argument("--stage", action="store_true"); x.add_argument("--gate", action="store_true"); x.add_argument("--activate", action="store_true")
    x.add_argument("--status", action="store_true"); x.add_argument("--rollback", metavar="RUN_ID"); x.add_argument("--post", metavar="RUN_ID"); x.add_argument("--cmd-fixture", action="store_true"); x.add_argument("--swap-inspect", action="store_true"); x.add_argument("--swap-bundle", action="store_true"); x.add_argument("--swap-back", action="store_true"); x.add_argument("--names", action="store_true")
    a.add_argument("--stage-receipt"); a.add_argument("--preflight"); a.add_argument("--gate-receipt"); a.add_argument("--option", choices=list(OPTIONS)); a.add_argument("--run-id"); a.add_argument("--expect-local"); a.add_argument("--expect-run-node")
    a.add_argument("--poll-sec", type=int, default=1500)
    o = a.parse_args(argv)
    for k, v in (("local", o.expect_local), ("runNode", o.expect_run_node)):
        if v is not None:
            if not re.fullmatch(r"[0-9a-f]{64}", v): raise SystemExit(f"--expect-{k}: an exact lowercase sha256")
            EXPECT[k] = v
    check_local(); m = transport(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if o.stage:
        d = PD + r"\staging\policyact-" + uuid.uuid4().hex[:12]; rec = {"what": "stage", "at": now(), "stage": d}
        rec["mkdir"] = m.ps(f"$d={q(d)};if(Test-Path -LiteralPath $d){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $d;@{{created=$d}}|ConvertTo-Json -Compress", 60)
        if rec["mkdir"].get("created") != d: save(f"stage-{ts}.json", rec); raise SystemExit(f"stage not created: {rec['mkdir']}")
        for src, n in ((COORD, "node-policy-activation.ps1"), (GATEJS, "gate-proof.mjs"), (SWAP[0], "bundle-swap.ps1"), (CAND_FILE, CAND_NAME)):
            c = subprocess.run(["timeout", "300", "scp", "-q", "-o", "BatchMode=yes", str(src), "minipc:/" + (d + "\\" + n).replace("\\", "/")], capture_output=True, text=True)
            if c.returncode: rec["uploadFailed"] = {"file": n, "stderr": c.stderr[-300:]}; break
        want = {d + "\\node-policy-activation.ps1": sha(COORD), d + "\\gate-proof.mjs": sha(GATEJS), d + "\\bundle-swap.ps1": SWAP[1], d + "\\" + CAND_NAME: BUNDLE_SHA}
        rec["verify"] = m.ps(FILESHA.replace("PATHSX", ",".join(q(p) for p in want)), 60)
        rec["parse"] = m.ps(PARSEFILE.replace("PX", d + "\\node-policy-activation.ps1"), 90)        # Windows PowerShell 5.1's own parser; never run
        rec["ok"] = ("uploadFailed" not in rec and all(rec["verify"].get(p) == h for p, h in want.items()) and rec["parse"].get("errors") == 0
                     and rec["parse"].get("sha") == sha(COORD))
        save(f"stage-{ts}.json", rec); print(json.dumps({k: rec.get(k) for k in ("stage", "ok", "parse")}, indent=1)); return 0 if rec["ok"] else 4
    st = fresh(o.stage_receipt, "stage", 7 * 86400) if o.stage_receipt else None
    if not st or not st.get("ok"): raise SystemExit("--stage-receipt: a passing stage receipt (--stage)")
    stage = st["stage"]
    if o.gate:
        text, secs = gate_text(stage + "\\gate-proof.mjs", (o.option,) if o.option else ("RC",)), 150   # platform-carrier: RC (or one --option)
        pt = parse_text(text)
        for t in (text, pt):
            if enc_len(m, t, secs) > LIMIT: raise SystemExit("gate/parse text too long")
        pr = m.ps(pt, 60)
        if not parsed_ok(pr, text): save(f"gate-parse-refused-{ts}.json", {"what": "gate", "at": now(), "parse": pr}); print("REFUSED: the host's PowerShell did not parse the exact gate text cleanly; NOT executed"); return 3
        r = m.ps(text, secs); rec = save(f"gate-{ts}.json", {**r, "what": "gate", "at": now(), "parse": pr, "jsSha": sha(GATEJS)})
        print(json.dumps({x.get("option"): (x.get("result") or {}).get("verdict") for x in r.get("runs") or []} | {"receipt": str(rec)}, indent=1))
        return 0 if any((x.get("result") or {}).get("verdict") == "ADMISSIBLE" for x in r.get("runs") or []) else 3
    if o.names:     # platform-carrier: read-only names inventory (no values)
        r = m.ps(NAMES, 60); rep = names_report(r); save(f"names-{ts}.json", {"what": "names", "at": now(), "result": r, "report": rep})
        print(json.dumps(rep, indent=1)); return 0 if "error" not in rep else 3
    if o.swap_inspect or o.swap_bundle or o.swap_back:     # platform-carrier D1 (root only; inspect is read-only apart from its private dir)
        v = st.get("verify") or {}
        if v.get(stage + "\\bundle-swap.ps1") != SWAP[1] or v.get(stage + "\\" + CAND_NAME) != BUNDLE_SHA:
            raise SystemExit("--stage-receipt: that stage does not hold bundle-swap.ps1 21d85c69 and the candidate bundle: --stage anew")
        mode = "inspect" if o.swap_inspect else "apply" if o.swap_bundle else "rollback"; p = swap_params(stage, mode)
        if mode != "inspect" and not attempt(f"attempt-swap-{mode}-{stage.rsplit('-', 1)[-1]}.json", {"params": p}): return 4
        r = H.run_script(stage, "bundle-swap.ps1", p, 150); save(f"swap-{mode}-{ts}.json", {"what": "swap", "at": now(), "params": p, "result": r})
        print(json.dumps(r, indent=1)); ok = isinstance(r, dict) and SWAP_OK[mode](str(r.get("decision", "")))
        print("OK" if ok else "NOT OK: root reads the result (observed hashes, journal); never retried automatically"); return 0 if ok else 3
    if o.cmd_fixture:     # platform-carrier: cmd.exe's own parse of the carrier line (throwaway files in the stage only)
        t = cmdfix_text(stage); pt = parse_text(t)
        pr = m.ps(pt, 60)
        if not parsed_ok(pr, t): print("REFUSED: the host's PowerShell did not parse the fixture text cleanly; NOT executed"); return 3
        r = m.ps(t, 60); want = "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=" + CARRIERS
        ok = isinstance(r, dict) and r.get("out") == [want] and r.get("cleaned") is True
        save(f"cmdfix-{ts}.json", {"what": "cmdfix", "at": now(), "parse": pr, "result": r, "expected": want, "ok": ok}); print(json.dumps({"ok": ok, "out": r.get("out")}, indent=1))
        return 0 if ok else 3
    if o.status:
        if not o.run_id: raise SystemExit("--run-id")
        print(json.dumps(m.ps(JOURNAL.replace("JX", q(stage + f"\\policy-{o.run_id}.jsonl")).replace("TNX", q("policy-act-" + o.run_id)), 60), indent=1)); return 0
    if o.post:
        rec0 = OUT / f"activate-result-{o.post}.json"
        if not rec0.exists(): raise SystemExit(f"{rec0}: the activation's result receipt is required")
        r0 = json.loads(rec0.read_text()); lines = [json.loads(l) for l in r0["journal"]["lines"]]; step = {l.get("step"): l for l in lines}
        if not str(step.get("post", {}).get("final", "")).startswith(("DONE:", "DONE_PARTIAL:", "DONE_CHECK:")): raise SystemExit("the activation did not end on a DONE* line: --post does not apply")
        off = int(step["pins"]["nodeLogOffset"]); post = {"what": "post", "at": now(), "run": o.post, "configs": m.ps(POL, 90), "channel": m.ps(CHAN, 90), "log": m.ps(POSTLOG.replace("OFFX", str(off)), 90)}
        v = post_verdict(r0, step, post); save(f"post-{o.post}-{ts}.json", {**post, "verdict": v}); print(json.dumps(v, indent=1)); return 0 if v["verdict"] == "PASS" else 3
    if not (o.activate or o.rollback):
        for t in (IDN, POL, CHAN, UPD):
            if enc_len(m, t, 120) > LIMIT: raise SystemExit("a preflight text is too long")
        pre = preflight(m); save(f"preflight-{ts}.json", {"what": "preflight", "at": now(), **pre})
        print(json.dumps({"errors": pre["errors"], "refusals": {"activate": refusals(pre), "rollback": refusals(pre, "rollback")}}, indent=1)); return 0 if not pre["errors"] else 1
    pre = fresh(o.preflight, "preflight", ACT_FRESH_S) if o.preflight else None
    if not pre: raise SystemExit(f"--preflight: a preflight receipt at most {ACT_FRESH_S} s old")
    i, c = pre["identities"], pre["configs"]
    if o.activate:
        if not o.option: raise SystemExit("--option RC (the only option this package offers)")
        # platform-carrier (root review B-RPC / B2): ONLY RC is offered. P/PC use the bundle's production quorum, which includes
        # BlockPI (503 natively, ROOT-BLOCKPI-0419); R has no carrier, so an admin anchor would strand this host (B2).
        if o.option != "RC":
            print(json.dumps({"refused": [f"option {o.option}: only RC is offered (P/PC: production quorum incl. BlockPI not proven natively; R: no policy carrier)"]}, indent=1)); return 2
        g = fresh(o.gate_receipt, "gate", ACT_FRESH_S) if o.gate_receipt else None
        if not g: raise SystemExit(f"--gate-receipt: a gate receipt at most {ACT_FRESH_S} s old (it must PROVE admission for this option first)")
        refuse = refusals(pre, "activate", g, o.option)
        if refuse: print(json.dumps({"refused": refuse}, indent=1)); return 2
        mode, run = "activate", ts.lower() + "-" + uuid.uuid4().hex[:6]
        local_sha = c["node-config.local.cmd"]["sha"]; before = None
    else:
        refuse = refusals(pre, "rollback")
        if refuse: print(json.dumps({"refused": refuse}, indent=1)); return 2
        run0 = o.rollback; rec0 = OUT / f"activate-result-{run0}.json"
        if not rec0.exists(): raise SystemExit(f"{rec0}: the activation's own result receipt (with its journal) is required")
        r0 = json.loads(rec0.read_text()); lines = [json.loads(l) for l in r0["journal"]["lines"]]
        bk = next((l for l in lines if l.get("step") == "backups"), None); pol = next((l for l in lines if l.get("step") == "policy"), None)
        if not bk or not pol: raise SystemExit("the activation journal has no backups/policy step: nothing to restore")
        if c["node-config.local.cmd"]["sha"] != pol["after"]: raise SystemExit("node-config.local.cmd is not the activation's after sha: root decides")
        mode, run = "rollback", run0 + "-rb"; local_sha = pol["after"]; o.option = r0["params"]["option"]
        before = {"local": {"before": r0["params"]["localSha"], "after": pol["after"], "backup": bk["localBackup"]}}
    params = {"stage": stage, "runId": run, "boundSec": BOUND_S, "runner": RUNNER, "endpoint": ENDPOINT, "option": o.option,
              "runNodeSha": c["run-node.cmd"]["sha"], "nodeConfigSha": c["node-config.cmd"]["sha"], "cfgSha": c["cfg"], "localSha": local_sha,
              "bundleSha": BUNDLE_SHA, "nodeExe": NODE_EXE, "nodeSha": NODE_SHA, "lease": dict(LEASE), "files": [{"path": p, "sha": h} for p, h in F1.items()],
              "node": {"cmdPid": i["cmd"][0]["pid"], "cmdStart": i["cmd"][0]["start"], "agentPid": i["agent"][0]["pid"], "agentStart": i["agent"][0]["start"]},
              "manager": i["manager"], "privacy": i["privacy"][0], "vms": i["vms"], "hyperv": i["hyperv"], "expectedIds": expected_ids()}
    if before: params["before"] = before
    OUT.mkdir(exist_ok=True); pfile = OUT / f"params-{run}.json"; pfile.write_text(json.dumps(params, indent=1)); psha = sha(pfile)
    remote_p = stage + f"\\params-{run}.json"
    if not attempt(f"attempt-{mode}-{run}.json", {"params": params, "paramsSha": psha}): return 4
    cp = subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", str(pfile), "minipc:/" + remote_p.replace("\\", "/")], capture_output=True, text=True)
    if cp.returncode: save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "error": "params upload failed", "stderr": cp.stderr[-300:]}); return 3
    ps1 = stage + "\\node-policy-activation.ps1"; jx = stage + f"\\policy-{run}.jsonl"
    loader = LOADER.replace("PS1X", ps1).replace("PSHA", sha(COORD)).replace("PFX", remote_p).replace("PFSHA", psha).replace("MODEX", mode)
    enc = base64.b64encode(loader.encode("utf-16-le")).decode()
    r = m.ps(LAUNCH.replace("TNX", q("policy-act-" + run)).replace("ENCX", enc), 90)
    print(json.dumps({"launch": r, "runId": run}, indent=1))
    if r.get("decision") != "started": save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "launch": r}); return 3
    end, j = time.time() + o.poll_sec, {}
    while time.time() < end:          # read-only polls; a disconnect here does not stop the remote task
        time.sleep(20); j = m.ps(JOURNAL.replace("JX", q(jx)).replace("TNX", q("policy-act-" + run)), 60)
        if any('"final"' in l for l in j.get("lines", [])): break
    rec = save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "runId": run, "params": params, "paramsSha": psha, "launch": r, "journal": j})
    fin = [json.loads(l)["final"] for l in j.get("lines", []) if '"final"' in l]
    print(json.dumps({"final": fin, "receipt": str(rec)}, indent=1))
    if not fin: print(f"NO FINAL YET: the task may still run. Inspect with --status --run-id {run}; NEVER start another run meanwhile.")
    kind = classify(fin[-1]) if fin else None; print(OUTCOME.get(kind, ""))
    return 0 if kind == "done" else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
