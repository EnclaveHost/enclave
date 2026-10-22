#!/usr/bin/env python3
"""ROOT-ONLY: activate the non-destructive wallet hold on minipc with the FINAL CONTROL PACKAGE. PREPARED by Claude (control-package
20261022); NEVER run by its author; no remote call was ever made with it. Successor of work/g4-node-ai-final-20261021/helper/
root-node-hold.py 0829847e: every remote text (IDN/CFGS/ACLS/COV/PUT/UNPUT/AGENT/LOADER/LAUNCH/JOURNAL), the transport pin
and bundle-swap.ps1 pin are kept VERBATIM. Changed:
  * the file set is ../manifest.json (pinned): network = privacy-agent 7ef4e230 -> cfb69370 ONLY (ingress c952dce4 and worker
    13ce44f1 are already live and are verify-only KEEP pins, never replaced); control = 18 files (5 PUT + 13 CAS swaps) = the
    part of the node agent's exact runtime import closure (81 files) that ROOT's fresh snapshot (2026-10-22T01:44:55Z) shows
    differing from the candidate; KEEP = 67 verify-only pins (the unchanged agent/
    manager closure + ingress/worker + enclave-wg cbaf8313 + firewall 78daec71); manager-only files are OBSERVED (report only).
  * hashing is BATCHED under the transport's 7900-char encoded limit (exact length computed with the transport's own HEAD).
  * group apply/rollback first reads every target (read-only): any target that is neither the old nor the new bytes REFUSES the
    whole group before anything changes; already-new (apply) / already-old (rollback) targets are skipped, so a rollback after a
    partial apply restores exactly the applied files (0829847e stopped at the first unapplied file: bundle-swap refuses its CAS).
  * the cutover is the ROOT-ACCEPTED cutover-review candidate 943a5f01 (r2; r1 pinned d88bab63; copied verbatim); its params carry
    runId (0829847e sent none: the journal would have been cutover-.jsonl and the poll would never see a final line) and the
    lease budget of cutover-review/candidate/budget.json (= node-stop-proof d88's leaseBudget: revert 550 / margin 180 / forward 180 / startNode 150).
  * the static 20-minute lease guard is replaced by budget.json's minimumRemainingBeforeStop (910 s), estimated from the
    preflight's remote clock; the cutover's own pins and BeforeStop read remain AUTHORITATIVE.

  root-node-hold.py                                          read-only preflight -> runs/preflight-*.json
  root-node-hold.py --stage --preflight P                    NEW C:\\ProgramData\\Enclave\\staging\\nodehold-<uuid12>: files+scripts, sha-verified
  root-node-hold.py --apply network --stage-receipt S        privacy-agent 7ef4e230 -> cfb69370 (no restart)
  root-node-hold.py --restart-agent --preflight P            the privacy agent's own restart (pinned PID+start); NO walletAdmission yet
  root-node-hold.py --apply control --stage-receipt S        5 PUT + 13 CAS swaps (inert for running processes; see REVIEW.txt)
  root-node-hold.py --cutover --stage-receipt S --preflight P          THE switch-on (node-hold-cutover.ps1 -Mode cutover)
  root-node-hold.py --status --stage-receipt S --run-id R              read the remote journal (read-only)
  root-node-hold.py --rollback-cutover R --stage-receipt S --preflight P   exact config restore (node-hold-cutover.ps1 -Mode rollback)
  root-node-hold.py --rollback control|network --stage-receipt S       CAS file rollback (reverse order, applied files only)
Every mutating call writes an attempt record (O_EXCL) BEFORE the remote call; an existing record refuses (never retried).
Never read: config values (only shas, key names, ids, appRef shape), keys, logs (only pattern COUNTS of node.log lines).
"""
import argparse, base64, calendar, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, uuid

HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; W = PKG.parents[1]; OUT = HERE / "runs"
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
SCRIPTS = {"bundle-swap.ps1": (W / "cron-startup-20261021/respawn-activation/bundle-swap.ps1", "21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103"),
           "node-hold-cutover.ps1": (HERE / "node-hold-cutover.ps1", "943a5f0173a291c8ed2a3d160552dd5ab8633069cc331ba9c39b6806460e2093")}
MANIFEST = (PKG / "manifest.json", "5094dca0c9de9134a37ff8b7bfb35cabf4a3efbb301f2810bb6c95276861647d")
RUN_NODE = "3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686"
LOCAL_CFG = "85698d20b4f8fb494c8620aeb80d5b4fbd2ec637ef40c7fa02693ba41ee2aa73"      # node-config.local.cmd (probe 21:20Z)
PF = r"C:\Program Files\Enclave"
NODE_EXE, NODE_SHA = r"C:\Program Files\nodejs\node.exe", "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"
# cutover-review/candidate/budget.json leaseBudget (sha pinned in the manifest) and its minimumRemainingBeforeStop
LEASE = {"revertSec": 550, "marginSec": 180, "forwardMinSec": 180, "startNodeSec": 150}; LEASE_NEED = 910
LIMIT = 7600                                                            # encoded chars per batch (transport refuses > 7900)

def _manifest():
    b = MANIFEST[0].read_bytes(); j = json.loads(b)
    files = {d["name"]: (PKG / "files" / d["name"], d["target"], d["old"], d["new"], d["how"]) for d in j["deploy"]}
    groups = {g: [d["name"] for d in j["deploy"] if d["group"] == g] for g in ("network", "control")}
    return hashlib.sha256(b).hexdigest(), files, groups, {k["target"]: k["sha256"] for k in j["keep"]}, [o["target"] for o in j["managerOnlyObserved"]]
MANIFEST_SHA, FILES, GROUPS, KEEP, OBSERVE = _manifest()
CFG = r"C:\ProgramData\Enclave\network\privacy-config.json"; RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a"
APPREF = re.compile(r"^catalog://0x[0-9a-f]{64}/(?:0|[1-9][0-9]{0,8})$"); ID = re.compile(r"^0x[0-9a-f]{64}$")
FRESH_S, CUT_FRESH_S, BOUND_S = 1800, 600, 900
q = lambda v: "'" + str(v).replace("'", "''") + "'"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
U = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"

# -------------------------------------------------------------------------------------------------- remote texts
# the same expressions as node-hold-cutover.ps1 (NodeProcs / Manager / Privacy / Vms), so the pins match byte for byte
IDN = U + (r"function Utc($p){$p.CreationDate.ToUniversalTime().ToString('o')};$all=@(Get-CimInstance Win32_Process -OperationTimeoutSec 30);$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')};"
    r"$o.cmd=@($all|Where-Object{$_.Name -eq 'cmd.exe' -and [string]$_.CommandLine -like '*\Enclave\run-node.cmd*'}|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;start=(Utc $_)}});"
    r"$o.agent=@($all|Where-Object{$_.Name -eq 'node.exe' -and [string]$_.CommandLine -like '*\control\windows\node\agent.mjs*'}|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;start=(Utc $_)}});"
    r"$o.privacy=@($all|Where-Object{$_.Name -eq 'node.exe' -and [string]$_.CommandLine -match 'privacy-agent\.mjs'}|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;start=(Utc $_)}});"
    r"$c=@(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue);$o.manager=$(if($c.Count -eq 1){$p=$all|Where-Object{$_.ProcessId -eq $c[0].OwningProcess};('{0}@{1}' -f $p.ProcessId,(Utc $p))}else{''});"
    r"$o.vms=$(try{@((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms|ForEach-Object{'{0}|{1}|{2}' -f $_.id,$_.name,$_.status}|Sort-Object) -join ','}catch{'unavailable'});"
    # Hyper-V's own identity of every VM (GUID|name|state), the SAME expression as node-hold-cutover.ps1 HyperV()
    r"$o.hyperv=$(try{@(Get-VM -ErrorAction Stop|ForEach-Object{'{0}|{1}|{2}' -f $_.Id,$_.Name,$_.State}|Sort-Object) -join ','}catch{'unavailable'});"
    r"$o.wg=@($all|Where-Object{$_.Name -eq 'enclave-wg.exe'}).Count;$o.tasks=@(Get-ScheduledTask -TaskPath '\Enclave\'|ForEach-Object{$_.TaskName+'='+[string]$_.State});$o|ConvertTo-Json -Compress -Depth 5")
CFGS = U + (r"$o=[ordered]@{at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')};$pd='C:\ProgramData\Enclave';$a=Get-Acl -LiteralPath ($pd+'\network');$o.netWriters=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x116)}|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique);$o.netReaders=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.AccessControlType -eq 'Allow' -and ((([int]$_.FileSystemRights -band 0x10000001) -ne 0) -or ([int]$_.FileSystemRights -lt 0))}|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique);$o.pdInheritReaders=@((Get-Acl -LiteralPath $pd).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.AccessControlType -eq 'Allow' -and ([string]$_.InheritanceFlags -match 'ObjectInherit') -and ((([int]$_.FileSystemRights -band 0x10000001) -ne 0) -or ([int]$_.FileSystemRights -lt 0))}|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique);$u=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue;$o.update=$(if($u){$ui=Get-ScheduledTaskInfo -InputObject $u;[ordered]@{state=[string]$u.State;next=$(if($ui.NextRunTime){$ui.NextRunTime.ToUniversalTime().ToString('o')}else{$null})}}else{'absent'});$o.nodeExe=FileSha 'C:\Program Files\nodejs\node.exe';$o.runtimeNodeExe=FileSha 'C:\Program Files\Enclave\runtime\node\node.exe';$o.runNode=FileSha ($pd+'\run-node.cmd');$o.local=FileSha ($pd+'\node-config.local.cmd');$o.flag=([IO.File]::ReadAllText($pd+'\node-config.local.cmd') -match 'ENCLAVE_NETWORK_WALLET_HOLD');"
    r"$o.cfg=FileSha 'CFGX';$o.enKeys=@(([IO.File]::ReadAllText('CFGX')|ConvertFrom-Json).enclaveNetwork.PSObject.Properties.Name);$o.wallet=FileSha ($pd+'\network\wallet-admission.json');"
    r"try{$s=[IO.File]::ReadAllText($pd+'\network\state\status.json')|ConvertFrom-Json;$o.statusAgeMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[int64]$s.updatedAt;$o.statusWallet=$s.walletAdmission}catch{$o.statusAgeMs=-1};"
    r"try{$o.egressApps=@(([IO.File]::ReadAllText($pd+'\network\state\egress-routes.json')|ConvertFrom-Json).apps.PSObject.Properties).Count}catch{$o.egressApps=-1};$o|ConvertTo-Json -Compress -Depth 5").replace("CFGX", CFG)
ACLS = U + r"$pd='C:\ProgramData\Enclave';[ordered]@{cfgAcl=(Get-Acl -LiteralPath ($pd+'\network\privacy-config.json')).Sddl;localAcl=(Get-Acl -LiteralPath ($pd+'\node-config.local.cmd')).Sddl}|ConvertTo-Json -Compress"   # security descriptors only, never bytes
COV = U + (r"$o=[ordered]@{};$c=[IO.File]::ReadAllText('CFGX')|ConvertFrom-Json;"
    r"$o.apps=@($c.apps|ForEach-Object{$e=$null;try{$e=[IO.File]::ReadAllText([string]$_.expectedFile)|ConvertFrom-Json}catch{};[ordered]@{id=[string]$_.deploymentId;appRef=[string]$e.appRef;configCidString=($e.configCid -is [string]);configCidLen=$(if($e.configCid -is [string]){([string]$e.configCid).Length}else{-1})}});"
    r"try{$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state';$o.records=@($h.deployments|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;appRef=[string]$_.appRef;iso=[string]$_.isolation.instance;leaseUntil=$_.leaseUntil}})}catch{$o.records=$null};"
    r"$t=(Get-Date).ToUniversalTime().AddMinutes(-30).ToString('HH:mm');$n=(Get-Date).ToUniversalTime().ToString('HH:mm');"
    r"$o.policyUnavailable30min=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 4000|Where-Object{$_ -like '*host wallet policy unavailable*' -or $_ -like '*chain quorum unavailable*'}|ForEach-Object{$_.Substring(0,5)}|Where-Object{if($t -le $n){$_ -ge $t -and $_ -le $n}else{$_ -ge $t -or $_ -le $n}}).Count;"
    r"$o|ConvertTo-Json -Compress -Depth 5").replace("CFGX", CFG)
PUT = U + (  # root-a2-minipc.py PUT, verbatim: CAS put of ONE public program file (old 'absent' = new file)
    r"$t=TX;$s=SX;$old=OX;$new=NX;$pv=PX;$o=[ordered]@{target=FileSha $t;staged=FileSha $s};"
    r"if($o.target -eq $new){$o.decision='noop: already new'}elseif($o.target -ne $old){$o.decision='refused: CAS (target is not old)'}elseif($o.staged -ne $new){$o.decision='refused: staged is not new'}else{"
    r"if($old -ne 'absent'){if(-not(Test-Path -LiteralPath $pv)){$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false);"
    r"foreach($x in 'S-1-5-18','S-1-5-32-544'){$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $x),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};[void][IO.Directory]::CreateDirectory($pv,$ds)};"
    r"$b=Join-Path $pv ('backup-'+$old.Substring(0,12));if((FileSha $b) -eq 'absent'){Copy-Item -LiteralPath $t -Destination $b};if((FileSha $b) -ne $old){throw 'backup is not old'}};"
    r"$tmp=$t+'.new-'+[guid]::NewGuid().ToString('N').Substring(0,8);Copy-Item -LiteralPath $s -Destination $tmp;if((FileSha $tmp) -ne $new){Remove-Item -LiteralPath $tmp -Force;throw 'copy is not new'};"
    r"try{if($old -eq 'absent'){[IO.File]::Move($tmp,$t)}else{$acl=Get-Acl -LiteralPath $t;[IO.File]::Replace($tmp,$t,[NullString]::Value);Set-Acl -LiteralPath $t -AclObject $acl}}"
    r"catch{Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue;$o.error=[string]$_.Exception.Message};"
    r"$o.after=FileSha $t;$o.decision=$(if($o.after -eq $new){'applied'}elseif($o.after -eq $old){'FAILED: unchanged'}else{'AMBIGUOUS'})};$o|ConvertTo-Json -Compress")
UNPUT = U + (  # root-a2-minipc.py UNPUT, verbatim
    r"$t=TX;$old=OX;$new=NX;$pv=PX;$o=[ordered]@{target=FileSha $t};"
    r"if($o.target -eq $old){$o.decision='noop: already old'}elseif($o.target -ne $new){$o.decision='refused: CAS (target is not new)'}else{"
    r"try{if($old -eq 'absent'){Remove-Item -LiteralPath $t -Force}else{$b=Join-Path $pv ('backup-'+$old.Substring(0,12));if((FileSha $b) -ne $old){throw 'backup is not old'};"
    r"$tmp=$t+'.old-'+[guid]::NewGuid().ToString('N').Substring(0,8);Copy-Item -LiteralPath $b -Destination $tmp;$acl=Get-Acl -LiteralPath $t;[IO.File]::Replace($tmp,$t,[NullString]::Value);Set-Acl -LiteralPath $t -AclObject $acl}}"
    r"catch{$o.error=[string]$_.Exception.Message};$o.after=FileSha $t;$o.decision=$(if($o.after -eq $old){'rolled back'}elseif($o.after -eq $new){'FAILED: unchanged'}else{'AMBIGUOUS'})};$o|ConvertTo-Json -Compress")
AGENT = U + (  # root-a2-minipc.py AGENT, verbatim (+ the script sha it ends on)
    r"$f=('Name=''node.exe''');$pa=@(Get-CimInstance Win32_Process -Filter $f -OperationTimeoutSec 20|Where-Object{[string]$_.CommandLine -match 'privacy-agent\.mjs'});$o=[ordered]@{wgBefore=@(Get-CimInstance Win32_Process -Filter ('Name=''enclave-wg.exe''')).Count};"
    r"if($pa.Count -ne 1 -or [int]$pa[0].ProcessId -ne PIDX -or $pa[0].CreationDate.ToUniversalTime().ToString('o') -ne STARTX){$o.decision='refused: the privacy agent is not the pinned PID+start'}else{"
    r"Stop-Process -Id PIDX -Force;$t0=Get-Date;$n=$null;while(((Get-Date)-$t0).TotalSeconds -lt 90 -and -not $n){Start-Sleep 3;$n=@(Get-CimInstance Win32_Process -Filter $f|Where-Object{[string]$_.CommandLine -match 'privacy-agent\.mjs' -and $_.ProcessId -ne PIDX})[0]};"
    r"if($n){$o.newPid=[int]$n.ProcessId;$o.newStart=$n.CreationDate.ToUniversalTime().ToString('o');$o.backAfterSec=[math]::Round(((Get-Date)-$t0).TotalSeconds,1);Start-Sleep 60;"
    r"$o.alive=$null -ne (Get-Process -Id $o.newPid -ErrorAction SilentlyContinue);$o.wgAfter60s=@(Get-CimInstance Win32_Process -Filter ('Name=''enclave-wg.exe''')).Count;$o.decision='restarted'}else{$o.decision='ROOT: no new privacy agent within 90 s'}};"
    r"$o.agentScript=FileSha 'C:\Program Files\Enclave\network\privacy-agent.mjs';"
    r"try{$s=[IO.File]::ReadAllText('C:\ProgramData\Enclave\network\state\status.json')|ConvertFrom-Json;$o.statusAgeMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[int64]$s.updatedAt;$o.statusWallet=$null -ne $s.walletAdmission}catch{};"
    r"try{$o.egressApps=@(([IO.File]::ReadAllText('C:\ProgramData\Enclave\network\state\egress-routes.json')|ConvertFrom-Json).apps.PSObject.Properties).Count}catch{};$o|ConvertTo-Json -Compress")
# the one-shot SYSTEM task: its loader re-verifies the staged script AND params by sha, then runs them; \EnclaveOps\ (not
# \Enclave\, whose task list the node scripts compare)
# ONE read of the script bytes, hashed and run from those bytes; the script itself checks its params file against -ParamsSha
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

spec = importlib.util.spec_from_file_location("transport", T[0]); m = importlib.util.module_from_spec(spec)

def verify_local():
    bad = [str(p) for p, h in [T, MANIFEST] + list(SCRIPTS.values()) if sha(p) != h] + [k for k, v in FILES.items() if sha(v[0]) != v[3]]
    if bad: raise SystemExit(f"local pins differ: {bad}")
    if not hasattr(m, "ps"): spec.loader.exec_module(m)     # loaded ONCE (a test's fake transport is never replaced)

def enc_len(text, secs):
    """the exact encoded length the transport (m.ps) computes for this text"""
    return len(base64.b64encode((m.HEAD.replace("SECS", str(secs)) + text).encode("utf-16-le")))

def sha_text(prefix, rels):
    return U + "$b=" + q(prefix) + ";$o=[ordered]@{};foreach($x in @(" + ",".join(q(r) for r in rels) + ")){$o[$x]=FileSha ($b+$x)};$o|ConvertTo-Json -Compress"

def batched_sha(paths, prefixes=(), secs=90):
    """FileSha of every remote path, packed into as few read-only calls as fit LIMIT. -> ({path: sha}, [errors])"""
    pre = sorted(set(prefixes) | {PF + "\\control\\", PF + "\\network\\"}, key=len, reverse=True)
    by = {}
    for p in dict.fromkeys(paths):
        b = next((x for x in pre if p.startswith(x) and len(p) > len(x)), ""); by.setdefault(b, []).append(p[len(b):])
    out, errs = {}, []
    for b, rels in by.items():
        batch = []
        for r in rels + [None]:
            if r is not None and (not batch or enc_len(sha_text(b, batch + [r]), secs) <= LIMIT): batch.append(r); continue
            if enc_len(sha_text(b, batch), secs) > LIMIT: raise SystemExit(f"one path does not fit a batch: {b + batch[0]}")
            res = m.ps(sha_text(b, batch), secs)
            if not isinstance(res, dict) or "error" in res: errs.append({"batch": [b + x for x in batch], "error": res.get("error") if isinstance(res, dict) else str(res)})
            else: out.update({b + x: res.get(x) for x in batch})
            batch = [r] if r is not None else []
    return out, errs

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", OUT / name); return OUT / name

def attempt(name, body):
    try: save(name, {"what": "attempt", "at": now(), **body}); return True
    except FileExistsError: print(f"REFUSED: {OUT / name} exists; an attempt is never retried automatically (root inspects, then moves it aside)"); return False

def fresh(path, what, limit=FRESH_S):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != what: raise SystemExit(f"{path} is not a {what} receipt")
    if time.time() - calendar.timegm(time.strptime(o["at"], "%Y-%m-%dT%H:%M:%SZ")) > limit: raise SystemExit(f"{path} is older than {limit} s")
    return o

def run_script(stage, name, params, secs):
    """a staged script, executed only if its bytes are the pin (root-a2-minipc.py run_script)"""
    splat = "@{" + ";".join(f"{k}={v if isinstance(v, int) else q(v)}" for k, v in params.items()) + "}"
    return m.ps(f"$p={q(stage + chr(92) + name)};$b=[IO.File]::ReadAllBytes($p);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace '-','').ToLower();"
                f"if($h -ne '{SCRIPTS[name][1]}'){{'{{\"decision\":\"refused: the staged {name} is not the pinned bytes\"}}';exit 0}};"
                f"$a={splat};& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) @a", secs)

def skey(k): return k.replace("/", "__")
def staged(stage, k): return stage + "\\files\\" + skey(k)

def change(stage, k, back=False):
    src, tgt, old, new, how = FILES[k]
    if how == "swap":
        p = ({"Mode": "rollback", "Target": tgt, "WorkDir": stage + "\\swap-" + skey(k), "OldSha": old, "ExpectCurrent": new} if back else
             {"Mode": "apply", "Target": tgt, "WorkDir": stage + "\\swap-" + skey(k), "OldSha": old, "NewFile": staged(stage, k), "NewSha": new})
        r = run_script(stage, "bundle-swap.ps1", p, 150); d = str(r.get("decision", ""))
        return r, (d == "rolled back" or d.startswith("noop")) if back else (d.startswith("applied") or d.startswith("noop"))
    t = UNPUT if back else PUT
    r = m.ps(t.replace("TX", q(tgt)).replace("SX", q(staged(stage, k))).replace("OX", q(old)).replace("NX", q(new)).replace("PX", q(stage + "\\put-private")), 150)
    d = str(r.get("decision", ""))
    return r, (d == "rolled back" or d.startswith("noop")) if back else (d == "applied" or d.startswith("noop"))

def states(fil):
    return {k: ("old" if fil.get(v[1]) == v[2] else "new" if fil.get(v[1]) == v[3] else f"UNKNOWN {fil.get(v[1])}") for k, v in FILES.items()}

def iso_epoch(s):
    return calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S"))

def preflight():
    """read-only: identities, the VM set, file states, configs (shas/key names), the network status, coverage, the gates"""
    t_local = time.time()
    idn = m.ps(IDN, 120); cfgs = m.ps(CFGS, 90)
    acls = m.ps(ACLS, 60); cfgs = {**cfgs, **{k: acls.get(k) for k in ("cfgAcl", "localAcl")}}   # missing -> refused (unreadable)
    idn = {**idn, **{k: v for k, v in cfgs.items() if k != "error"}} if "error" not in idn else idn
    if "error" in cfgs: idn["error"] = "configs: " + str(cfgs["error"])
    fil, ferr = batched_sha([v[1] for v in FILES.values()] + list(KEEP) + OBSERVE)
    cov = m.ps(COV, 120)
    state = states(fil)
    keep = {p: fil.get(p) == h for p, h in KEEP.items()}
    # coverage: every VM named by a deployment id must be a RUNNING record of this node with an exact-format appRef, enrolled
    # on the network with the same appRef (the allow binds lease.appRef/configCid); enrolled ids with no VM are only reported
    apps = {a["id"]: a for a in (cov.get("apps") or [])}; recs = {r["id"]: r for r in (cov.get("records") or [])}
    vmNames = [v.split("|")[1] for v in str(idn.get("vms", "")).split(",") if "|" in v]
    expected, blockers, stale = [], [], []
    for name in vmNames:
        if not ID.match(name): continue
        r, a = recs.get(name), apps.get(name)
        why = ("no node record" if not r else "record not running" if r["status"] != "running" else "appRef not the exact catalog form" if not APPREF.match(r["appRef"] or "")
               else "not enrolled on the network" if not a else "network expectation appRef differs" if a["appRef"] != r["appRef"]
               else "configCid not a string <= 8192" if not a["configCidString"] or a["configCidLen"] > 8192 else None)
        (blockers.append({"id": name, "why": why}) if why else expected.append(name))
    stale = [i for i in apps if i not in vmNames]
    ends = [recs[i].get("leaseUntil") for i in expected]
    lmin = min(ends) if ends and all(isinstance(e, (int, float)) and not isinstance(e, bool) for e in ends) else None
    try: r_at = iso_epoch(idn["at"])
    except Exception: r_at = None
    gate = {"policyUnavailable30min": cov.get("policyUnavailable30min"), "leaseMinUntil": lmin, "remoteAtEpoch": r_at, "localAtEpoch": t_local,
            "leaseMinSecAtPreflight": (lmin - r_at) if lmin is not None and r_at is not None else None, "leaseNeedSec": LEASE_NEED}
    errors = {k: v.get("error") for k, v in (("identities", idn), ("coverage", cov)) if isinstance(v, dict) and v.get("error")}
    if ferr: errors["files"] = ferr
    return {"identities": idn, "files": fil, "state": state, "keepUnchanged": keep, "observed": {p: fil.get(p) for p in OBSERVE},
            "coverage": {"expectedIds": sorted(expected), "blockers": blockers, "staleEnrolledWithoutVm": sorted(stale), "records": len(recs), "apps": len(apps)},
            "gate": gate, "manifestSha": MANIFEST_SHA, "errors": errors}

def lease_estimate(pre, at=None):
    """seconds until the first expected lease ends, now, from the preflight's remote clock (renewals since only lengthen it)"""
    g = pre["gate"]
    if not all(isinstance(g.get(k), (int, float)) for k in ("leaseMinUntil", "remoteAtEpoch", "localAtEpoch")): return None
    return g["leaseMinUntil"] - (g["remoteAtEpoch"] + ((time.time() if at is None else at) - g["localAtEpoch"]))

def cutover_refusals(pre):
    r, i = [], pre["identities"]
    if pre["errors"]: r.append(f"preflight errors {pre['errors']}")
    if pre.get("manifestSha") != MANIFEST_SHA: r.append("the preflight was taken with another manifest")
    if any(s != "new" for s in pre["state"].values()): r.append(f"files not all new: { {k: s for k, s in pre['state'].items() if s != 'new'} }")
    bad = [p for p, ok in pre["keepUnchanged"].items() if not ok]
    if bad: r.append("verify-only pins differ (unchanged closure / ingress / worker / enclave-wg.exe / firewall): " + ", ".join(bad))
    if len(i.get("cmd", [])) != 1 or len(i.get("agent", [])) != 1 or len(i.get("privacy", [])) != 1 or not i.get("manager"): r.append("identities are not exactly one node cmd/agent, one privacy agent, one manager")
    if i.get("runNode") != RUN_NODE: r.append("run-node.cmd is not the pinned file")
    if i.get("local") != LOCAL_CFG or i.get("flag"): r.append("node-config.local.cmd is not the pinned sha, or already names the flag")
    if "walletAdmission" in (i.get("enKeys") or []) or i.get("wallet") != "absent" or i.get("statusWallet"): r.append("the network side already carries wallet admission")
    if not (0 <= int(i.get("statusAgeMs", -1)) < 5000): r.append("the privacy agent's status is not fresh")
    if i.get("vms") in (None, "", "unavailable"): r.append("the manager's VM list is unavailable (never compared as unchanged)")
    if i.get("hyperv") in (None, "", "unavailable"): r.append("Hyper-V's VM list (Get-VM) is unavailable (never compared as unchanged)")
    for k in ("cfgAcl", "localAcl"):     # an auto-inherited DACL (D:AI / D:PAI): the form the exact ACL round-trip is proven for
        mm = re.search(r"D:([A-Z]*)\(", str(i.get(k) or ""))
        if not mm or "AI" not in mm.group(1): r.append(f"{k}: the DACL is not auto-inherited ({(mm.group(0)[:-1] if mm else 'unreadable')}); the exact ACL round-trip would refuse - root fixes that ACL first")
    if [w for w in (i.get("netWriters") or ["unknown"]) if w not in ("S-1-5-18", "S-1-5-32-544")]: r.append(f"the network directory is writable by more than SYSTEM/Administrators: {i.get('netWriters')}")
    if pre["coverage"]["blockers"]: r.append(f"coverage blockers {pre['coverage']['blockers']}")
    if not pre["coverage"]["expectedIds"]: r.append("no VM-backed deployment found (refusing to infer coverage)")
    # root review G-UPD: \Enclave\Update (hourly, SYSTEM) can start the node outside the coordinator; the cutover script re-checks
    # at its own pins (authoritative); here: not running, and not due before this preflight's validity + the bound + 60 s
    u = i.get("update")
    if not isinstance(u, dict) and u != "absent": r.append(f"the \\Enclave\\Update task state is unreadable ({u!r})")
    elif isinstance(u, dict):
        nxt = u.get("next"); due = None
        try: due = calendar.timegm(time.strptime(nxt[:19], "%Y-%m-%dT%H:%M:%S")) if nxt else None
        except Exception: r.append(f"the \\Enclave\\Update next run time is unreadable ({nxt!r})")
        at = calendar.timegm(time.strptime(str(i.get("at", ""))[:19], "%Y-%m-%dT%H:%M:%S")) if i.get("at") else time.time()   # the remote clock (CFGS), one clock with NextRunTime
        if u.get("state") == "Running" or (due is not None and due < at + CUT_FRESH_S + BOUND_S + 60):
            r.append(f"the \\Enclave\\Update task runs or is due inside the cutover window ({u}): wait until after its run (G-UPD)")
    # root review N3: nobody but SYSTEM/Administrators may READ the network directory, nor inherit READ on new files in the data dir
    if [x for x in (i.get("netReaders") or ["unknown"]) if x not in ("S-1-5-18", "S-1-5-32-544")]: r.append(f"the network directory is readable by more than SYSTEM/Administrators (N3): {i.get('netReaders')}")
    if [x for x in (i.get("pdInheritReaders") if i.get("pdInheritReaders") is not None else ["unknown"]) if x not in ("S-1-5-18", "S-1-5-32-544")]: r.append(f"new files in C:\\ProgramData\\Enclave inherit READ for more than SYSTEM/Administrators (N3): {i.get('pdInheritReaders')}")
    if i.get("nodeExe") != NODE_SHA: r.append(f"{NODE_EXE} is not the root-proven node.exe {NODE_SHA[:8]} ({i.get('nodeExe')})")
    if pre["gate"]["policyUnavailable30min"] != 0: r.append(f"P0 gate {pre['gate']} (root waits; never a quiet-RPC 'proof')")
    # lease window (budget.json): the stop needs >= LEASE_NEED s before the first lease ends; the script re-reads it (authoritative)
    est = lease_estimate(pre)
    if est is None: r.append("lease window unknown: no numeric leaseUntil for every expected deployment, or no remote clock")
    elif est < LEASE_NEED: r.append(f"lease window: the first lease ends in ~{int(est)} s, the stop needs >= {LEASE_NEED} s (revert {LEASE['revertSec']} + margin {LEASE['marginSec']} + forward {LEASE['forwardMinSec']}): preflight again right after the next renewals")
    return r

# the cutover's final lines (943a5f01): only DONE: is success; *_CHECK / DONE_PARTIAL are completed paths whose post-check failed
# (never reported as verified); ROLLED_BACK*/CRASHED_RESTORED without _CHECK are verified restorations; REFUSED changed nothing
def classify(final):
    f = str(final)
    if f.startswith("DONE:"): return "done"
    if f.startswith("RECOVERY_REQUIRED"): return "recovery"
    if f.startswith("REFUSED"): return "refused"
    if re.match(r"^[A-Z0-9_]+_CHECK:", f) or f.startswith("DONE_PARTIAL:"): return "check"
    if re.match(r"^(ROLLED_BACK(_[A-Z0-9_]+)?|CRASHED_RESTORED):", f): return "rolled-back"
    return "unknown"
OUTCOME = {"recovery": "RECOVERY_REQUIRED: the run STOPPED at a refusal. The node may be stopped and/or a config may be changed; the journal fields "
                       "recovery/nodeStopped/localSha/cfgSha/taskCommand say exactly which. Nothing automatic follows: root follows REVIEW.txt 'RECOVERY' by hand.",
           "rolled-back": "ROLLED_BACK: the old behaviour is verified back (no flag, no block, network not enforcing, node answering); the hold is NOT active.",
           "check": "CHECK: the path completed but a post-check failed or grants are missing (see post/fields); NOT verified; root decides, nothing automatic.",
           "refused": "REFUSED: the script refused before changing anything (see its reasons).",
           "unknown": "UNKNOWN FINAL: not a recognised outcome; root reads the journal."}

def group(stage, g, back):
    """CAS over a whole group: read every target first; refuse before any change if one is neither old nor new"""
    keys = list(reversed(GROUPS[g])) if back else GROUPS[g]
    fil, ferr = batched_sha([FILES[k][1] for k in keys]); st = states(fil)
    unknown = {k: st[k] for k in keys if st[k].startswith("UNKNOWN")}
    if ferr or unknown: return {"refused": "a target is unreadable or neither the old nor the new bytes: nothing changed", "unknown": unknown, "errors": ferr}, False, None
    todo = [k for k in keys if st[k] == ("new" if back else "old")]
    return {"before": {k: st[k] for k in keys}, "todo": todo}, True, todo

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group()
    x.add_argument("--stage", action="store_true"); x.add_argument("--apply", choices=list(GROUPS)); x.add_argument("--rollback", choices=list(GROUPS))
    x.add_argument("--restart-agent", action="store_true"); x.add_argument("--cutover", action="store_true"); x.add_argument("--status", action="store_true")
    x.add_argument("--rollback-cutover", metavar="RUN_ID")
    a.add_argument("--preflight"); a.add_argument("--stage-receipt"); a.add_argument("--run-id"); a.add_argument("--poll-sec", type=int, default=1200)
    o = a.parse_args(argv); verify_local(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not any([o.stage, o.apply, o.rollback, o.restart_agent, o.cutover, o.status, o.rollback_cutover]):
        pre = preflight(); save(f"preflight-{ts}.json", {"what": "preflight", "at": now(), **pre})
        print(json.dumps({"state": pre["state"], "keepDiffer": [p for p, ok in pre["keepUnchanged"].items() if not ok], "observed": pre["observed"],
                          "coverage": {k: v for k, v in pre["coverage"].items() if k != "records"}, "gate": pre["gate"], "errors": pre["errors"],
                          "cutoverRefusals": cutover_refusals(pre)}, indent=1))
        return 0 if not pre["errors"] and not any(s.startswith("UNKNOWN") for s in pre["state"].values()) else 1
    if o.stage:
        fresh(o.preflight, "preflight"); d = r"C:\ProgramData\Enclave\staging\nodehold-" + uuid.uuid4().hex[:12]
        rec = {"what": "stage", "at": now(), "stage": d, "preflight": o.preflight, "manifestSha": MANIFEST_SHA}
        rec["mkdir"] = m.ps(f"$d={q(d)};if(Test-Path -LiteralPath $d){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $d;$null=New-Item -ItemType Directory -Path ($d+'\\files');@{{created=$d}}|ConvertTo-Json -Compress", 60)
        if rec["mkdir"].get("created") != d: save(f"stage-{ts}.json", rec); raise SystemExit(f"stage not created: {rec['mkdir']}")
        ups = [(p, d + "\\" + n) for n, (p, _) in SCRIPTS.items()] + [(v[0], staged(d, k)) for k, v in FILES.items()]
        for src, dst in ups:
            c = subprocess.run(["timeout", "300", "scp", "-q", "-o", "BatchMode=yes", str(src), "minipc:/" + dst.replace("\\", "/")], capture_output=True, text=True)
            if c.returncode: rec["uploadFailed"] = {"file": dst, "stderr": c.stderr[-300:]}; break
        want = {d + "\\" + n: h for n, (_, h) in SCRIPTS.items()} | {staged(d, k): v[3] for k, v in FILES.items()}
        v, verr = batched_sha(list(want), prefixes=[d + "\\files\\", d + "\\"]); rec["verify"] = v; rec["verifyErrors"] = verr
        rec["ok"] = "uploadFailed" not in rec and not verr and all(v.get(p) == h for p, h in want.items())
        save(f"stage-{ts}.json", rec); print(json.dumps({k: rec[k] for k in ("stage", "ok")}, indent=1)); return 0 if rec["ok"] else 4
    st = fresh(o.stage_receipt, "stage", 7 * 86400) if o.stage_receipt else None
    if st and st.get("manifestSha") != MANIFEST_SHA: raise SystemExit("--stage-receipt: staged with another manifest")
    if o.apply or o.rollback:
        if not st or not st["ok"]: raise SystemExit("--stage-receipt: a passing stage receipt")
        g = o.apply or o.rollback; back = bool(o.rollback); name = f"attempt-{'rollback' if back else 'apply'}-{g}.json"
        plan, ok, todo = group(st["stage"], g, back)
        if not ok: save(f"{'rollback' if back else 'apply'}-{g}-refused-{ts}-{uuid.uuid4().hex[:6]}.json", {"what": "result", "at": now(), "ok": False, "plan": plan}); print(json.dumps(plan, indent=1)); return 3
        if not attempt(name, {"group": g, "rollback": back, "stage": st["stage"], "plan": plan}): return 4
        res = {}
        for k in todo:
            res[k], ok = change(st["stage"], k, back)
            if not ok: break
        save(f"{'rollback' if back else 'apply'}-{g}-result-{ts}.json", {"what": "result", "at": now(), "attempt": name, "ok": ok, "plan": plan, "steps": res})
        print(json.dumps(res, indent=1)); print("OK" if ok else "STOPPED at the first failure: ROOT reads the result; rollback is the CAS --rollback of this group (applied files only)")
        return 0 if ok else 3
    if o.restart_agent:
        pre = fresh(o.preflight, "preflight"); pa = pre["identities"].get("privacy") or []
        if len(pa) != 1: raise SystemExit("the preflight does not show exactly one privacy agent")
        sp = pre["state"]["network/privacy-agent.mjs"]
        if sp not in ("new", "old"): raise SystemExit(f"privacy agent {sp}: new (after --apply network) or old (after --rollback network)")
        want = FILES["network/privacy-agent.mjs"][3] if sp == "new" else FILES["network/privacy-agent.mjs"][2]
        if "walletAdmission" in (pre["identities"].get("enKeys") or []): raise SystemExit("the config already names walletAdmission: use --cutover / --rollback-cutover, not this")
        if not attempt(f"attempt-restart-agent-{pa[0]['pid']}.json", {"pid": pa[0]["pid"], "start": pa[0]["start"]}): return 4
        r = m.ps(AGENT.replace("PIDX", str(int(pa[0]["pid"]))).replace("STARTX", q(pa[0]["start"])), 240)
        save(f"restart-agent-result-{ts}.json", {"what": "result", "at": now(), "result": r}); print(json.dumps(r, indent=1))
        good = r.get("decision") == "restarted" and r.get("alive") and r.get("agentScript") == want and r.get("statusWallet") is False
        print(f"GATE: the {sp} runtime is alive without wallet admission; root's 30-min observation follows" if good else "CHECK: see the result (root decides)")
        return 0 if good else 3
    if not st or not st["ok"]: raise SystemExit("--stage-receipt: a passing stage receipt")
    stage = st["stage"]
    if o.status:
        if not o.run_id: raise SystemExit("--run-id")
        r = m.ps(JOURNAL.replace("JX", q(stage + f"\\cutover-{o.run_id}.jsonl")).replace("TNX", q("node-hold-" + o.run_id)), 60)
        print(json.dumps(r, indent=1)); return 0
    pre = fresh(o.preflight, "preflight", CUT_FRESH_S) if o.preflight else None
    if not pre: raise SystemExit(f"--preflight: a preflight receipt at most {CUT_FRESH_S} s old")
    i = pre["identities"]
    if o.cutover:
        refuse = cutover_refusals(pre)
        # the RUNNING privacy agent must be the one this helper restarted onto the new bundle (a file on disk proves nothing)
        ra = [json.loads(p.read_text()).get("result", {}) for p in sorted(OUT.glob("restart-agent-result-*.json"))]
        pa = (i.get("privacy") or [{}])[0]
        if not any(r.get("agentScript") == FILES["network/privacy-agent.mjs"][3] and r.get("newPid") == pa.get("pid") and r.get("newStart") == pa.get("start") for r in ra):
            refuse.append("the running privacy agent is not the one --restart-agent started on the new bundle (no matching restart-agent receipt)")
        if refuse: print(json.dumps({"refused": refuse}, indent=1)); return 2
        mode, run = "cutover", ts.lower() + "-" + uuid.uuid4().hex[:6]
    else:
        run0 = o.rollback_cutover; rec = OUT / f"cutover-result-{run0}.json"
        if not rec.exists(): raise SystemExit(f"{rec}: the cutover's own result receipt (with its journal) is required")
        r0 = json.loads(rec.read_text()); lines = [json.loads(l) for l in r0["journal"]["lines"]]
        bk = next((l for l in lines if l.get("step") == "backups"), None); fl = next((l for l in lines if l.get("step") == "flag"), {}); cf = next((l for l in lines if l.get("step") == "config"), {})
        if not bk: raise SystemExit("the cutover journal has no backups step: nothing to restore")
        mode, run = "rollback", run0 + "-rb"
    params = {"stage": stage, "runId": run, "boundSec": BOUND_S, "runner": RUNNER, "runNodeSha": RUN_NODE, "nodeExe": NODE_EXE, "nodeSha": NODE_SHA,
              "localSha": i.get("local"), "cfgSha": i.get("cfg"), "lease": dict(LEASE),
              "files": [{"path": v[1], "sha": v[3]} for v in FILES.values()] + [{"path": p, "sha": h} for p, h in KEEP.items()],
              "node": {"cmdPid": i["cmd"][0]["pid"], "cmdStart": i["cmd"][0]["start"], "agentPid": i["agent"][0]["pid"], "agentStart": i["agent"][0]["start"]},
              "manager": i["manager"], "privacy": i["privacy"][0], "vms": i["vms"], "hyperv": i["hyperv"], "expectedIds": pre["coverage"]["expectedIds"]}
    if mode == "rollback":
        params["before"] = {"local": {"before": r0["params"]["localSha"], "after": fl.get("after", ""), "backup": bk["localBackup"]},
                            "cfg": {"before": r0["params"]["cfgSha"], "after": cf.get("after", ""), "backup": bk["cfgBackup"]}}
    OUT.mkdir(exist_ok=True); pfile = OUT / f"params-{run}.json"; pfile.write_text(json.dumps(params, indent=1)); psha = sha(pfile)
    remote_p = stage + f"\\params-{run}.json"
    if not attempt(f"attempt-{mode}-{run}.json", {"params": params, "paramsSha": psha}): return 4
    c = subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", str(pfile), "minipc:/" + remote_p.replace("\\", "/")], capture_output=True, text=True)
    if c.returncode: save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "error": "params upload failed", "stderr": c.stderr[-300:]}); return 3
    ps1 = stage + "\\node-hold-cutover.ps1"; jx = stage + f"\\cutover-{run}.jsonl"
    loader = (LOADER.replace("PS1X", ps1).replace("PSHA", SCRIPTS["node-hold-cutover.ps1"][1]).replace("PFX", remote_p).replace("PFSHA", psha)
              .replace("MODEX", mode))
    enc = base64.b64encode(loader.encode("utf-16-le")).decode()
    r = m.ps(LAUNCH.replace("TNX", q("node-hold-" + run)).replace("PS1Q", q(ps1)).replace("PFQ", q(remote_p)).replace("PSHA", SCRIPTS["node-hold-cutover.ps1"][1])
             .replace("PFSHA", psha).replace("ENCX", enc), 90)
    print(json.dumps({"launch": r, "runId": run}, indent=1))
    if r.get("decision") != "started": save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "launch": r}); return 3
    # poll the journal (read-only) until a final line or the bound; a disconnect here does not stop the remote task
    end, j = time.time() + o.poll_sec, {}
    while time.time() < end:
        time.sleep(20); j = m.ps(JOURNAL.replace("JX", q(jx)).replace("TNX", q("node-hold-" + run)), 60)
        if any('"final"' in l for l in j.get("lines", [])): break
    rec = save(f"{mode}-result-{run}.json", {"what": "result", "at": now(), "runId": run, "params": params, "launch": r, "journal": j})
    fin = [json.loads(l)["final"] for l in j.get("lines", []) if '"final"' in l]
    print(json.dumps({"final": fin, "receipt": str(rec)}, indent=1))
    if not fin: print(f"NO FINAL YET: the task may still run. Inspect with --status --run-id {run}; NEVER start another cutover meanwhile.")
    kind = classify(fin[-1]) if fin else None
    print(OUTCOME.get(kind, ""))
    return 0 if kind == "done" else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
