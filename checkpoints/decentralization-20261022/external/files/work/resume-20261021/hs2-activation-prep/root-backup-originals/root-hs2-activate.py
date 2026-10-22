#!/usr/bin/env python3
"""ROOT helper: activate the INSTALLED (never started) minipc host-services stage hs2. PREPARED by claude; NOT run.

  python3 root-hs2-activate.py                 dry-run (default; read-only): local pins + remote preflight + the plan
  python3 root-hs2-activate.py --transfer      copy ONLY the manifest's 1,872 snapshot files (9.38 GB, sha256-verified
                                               locally) to C:\\ProgramData\\Enclave\\staging\\hs2-artifacts-20261021 (resumable)
  python3 root-hs2-activate.py --fill          fill-data artifacts --from-dir <staging> (the stage tool re-verifies
                                               every sha256; no network origin) + fill-data policy (unanchored: writes nothing)
  python3 root-hs2-activate.py --start         start.ps1 (task start + stage-1 health, 600 s) + health.ps1 + loopback-only
                                               proof; ANY failure -> stop.ps1 (back to installed-not-started, data kept)
  python3 root-hs2-activate.py --cleanup       remove the staging copy (only this helper's marked dir; artifacts complete)
  python3 root-hs2-activate.py --stop          stop.ps1 (graceful; proves no stage port listens)
  python3 root-hs2-activate.py --rollback [--keep-data]   the package's rollback.ps1 (pre-install state) + the staging copy
Exit: 0 ok | 2 refused before any change | 3 failed and returned to the previous safe state | 4 CRITICAL, inspect now.
Every phase re-runs the read-only preflight first. Nothing reads a key, env, customer DB or private artifact; no port,
firewall, DNS or advertisement changes (stage 1 binds 127.0.0.1 only; this is enforced after start). Receipts: ./receipts/
"""
import base64, datetime, hashlib, json, os, pathlib, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hs2lib as L

HERE = pathlib.Path(__file__).resolve().parent
W = HERE.parent.parent
ARCHIVE = W / "hosted-services-activation/final-r3/out/enclave-host-services-hs2-windows.tar"
STAGE = W / "hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows"
SNAP = W / "adapter-retained"
HOST = "minipc"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST]

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def local_pins():
    """Local evidence the plan stands on: the archive, the extracted stage (STAGE-SHA256SUMS), the manifest, the snapshot."""
    if sha(ARCHIVE) != L.PINS["archiveSha256"]: raise SystemExit("REFUSED: the stage archive is not the pinned one")
    sums = {}
    for line in (STAGE / "STAGE-SHA256SUMS").read_text().splitlines():
        h, p = line.split("  ", 1)
        if sha(STAGE / p) != h: raise SystemExit(f"REFUSED: the local stage differs from STAGE-SHA256SUMS: {p}")
        sums[p] = h
    m = STAGE / "data/bootstrap-manifest.json"
    if sha(m) != L.PINS["manifestSha256"]: raise SystemExit("REFUSED: the manifest is not the pinned one")
    manifest = json.loads(m.read_text())
    local = {}
    for e in manifest["verifiedObjects"]:
        for ext in ("bin", "car"):
            p = SNAP / f"{e['cid']}.{ext}"
            if not p.is_file(): raise SystemExit(f"REFUSED: the local snapshot lacks {p.name}")
            local[p.name] = p.stat().st_size
            if ext == "bin" and local[p.name] != e["bytes"]: raise SystemExit(f"REFUSED: {p.name} is not the manifest's size")
    ver = json.loads((HERE / "verify-snapshot.json").read_text())
    if not (ver.get("ok") and ver.get("filesVerified") == 2 * L.PINS["objects"]): raise SystemExit("REFUSED: no full sha256 verification of the snapshot (verify-snapshot.py)")
    return {s: sums[s] for s in L.SCRIPTS}, local

WATCH = r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$p.WaitForExit(@MS@)|Out-Null;if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''

def ps(script, seconds):
    """One bounded elevated PowerShell session over the existing SSH transport, with an in-session watchdog."""
    full = WATCH.replace("@MS@", str(seconds * 1000)) + "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script + "} finally {if(!$watcher.HasExited){$watcher.Kill()}}"
    enc = base64.b64encode(full.encode("utf-16le")).decode()
    assert len(enc) < 30000, "remote command too long"
    r = subprocess.run(SSH + ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], capture_output=True, text=True, timeout=seconds + 60)
    out = {}
    for line in r.stdout.splitlines():
        if line.startswith("RESULT "): out = json.loads(line[7:])
    return r.returncode, out, r.stdout

PROBE = r'''$o=[ordered]@{}
$os=Get-CimInstance Win32_OperatingSystem;$o.freeRamMiB=[int][math]::Floor($os.FreePhysicalMemory/1024)
$o.freeDiskMiB=[int][math]::Floor((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)
$ports=@(18188,18189,18153,18154,18190)
$tl=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object {$ports -contains $_.LocalPort});$ul=@(Get-NetUDPEndpoint -ErrorAction SilentlyContinue|Where-Object {$ports -contains $_.LocalPort})
$o.tcpListenOnStagePorts=$tl.Count;$o.udpOnStagePorts=$ul.Count
$o.listeners=@(@($tl|ForEach-Object {'tcp|'+$_.LocalAddress+'|'+$_.LocalPort})+@($ul|ForEach-Object {'udp|'+$_.LocalAddress+'|'+$_.LocalPort}))
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue
if($t){$o.taskState=[string]$t.State;$o.taskRealTriggers=[int]@($t.Triggers|Where-Object {$_ -ne $null}).Count;$o.taskPrincipal=[string]$t.Principal.UserId}else{$o.taskState='absent'}
$cfg='C:\ProgramData\Enclave\host-services\hs2\config';$data='C:\ProgramData\Enclave\host-services\hs2\data'
$r=Join-Path $cfg 'install-receipt.txt'
if(Test-Path -LiteralPath $r){$lines=@(Get-Content -LiteralPath $r);$o.receiptLast=[string]$lines[-1];$o.receiptSha256=(Get-FileHash -LiteralPath $r -Algorithm SHA256).Hash.ToLower();$ok=0;$bad=@()
 foreach($l in $lines){if($l -match '^file ([0-9a-f]{64}) (.+)$'){if((Test-Path -LiteralPath $Matches[2]) -and (Get-FileHash -LiteralPath $Matches[2] -Algorithm SHA256).Hash.ToLower() -eq $Matches[1]){$ok++}else{$bad+=$Matches[2]}}};$o.receiptFilesMatch=$ok;$o.receiptFilesBad=$bad.Count}
foreach($f in @(@('hostServicesJson','host-services.json'),@('supervisorJson','supervisor.json'))){$p=Join-Path $cfg $f[1];if(Test-Path -LiteralPath $p){$o[$f[0]]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}}
$m=Join-Path $data 'bootstrap-manifest.json';if(Test-Path -LiteralPath $m){$o.manifestSha256=(Get-FileHash -LiteralPath $m -Algorithm SHA256).Hash.ToLower()}
$a=Join-Path $data 'artifacts';if(Test-Path -LiteralPath $a){$fs=@(Get-ChildItem -LiteralPath $a -File);$obj=@($fs|Where-Object {$_.Name -match '^[a-z0-9]{20,120}\.(bin|car)$'});$o.artifactsFiles=$obj.Count;$o.artifactsOther=$fs.Count-$obj.Count;$o.artifactsBytes=[long](($obj|Measure-Object -Property Length -Sum).Sum)}else{$o.artifactsFiles=0;$o.artifactsOther=0;$o.artifactsBytes=0}
$o.hs2NodeProcesses=[int]@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -like '*host-services\hs2*'}).Count
$o.supervisorProcesses=[int]@(Get-Process -Name hostsvc-supervisor -ErrorAction SilentlyContinue).Count
$o.node=[string](& 'C:\Program Files\nodejs\node.exe' --version)
$sd='@STAGE@';$o.scripts=[ordered]@{};foreach($s in @(@SCRIPTS@)){$p=Join-Path $sd ($s -replace '/','\');if(Test-Path -LiteralPath $p){$o.scripts[$s]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}}
$sg='@STAGING@';if(Test-Path -LiteralPath $sg){$mk=Join-Path $sg '.hs2-artifacts-snapshot';$o.stagingMarker=$(if(Test-Path -LiteralPath $mk){([IO.File]::ReadAllText($mk)).Trim()}else{''});$o.staging=@(Get-ChildItem -LiteralPath $sg -File -Force|ForEach-Object {$_.Name+'|'+$_.Length})}else{$o.staging=$null;$o.stagingMarker=$null}
$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());$o.sessionElevated=[bool]$pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o.at=[DateTime]::UtcNow.ToString('o')
'RESULT '+($o|ConvertTo-Json -Compress -Depth 4)'''.replace("@STAGE@", L.STAGE_DIR).replace("@STAGING@", L.STAGING).replace("@SCRIPTS@", ",".join(f"'{s}'" for s in L.SCRIPTS))

def probe():
    rc, out, raw = ps(PROBE, 120)
    if rc != 0 or not out: raise SystemExit(f"REFUSED: the read-only probe failed (ssh {rc})")
    out["staging"] = None if out.get("staging") is None else {x.rsplit("|", 1)[0]: int(x.rsplit("|", 1)[1]) for x in out["staging"]}
    out["listeners"] = [(x.split("|")[0], x.split("|")[1], int(x.split("|")[2])) for x in out.get("listeners") or []]
    return out

ENTER = "Set-Location -LiteralPath '" + L.STAGE_DIR + "';Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force;$lg='C:\\ProgramData\\Enclave\\staging\\hs2-activation-logs-20261021';New-Item -ItemType Directory -Force -Path $lg|Out-Null;"
TAIL = r"function Tail($f){$x=@(Get-Content -LiteralPath $f);$i=[array]::LastIndexOf($x,'{');if($i -ge 0){($x[$i..($x.Count-1)]) -join [char]10}else{''}};"

def receipt(phase, o):
    d = HERE / "receipts"; d.mkdir(exist_ok=True)
    o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "phase": phase, "helperSha256": sha(__file__), "libSha256": sha(HERE / "hs2lib.py"), **o}
    p = d / f"{phase}-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    p.write_text(json.dumps(o, indent=1, default=str) + "\n"); print(json.dumps({k: o[k] for k in o if k in ("phase", "exit", "result", "refusals")}, indent=1, default=str)); return p

def done(phase, code, result, **kw):
    receipt(phase, {"exit": code, "result": result, **kw}); sys.exit(code)

def fill_done():
    return any(json.loads(p.read_text()).get("exit") == 0 for p in (HERE / "receipts").glob("fill-*.json")) if (HERE / "receipts").exists() else False

def main():
    args = sys.argv[1:]
    phase = next((a[2:] for a in args if a in ("--transfer", "--fill", "--start", "--cleanup", "--stop", "--rollback")), "dry-run")
    if not L.staging_path_ok(): raise SystemExit("REFUSED: staging path guard")
    scripts, local = local_pins()
    pre = probe()
    refusals = L.evaluate(pre, phase, local_sizes=local, script_sums=scripts, fill_done=fill_done())
    slim = {k: v for k, v in pre.items() if k != "staging"} | {"stagingFiles": None if pre["staging"] is None else len(pre["staging"])}
    if refusals: done(phase, 2, "REFUSED before any change", refusals=refusals, preflight=slim)
    if phase == "dry-run":
        to_send, _ = L.plan_transfer(local, pre["staging"], pre.get("stagingMarker"))
        done(phase, 0, "DRY-RUN OK: nothing changed", preflight=slim, transferPending=len(to_send), transferPendingBytes=sum(local[n] for n in to_send),
             next=("transfer" if to_send else "fill" if pre.get("artifactsFiles") != 2 * L.PINS["objects"] else "start"))
    if phase == "transfer":
        if pre["staging"] is None:
            rc, out, _ = ps(f"New-Item -ItemType Directory -Path '{L.STAGING}'|Out-Null;[IO.File]::WriteAllText('{L.STAGING}\\{L.MARKER}','{L.PINS['manifestSha256']}');'RESULT '+(@{{created=$true}}|ConvertTo-Json -Compress)", 60)
            if rc != 0 or not out.get("created"): done(phase, 4, "CRITICAL: could not create the staging dir")
            pre = probe()
        to_send, refs = L.plan_transfer(local, pre["staging"], pre.get("stagingMarker"))
        if refs: done(phase, 2, "REFUSED", refusals=refs)
        dest = HOST + ":" + L.STAGING.replace("\\", "/") + "/"
        for i in range(0, len(to_send), 48):
            batch = [str(SNAP / n) for n in to_send[i:i + 48]]
            r = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", *batch, dest], capture_output=True, text=True, timeout=3600)
            if r.returncode != 0: done(phase, 3, f"scp failed at batch {i // 48} (resumable: run --transfer again)", stderr=r.stderr[-400:])
        post = probe()
        if not L.staging_complete(local, post["staging"], post.get("stagingMarker")): done(phase, 3, "the staging copy is still incomplete (resumable: run --transfer again)")
        done(phase, 0, f"TRANSFERRED: staging holds all {len(local)} snapshot files", sent=len(to_send))
    if phase == "fill":
        s = ENTER + TAIL + (f"& .\\windows\\fill-data.ps1 artifacts -ToolArgs '--from-dir','{L.STAGING}' *> (Join-Path $lg 'fill-artifacts.log');$a=$LASTEXITCODE;"
             "& .\\windows\\fill-data.ps1 policy *> (Join-Path $lg 'fill-policy.log');$p=$LASTEXITCODE;"
             "'RESULT '+(@{artRc=$a;art=(Tail (Join-Path $lg 'fill-artifacts.log'));polRc=$p;pol=(Tail (Join-Path $lg 'fill-policy.log'))}|ConvertTo-Json -Compress)")
        rc, out, _ = ps(s, 3600)
        post = probe()
        art, pol = L.parse_tool_json(out.get("art") or ""), L.parse_tool_json(out.get("pol") or "")
        bad = ([f"remote session exit {rc}"] if rc else []) + L.validate_fill(out.get("artRc"), art, out.get("polRc"), pol, post.get("artifactsFiles"), post.get("artifactsOther", 0))
        if bad: done(phase, 3, "FILL NOT COMPLETE (nothing started; fill is idempotent: re-run --fill after fixing)", refusals=bad, art=art, pol=pol)
        done(phase, 0, "FILLED: 1,872 verified object files; policy " + str(pol.get("state")), art=art, pol=pol)
    if phase == "start":
        s = ENTER + ("& .\\windows\\start.ps1 -WaitSeconds 600 *> (Join-Path $lg 'start.log');$s=$LASTEXITCODE;"
             "& .\\windows\\health.ps1 *> (Join-Path $lg 'health.log');$h=$LASTEXITCODE;"
             "$hl=@(Get-Content -LiteralPath (Join-Path $lg 'health.log')|Where-Object {$_ -match '^(PASS|FAIL)'}|ForEach-Object {$_.Substring(0,[Math]::Min(300,$_.Length))});"
             "'RESULT '+(@{startRc=$s;healthRc=$h;health=$hl}|ConvertTo-Json -Compress)")
        rc, out, _ = ps(s, 1200)
        post = probe()
        bad = ([f"remote session exit {rc}"] if rc else []) + L.validate_start(out.get("startRc"), out.get("health") or [], post["listeners"], post.get("taskState"))
        if not bad: done(phase, 0, "STARTED: task Running, stage-1 health all PASS, loopback-only", health=out.get("health"), listeners=post["listeners"])
        src, _, _ = ps(ENTER + "& .\\windows\\stop.ps1 *> (Join-Path $lg 'stop-after-failed-start.log');'RESULT '+(@{stopRc=$LASTEXITCODE}|ConvertTo-Json -Compress)", 180)
        after = probe()
        safe = after.get("taskState") == "Ready" and not after["listeners"] and after.get("hs2NodeProcesses") == 0
        done(phase, 3 if safe else 4, ("START FAILED; stopped again (installed, not started; data kept)" if safe else "CRITICAL: start failed AND the stop did not return to a quiet stage"),
             refusals=bad, health=out.get("health"), afterStop={k: after.get(k) for k in ("taskState", "listeners", "hs2NodeProcesses", "supervisorProcesses")})
    if phase == "cleanup":
        if pre["staging"] is None: done(phase, 0, "nothing to clean: no staging dir")
        rc, out, _ = ps(f"$sg='{L.STAGING}';if(([IO.File]::ReadAllText((Join-Path $sg '{L.MARKER}'))).Trim() -ne '{L.PINS['manifestSha256']}'){{throw 'marker mismatch'}};Remove-Item -LiteralPath $sg -Recurse -Force;'RESULT '+(@{{removed=-not (Test-Path -LiteralPath $sg)}}|ConvertTo-Json -Compress)", 300)
        done(phase, 0 if out.get("removed") else 4, "staging copy removed" if out.get("removed") else "CRITICAL: staging removal incomplete")
    if phase == "stop":
        rc, out, _ = ps(ENTER + "& .\\windows\\stop.ps1 *> (Join-Path $lg 'stop.log');'RESULT '+(@{stopRc=$LASTEXITCODE}|ConvertTo-Json -Compress)", 180)
        after = probe()
        ok = out.get("stopRc") == 0 and after.get("taskState") == "Ready" and not after["listeners"]
        done(phase, 0 if ok else 4, "STOPPED (installed, not started)" if ok else "CRITICAL: stop did not return to a quiet stage", after={k: after.get(k) for k in ("taskState", "listeners", "hs2NodeProcesses")})
    if phase == "rollback":
        keep = " -KeepData" if "--keep-data" in args else ""
        rc, out, _ = ps(ENTER + f"& .\\windows\\rollback.ps1{keep} *> (Join-Path $lg 'rollback.log');'RESULT '+(@{{rbRc=$LASTEXITCODE}}|ConvertTo-Json -Compress)", 600)
        if out.get("rbRc") != 0: done(phase, 4, f"rollback.ps1 exit {out.get('rbRc')} (4 = a changed installed file was KEPT; see its log)")
        if pre["staging"] is not None and pre.get("stagingMarker") == L.PINS["manifestSha256"]:
            ps(f"Remove-Item -LiteralPath '{L.STAGING}' -Recurse -Force;'RESULT '+(@{{ok=$true}}|ConvertTo-Json -Compress)", 300)
        done(phase, 0, "ROLLED BACK to the pre-install state" + (" (data kept)" if keep else ""))

if __name__ == "__main__":
    main()
