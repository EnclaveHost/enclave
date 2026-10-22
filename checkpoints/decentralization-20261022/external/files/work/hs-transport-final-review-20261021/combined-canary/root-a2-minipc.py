#!/usr/bin/env python3
"""ROOT-ONLY: minipc side of the combined canary (A2). PREPARED by reviewer 9d; NEVER run by 9d.
Transport: the reviewed nucbox-tls-20261021/root-activate-reviewed.py (m.ps: in-session watchdog, encoded <= 7900).
Single-file JS swaps and the Node-agent restart reuse root's REVIEWED scripts from cron-startup-20261021/respawn-activation,
staged and executed only from hash-verified bytes: bundle-swap.ps1 21d85c69 (CAS, private backup, node --check, rollback)
and node-restart.ps1 beac40d9 (identity-pinned restart of \\Enclave\\Node only). The only new remote code is PUT below: a CAS
put for what bundle-swap cannot take (a NEW file: target 'absent'; enclave-wg.exe: not JS and > 8 MiB).

  root-a2-minipc.py                                       read-only preflight -> root-runs/a2-preflight-*.json
  root-a2-minipc.py --stage --preflight P                 NEW C:\\ProgramData\\Enclave\\staging\\a2-<uuid12>: scripts + 7 files, sha-verified
  root-a2-minipc.py --apply control|network --stage-receipt S        CAS file changes of ONE group (no restart)
  root-a2-minipc.py --restart node --stage-receipt S --preflight P   node-restart.ps1 with the preflight's identities (+ gates)
  root-a2-minipc.py --restart agent --preflight P                    the agent's own restart: stop THE privacy agent (pid+start
                                                                     pinned); the \\Enclave\\Network task starts it again in 10 s
  root-a2-minipc.py --config http|dns|none --preflight P             CAS edit of privacy-config.json enclaveNetwork.hostServices
  root-a2-minipc.py --rollback control|network --stage-receipt S     CAS back to the old bytes (reverse order)
Groups: control = network-enroll.mjs (B2: keeps hostServices) + its 2 new imports; network = privacy agent, worker, ingress
worker, enclave-wg.exe. Every mutating call: attempt record (O_EXCL) BEFORE the remote call; an existing record refuses.
Never read: config values (only sha, key names, hostServices), logs (except the pattern COUNT in root's restart gate), keys.
"""
import argparse, calendar, hashlib, importlib.util, json, os, pathlib, subprocess, sys, time, uuid

HERE = pathlib.Path(__file__).resolve().parent
W = HERE.parent.parent
OUT = HERE / "root-runs"
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
R = W / "cron-startup-20261021/respawn-activation"
SCRIPTS = {"bundle-swap.ps1": (R / "bundle-swap.ps1", "21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103"),
           "node-restart.ps1": (R / "node-restart.ps1", "beac40d93de8378d2b1c36129dd9e74cde0a16a9837b9cfc68a0a55777c517d3")}
RUN_NODE = "3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686"
C5, ST = W / "host-service-tls-20261021/compose5", W / "host-service-transport-20261021/stage/network"
PF = r"C:\Program Files\Enclave"
FILES = {  # key: local file, target, old sha ('absent' = new file), new sha, how
    "hsn":     (C5 / "network/host-service-names.mjs", PF + r"\control\network\host-service-names.mjs", "absent",
                "08bda1e6dab058cbad50eed9c4f03997dd3ae9fdfd5c021ab6fdefe785f62b80", "put"),
    "hst":     (C5 / "network/host-service-transport.mjs", PF + r"\control\network\host-service-transport.mjs", "absent",
                "e75f033152f4c26e08e7a965a961729acf303f36aa49ce75170a66a6beb26e5c", "put"),
    "enroll":  (C5 / "windows/node/network-enroll.mjs", PF + r"\control\windows\node\network-enroll.mjs",
                "2d97a0e10e40ceaa0be897708dc3cfa48742619450605efc107b22674caae2ac", "ab947363f5fda0bc2ffd52ce6a77ae75cf0886a8c8f035e512298c9224e95f9d", "swap"),
    "agent":   (ST / "privacy-agent.mjs", PF + r"\network\privacy-agent.mjs",
                "3883f67ce2414a1c328bd8ead7e46fea071e5e6e86c95a866070bb3241888cd6", "dce66106ebd384a0f171ff60149318337f564640df5b6556809daf351a8b15bc", "swap"),
    "worker":  (ST / "windows-circuit-worker.mjs", PF + r"\network\windows-circuit-worker.mjs",
                "c52025ba7f63d514023f29c8a0c54cec53725522fa270aaaaad308f84a07910d", "13ce44f1b39d4521e32266f2dad234958af70b1b05e2a3f6638535571e8cf320", "swap"),
    "ingress": (ST / "host-service-ingress.mjs", PF + r"\network\host-service-ingress.mjs", "absent",
                "d2abbd157a7019799bba26c49cd7bbfe3eb732e96e3df7dc13e7284f985c3c0b", "put"),
    "wg":      (ST / "enclave-wg.exe", PF + r"\network\enclave-wg.exe",
                "cbaf8313ce4e2cfce347abed99bdeaf5fc0631b8ab07bfbab20471f60920264c", "dea45347af329bdde8a3d9011e712c27ed38985cd123d9749cad5d27a45d5c89", "put"),
}
GROUPS = {"control": ["hsn", "hst", "enroll"], "network": ["agent", "worker", "ingress", "wg"]}
CFG = r"C:\ProgramData\Enclave\network\privacy-config.json"
HS = {"http": {"zone": "app.enclave.host", "exits": ["c4c7888e4741dcbe2c092dd81e888bf7"],
               "ports": {"directory-replica": 18188, "bootstrap-replica": 18189, "policy-mirror": 18190}}}   # blocks/host-services.http.json
HS["dns"] = {**HS["http"], "dns": {"tcp": 18153, "udp": 18153}}                                            # blocks/host-services.dns.json
WORKER = PF + r"\network\host-service-ingress.mjs"   # network-enroll's serviceWorkerModule: path.join(binDir, "host-service-ingress.mjs")
FRESH_S = 1800
q = lambda v: "'" + str(v).replace("'", "''") + "'"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

PRE = UTF8 = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
PRE += (r"$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');files=[ordered]@{}};foreach($x in @(TARGETS)){$o.files[$x]=FileSha $x};"
        r"$o.tasks=@(Get-ScheduledTask -TaskPath '\Enclave\'|ForEach-Object{$_.TaskName+'='+[string]$_.State});"
        r"$pa=@(Get-CimInstance Win32_Process -Filter ('Name=''node.exe''') -OperationTimeoutSec 20|Where-Object{[string]$_.CommandLine -match 'privacy-agent\.mjs'});"
        r"$o.privacyAgent=@($pa|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o')}});"
        r"$o.wgCount=@(Get-CimInstance Win32_Process -Filter ('Name=''enclave-wg.exe''') -OperationTimeoutSec 20).Count;"
        r"$o.cfgSha=FileSha 'CFGX';$c=[IO.File]::ReadAllText('CFGX')|ConvertFrom-Json;$o.enKeys=@($c.enclaveNetwork.PSObject.Properties.Name);$o.hostServices=$c.enclaveNetwork.hostServices;"
        r"$o.hs2Config=FileSha 'C:\ProgramData\Enclave\host-services\hs2\config\host-services.json';$o|ConvertTo-Json -Depth 6 -Compress")
PUT = UTF8 + (  # CAS put of ONE public program file (old 'absent' = new file); backup of the old bytes in a SYSTEM+Admins-only dir
    r"$t=TX;$s=SX;$old=OX;$new=NX;$pv=PX;$o=[ordered]@{target=FileSha $t;staged=FileSha $s};"
    r"if($o.target -eq $new){$o.decision='noop: already new'}elseif($o.target -ne $old){$o.decision='refused: CAS (target is not old)'}elseif($o.staged -ne $new){$o.decision='refused: staged is not new'}else{"
    r"if($old -ne 'absent'){if(-not(Test-Path -LiteralPath $pv)){$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false);"
    r"foreach($x in 'S-1-5-18','S-1-5-32-544'){$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $x),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};[void][IO.Directory]::CreateDirectory($pv,$ds)};"
    r"$b=Join-Path $pv ('backup-'+$old.Substring(0,12));if((FileSha $b) -eq 'absent'){Copy-Item -LiteralPath $t -Destination $b};if((FileSha $b) -ne $old){throw 'backup is not old'}};"
    r"$tmp=$t+'.new-'+[guid]::NewGuid().ToString('N').Substring(0,8);Copy-Item -LiteralPath $s -Destination $tmp;if((FileSha $tmp) -ne $new){Remove-Item -LiteralPath $tmp -Force;throw 'copy is not new'};"
    r"try{if($old -eq 'absent'){[IO.File]::Move($tmp,$t)}else{$acl=Get-Acl -LiteralPath $t;[IO.File]::Replace($tmp,$t,[NullString]::Value);Set-Acl -LiteralPath $t -AclObject $acl}}"
    r"catch{Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue;$o.error=[string]$_.Exception.Message};"
    r"$o.after=FileSha $t;$o.decision=$(if($o.after -eq $new){'applied'}elseif($o.after -eq $old){'FAILED: unchanged'}else{'AMBIGUOUS'})};$o|ConvertTo-Json -Compress")
UNPUT = UTF8 + (  # CAS rollback of PUT: target == new -> the backup (or removal when old was 'absent')
    r"$t=TX;$old=OX;$new=NX;$pv=PX;$o=[ordered]@{target=FileSha $t};"
    r"if($o.target -eq $old){$o.decision='noop: already old'}elseif($o.target -ne $new){$o.decision='refused: CAS (target is not new)'}else{"
    r"try{if($old -eq 'absent'){Remove-Item -LiteralPath $t -Force}else{$b=Join-Path $pv ('backup-'+$old.Substring(0,12));if((FileSha $b) -ne $old){throw 'backup is not old'};"
    r"$tmp=$t+'.old-'+[guid]::NewGuid().ToString('N').Substring(0,8);Copy-Item -LiteralPath $b -Destination $tmp;$acl=Get-Acl -LiteralPath $t;[IO.File]::Replace($tmp,$t,[NullString]::Value);Set-Acl -LiteralPath $t -AclObject $acl}}"
    r"catch{$o.error=[string]$_.Exception.Message};$o.after=FileSha $t;$o.decision=$(if($o.after -eq $old){'rolled back'}elseif($o.after -eq $new){'FAILED: unchanged'}else{'AMBIGUOUS'})};$o|ConvertTo-Json -Compress")
# the privacy agent's own restart (windows/node/agent.mjs restartAgent): stop it; the \Enclave\Network task starts it in 10 s
AGENT = UTF8 + (
    r"$f=('Name=''node.exe''');$pa=@(Get-CimInstance Win32_Process -Filter $f -OperationTimeoutSec 20|Where-Object{[string]$_.CommandLine -match 'privacy-agent\.mjs'});$o=[ordered]@{wgBefore=@(Get-CimInstance Win32_Process -Filter ('Name=''enclave-wg.exe''')).Count};"
    r"if($pa.Count -ne 1 -or [int]$pa[0].ProcessId -ne PIDX -or $pa[0].CreationDate.ToUniversalTime().ToString('o') -ne STARTX){$o.decision='refused: the privacy agent is not the pinned PID+start'}else{"
    r"Stop-Process -Id PIDX -Force;$t0=Get-Date;$n=$null;while(((Get-Date)-$t0).TotalSeconds -lt 90 -and -not $n){Start-Sleep 3;$n=@(Get-CimInstance Win32_Process -Filter $f|Where-Object{[string]$_.CommandLine -match 'privacy-agent\.mjs' -and $_.ProcessId -ne PIDX})[0]};"
    r"if($n){$o.newPid=[int]$n.ProcessId;$o.newStart=$n.CreationDate.ToUniversalTime().ToString('o');$o.backAfterSec=[math]::Round(((Get-Date)-$t0).TotalSeconds,1);Start-Sleep 60;"
    r"$o.alive=$null -ne (Get-Process -Id $o.newPid -ErrorAction SilentlyContinue);$o.wgAfter60s=@(Get-CimInstance Win32_Process -Filter ('Name=''enclave-wg.exe''')).Count;$o.decision='restarted'}else{$o.decision='ROOT: no new privacy agent within 90 s'}};"
    r"$o.agentScript=FileSha 'C:\Program Files\Enclave\network\privacy-agent.mjs';$o|ConvertTo-Json -Compress")
# CAS edit of ONE key: enclaveNetwork.hostServices (+ serviceWorkerModule, exactly what network-enroll ab947363 writes), by
# node's own JSON; the bytes are written into a file that already carries the config's ACL, then [IO.File]::Replace
CONF = UTF8 + (
    r"$p='CFGX';$o=[ordered]@{before=FileSha $p};if($o.before -ne EXPX){$o.decision='refused: CAS (the config is not the expected sha)'}else{"
    r"$acl=Get-Acl -LiteralPath $p;$tmp=$p+'.hs-'+[guid]::NewGuid().ToString('N').Substring(0,8);[IO.File]::WriteAllBytes($tmp,[byte[]]@());Set-Acl -LiteralPath $tmp -AclObject $acl;"
    r"$ErrorActionPreference='Continue';$z=@(& 'C:\Program Files\Enclave\runtime\node\node.exe' -e ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('JSX'))) $p $tmp 2>&1);$rc=$LASTEXITCODE;$ErrorActionPreference='Stop';"
    r"if($rc -ne 0){Remove-Item -LiteralPath $tmp -Force;$o.decision='refused: '+([string]($z|Select-Object -Last 1))}"
    r"elseif((FileSha $p) -ne EXPX){Remove-Item -LiteralPath $tmp -Force;$o.decision='refused: changed during the edit (network-enroll pass): re-run the preflight'}else{"
    r"$bk=$p+'.before-hs-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss');[IO.File]::Replace($tmp,$p,$bk);"
    r"$o.after=FileSha $p;$o.aclKept=((Get-Acl -LiteralPath $p).Sddl -eq $acl.Sddl);$o.backup=$bk;$o.backupSha=FileSha $bk;$o.decision='edited (takes effect at the next privacy-agent restart)'}};$o|ConvertTo-Json -Compress")
# node writes INTO the pre-created temp file (it already carries the config's ACL); no double quote in the program (PS 5.1
# native argument quoting), the block and the worker path travel as base64
JS = (r"const fs=require('fs');const [p,t]=process.argv.slice(1);const d=(b)=>JSON.parse(Buffer.from(b,'base64').toString());const c=JSON.parse(fs.readFileSync(p,'utf8'));"
      r"const e=c.enclaveNetwork;const want=d('WANT');delete e.hostServices;delete e.serviceWorkerModule;if(want){e.hostServices=want;e.serviceWorkerModule=d('WORKERX');}"
      r"fs.writeFileSync(t,JSON.stringify(c,null,2)+String.fromCharCode(10));")

spec = importlib.util.spec_from_file_location("transport", T[0]); m = importlib.util.module_from_spec(spec)

def verify_local():
    bad = [str(p) for p, h in [T] + list(SCRIPTS.values()) if sha(p) != h] + [k for k, v in FILES.items() if sha(v[0]) != v[3]]
    if bad: raise SystemExit(f"local pins differ: {bad}")
    spec.loader.exec_module(m)

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", OUT / name)

def attempt(name, body):
    try: save(name, {"what": "attempt", "at": now(), **body}); return True
    except FileExistsError: print(f"REFUSED: {OUT / name} exists; an attempt is never retried automatically (root inspects, then moves it aside)"); return False

def fresh(path, what):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != what: raise SystemExit(f"{path} is not a {what} receipt")
    if time.time() - calendar.timegm(time.strptime(o["at"], "%Y-%m-%dT%H:%M:%SZ")) > FRESH_S: raise SystemExit(f"{path} is older than {FRESH_S} s")
    return o

def run_script(stage, name, params, secs):
    """root's staged script, executed only if its bytes are the pin (activate.py run_script)"""
    splat = "@{" + ";".join(f"{k}={v if isinstance(v, int) else q(v)}" for k, v in params.items()) + "}"
    return m.ps(f"$p={q(stage + chr(92) + name)};$b=[IO.File]::ReadAllBytes($p);$h=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace '-','').ToLower();"
                f"if($h -ne '{SCRIPTS[name][1]}'){{'{{\"decision\":\"refused: the staged {name} is not the pinned bytes\"}}';exit 0}};"
                f"$a={splat};& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) @a", secs)

def staged(stage, k): return stage + "\\files\\" + k + "-" + pathlib.Path(FILES[k][0]).name

def change(stage, k, back=False):
    src, tgt, old, new, how = FILES[k]
    if how == "swap":
        p = ({"Mode": "rollback", "Target": tgt, "WorkDir": stage + "\\swap-" + k, "OldSha": old, "ExpectCurrent": new} if back else
             {"Mode": "apply", "Target": tgt, "WorkDir": stage + "\\swap-" + k, "OldSha": old, "NewFile": staged(stage, k), "NewSha": new})
        r = run_script(stage, "bundle-swap.ps1", p, 150); d = str(r.get("decision", ""))
        return r, (d == "rolled back" or d.startswith("noop")) if back else (d.startswith("applied") or d.startswith("noop"))
    t = UNPUT if back else PUT
    r = m.ps(t.replace("TX", q(tgt)).replace("SX", q(staged(stage, k))).replace("OX", q(old)).replace("NX", q(new)).replace("PX", q(stage + "\\put-private")), 150)
    d = str(r.get("decision", ""))
    return r, (d == "rolled back" or d.startswith("noop")) if back else (d == "applied" or d.startswith("noop"))

def preflight():
    targets = ",".join(q(v[1]) for v in FILES.values())
    return m.ps(PRE.replace("TARGETS", targets).replace("CFGX", CFG), 90)

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group()
    x.add_argument("--stage", action="store_true"); x.add_argument("--apply", choices=list(GROUPS)); x.add_argument("--rollback", choices=list(GROUPS))
    x.add_argument("--restart", choices=["node", "agent"]); x.add_argument("--config", choices=["http", "dns", "none"])
    a.add_argument("--preflight"); a.add_argument("--stage-receipt"); a.add_argument("--max-pause-sec", type=int, default=120)
    a.add_argument("--coordinated-repair", default="", help="root-owned reason to restart the node agent despite a failed gate")
    o = a.parse_args(argv); verify_local(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not (o.stage or o.apply or o.rollback or o.restart or o.config):
        r = preflight(); f = r.get("files", {})
        state = {k: ("old" if f.get(v[1]) == v[2] else "new" if f.get(v[1]) == v[3] else f"UNKNOWN {f.get(v[1])}") for k, v in FILES.items()}
        save(f"a2-preflight-{ts}.json", {"what": "preflight", "at": now(), "result": r, "state": state})
        print(json.dumps({"state": state, "privacyAgent": r.get("privacyAgent"), "cfgSha": r.get("cfgSha"), "hostServices": r.get("hostServices"),
                          "hs2Config": r.get("hs2Config"), "error": r.get("error")}, indent=1))
        return 0 if "error" not in r and not any(s.startswith("UNKNOWN") for s in state.values()) else 1
    if o.stage:
        pre = fresh(o.preflight, "preflight"); d = r"C:\ProgramData\Enclave\staging\a2-" + uuid.uuid4().hex[:12]
        rec = {"what": "stage", "at": now(), "stage": d, "preflight": o.preflight}
        rec["mkdir"] = m.ps(f"$d={q(d)};if(Test-Path -LiteralPath $d){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $d;$null=New-Item -ItemType Directory -Path ($d+'\\files');@{{created=$d}}|ConvertTo-Json -Compress", 60)
        if rec["mkdir"].get("created") != d: save(f"a2-stage-{ts}.json", rec); raise SystemExit(f"stage not created: {rec['mkdir']}")
        ups = [(p, d + "\\" + n) for n, (p, _) in SCRIPTS.items()] + [(v[0], staged(d, k)) for k, v in FILES.items()]
        for src, dst in ups:
            c = subprocess.run(["timeout", "300", "scp", "-q", "-o", "BatchMode=yes", str(src), "minipc:/" + dst.replace("\\", "/")], capture_output=True, text=True)
            if c.returncode: rec["uploadFailed"] = {"file": dst, "stderr": c.stderr[-300:]}; break
        want = {d + "\\" + n: h for n, (_, h) in SCRIPTS.items()} | {staged(d, k): v[3] for k, v in FILES.items()}
        rec["verify"] = v = m.ps("$o=[ordered]@{};foreach($x in @(" + ",".join(q(p) for p in want) + ")){$o[$x]=FileSha $x};$o|ConvertTo-Json -Compress", 90)
        rec["ok"] = "uploadFailed" not in rec and all(v.get(p) == h for p, h in want.items())
        save(f"a2-stage-{ts}.json", rec); print(json.dumps(rec, indent=1)); return 0 if rec["ok"] else 4
    if o.apply or o.rollback:
        st = fresh(o.stage_receipt, "stage") if o.stage_receipt else None
        if not st or not st["ok"]: raise SystemExit("--stage-receipt: a passing stage receipt")
        g = o.apply or o.rollback; back = bool(o.rollback); name = f"attempt-a2-{'rollback' if back else 'apply'}-{g}.json"
        if not attempt(name, {"group": g, "rollback": back, "stage": st["stage"]}): return 4
        res, ok = {}, True
        for k in (reversed(GROUPS[g]) if back else GROUPS[g]):
            res[k], ok = change(st["stage"], k, back)
            if not ok: break
        save(f"a2-{'rollback' if back else 'apply'}-{g}-result-{ts}.json", {"what": "result", "at": now(), "attempt": name, "ok": ok, "steps": res, "post": preflight()})
        print(json.dumps(res, indent=1)); print("OK" if ok else "STOPPED at the first failure: ROOT reads the result; rollback is the CAS --rollback of this group")
        return 0 if ok else 3
    pre = fresh(o.preflight, "preflight") if o.preflight else None
    if not pre: raise SystemExit("--preflight <fresh a2 preflight receipt>")
    if o.restart == "agent":
        pa = pre["result"].get("privacyAgent") or []
        if len(pa) != 1: raise SystemExit("the preflight does not show exactly one privacy agent")
        if not attempt(f"attempt-a2-restart-agent-{pa[0]['pid']}.json", {"pid": pa[0]["pid"], "start": pa[0]["start"]}): return 4
        r = m.ps(AGENT.replace("PIDX", str(int(pa[0]["pid"]))).replace("STARTX", q(pa[0]["start"])), 240)
        save(f"a2-restart-agent-result-{ts}.json", {"what": "result", "at": now(), "result": r}); print(json.dumps(r, indent=1))
        return 0 if r.get("decision") == "restarted" and r.get("alive") else 3
    if o.restart == "node":
        st = fresh(o.stage_receipt, "stage") if o.stage_receipt else None
        if not st or not st["ok"]: raise SystemExit("--stage-receipt: a passing stage receipt")
        idn = run_script(st["stage"], "node-restart.ps1", {"Mode": "identify"}, 150); b = idn.get("before") or {}; mg = idn.get("manager") or {}
        if len(b.get("cmd", [])) != 1 or len(b.get("agent", [])) != 1 or not mg.get("pid"): raise SystemExit(f"identify: {idn}")
        # root's restart gates (activate.py restart_gates, read-only): no running lease < 10 min, no wallet-policy flap in 10 min
        gate = m.ps("$d=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/deployments';$all=@($d.deployments);if(-not $all){$all=@($d)};"
                    "$now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();$short=@($all|Where-Object{$_.status -eq 'running' -and $_.leaseUntil -and ([int64]$_.leaseUntil - $now) -lt 600}).Count;"
                    "$t=(Get-Date).ToUniversalTime().AddMinutes(-10).ToString('HH:mm');"
                    "$f=@(Get-Content -LiteralPath 'C:\\ProgramData\\Enclave\\logs\\node.log' -Tail 2000|Select-String -SimpleMatch 'host wallet policy unavailable'|ForEach-Object{$_.Line.Substring(0,5)}|Where-Object{$_ -ge $t}).Count;"
                    "[ordered]@{shortLeases=$short;policyUnavailableLast10min=$f}|ConvertTo-Json -Compress", 90)
        if not (gate.get("shortLeases") == 0 and gate.get("policyUnavailableLast10min") == 0) and not o.coordinated_repair.strip():
            raise SystemExit(f"refused: restart gates {gate} (root may pass --coordinated-repair '<reason>')")
        if not 30 <= o.max_pause_sec <= 180: raise SystemExit("--max-pause-sec 30..180")
        if not attempt(f"attempt-a2-restart-node-{b['agent'][0]['pid']}.json", {"identify": idn, "gate": gate, "coordinatedRepair": o.coordinated_repair}): return 4
        r = run_script(st["stage"], "node-restart.ps1", {"Mode": "restart", "ExpectRunNodeSha": RUN_NODE, "ExpectAgentPid": b["agent"][0]["pid"],
                       "ExpectAgentStart": b["agent"][0]["start"], "ExpectCmdPid": b["cmd"][0]["pid"], "ExpectCmdStart": b["cmd"][0]["start"],
                       "ExpectManagerPid": mg["pid"], "ExpectManagerStart": mg["start"], "MaxPauseSec": o.max_pause_sec}, 330)
        save(f"a2-restart-node-result-{ts}.json", {"what": "result", "at": now(), "result": r}); print(json.dumps(r, indent=1))
        return 0 if r.get("newAgent") and r.get("agentAnswers") else 3
    # --config: the expected sha is the preflight's; WANT is the canary block (or none = remove it)
    import base64
    b64 = lambda v: base64.b64encode(json.dumps(v).encode()).decode()
    want = HS.get(o.config); js = JS.replace("WANT", b64(want)).replace("WORKERX", b64(WORKER))
    if not attempt(f"attempt-a2-config-{o.config}-{pre['result']['cfgSha'][:12]}.json", {"config": o.config, "expect": pre["result"]["cfgSha"]}): return 4
    r = m.ps(CONF.replace("CFGX", CFG).replace("EXPX", q(pre["result"]["cfgSha"])).replace("JSX", base64.b64encode(js.encode()).decode()), 90)
    save(f"a2-config-{o.config}-result-{ts}.json", {"what": "result", "at": now(), "result": r, "post": preflight()}); print(json.dumps(r, indent=1))
    return 0 if str(r.get("decision", "")).startswith("edited") else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
