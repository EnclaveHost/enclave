#!/usr/bin/env python3
"""ROOT helper: activate the INSTALLED (never started) minipc host-services stage hs2. PREPARED by claude; NOT run.
(review-fix of 114fbbe6: start-safety, exact health, watchdog tree, pinned emergency stop without local inputs)

  python3 root-hs2-activate.py                 dry-run (default; read-only): local pins + remote preflight + the plan
  python3 root-hs2-activate.py --transfer      copy ONLY the manifest's 1,872 snapshot files (9.38 GB, sha256-verified
                                               locally) to C:\\ProgramData\\Enclave\\staging\\hs2-artifacts-20261021 (resumable)
  python3 root-hs2-activate.py --fill          fill-data artifacts --from-dir <staging> (the stage tool re-verifies
                                               every sha256; no network origin) + fill-data policy (unanchored: writes nothing)
  python3 root-hs2-activate.py --start         start.ps1 (task start + stage-1 health, 600 s) + health.ps1 (exactly the six
                                               expected checks, all PASS, exit 0) + loopback-only proof. ANY failure or
                                               exception -> emergency stop, then a fresh probe must PROVE the stage quiet
  python3 root-hs2-activate.py --cleanup       remove the staging copy (only this helper's marked dir; artifacts complete)
  python3 root-hs2-activate.py --stop          emergency/operator stop: needs NO local snapshot or stage files; runs the
                                               pinned stop.ps1, or (if any stop input drifted) only the built-in
                                               Stop-ScheduledTask for the exact pinned task; then proves the stage quiet
  python3 root-hs2-activate.py --rollback [--keep-data]   the package's rollback.ps1 (pre-install state) + the staging copy
Exit: 0 ok | 2 refused before any change | 3 failed and PROVEN back to the previous safe state | 4 CRITICAL, inspect now.
Every remote action re-checks, in the same PowerShell session right before it runs, the sha256 of each staged script and
installed binary it executes: a drifted file is never executed. Every remote session has a watchdog that kills its own
descendant process tree (not unrelated processes), then the session. No key, env, customer DB or private artifact is
read; no port, firewall, DNS or advertisement changes (stage 1 binds 127.0.0.1 only; enforced after start).
"""
import base64, datetime, gzip, hashlib, json, pathlib, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import hs2lib as L

HERE = pathlib.Path(__file__).resolve().parent
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work")
ARCHIVE = W / "hosted-services-activation/final-r3/out/enclave-host-services-hs2-windows.tar"
STAGE = W / "hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows"
SNAP = W / "adapter-retained"
VERIFIED = W / "resume-20261021/hs2-activation-prep/verify-snapshot.json"
HOST = "minipc"
SSH = ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST]
# this SSH route's measured -EncodedCommand ceiling is about 7900 characters (root-activate-reviewed.py, probe.py); kept below it
ENC_MAX = 7800

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def stage_pins():
    """Changing phases only: the archive and the extracted stage, and the embedded pins equal to its STAGE-SHA256SUMS."""
    if sha(ARCHIVE) != L.PINS["archiveSha256"]: raise SystemExit("REFUSED: the stage archive is not the pinned one")
    sums = {}
    for line in (STAGE / "STAGE-SHA256SUMS").read_text().splitlines():
        h, p = line.split("  ", 1)
        if sha(STAGE / p) != h: raise SystemExit(f"REFUSED: the local stage differs from STAGE-SHA256SUMS: {p}")
        sums[p] = h
    for k, v in {**L.SCRIPT_PINS, **L.BIN_PINS}.items():
        if sums.get(k) != v: raise SystemExit(f"REFUSED: the embedded pin of {k} is not the stage's")
    if sha(STAGE / "data/bootstrap-manifest.json") != L.PINS["manifestSha256"]: raise SystemExit("REFUSED: the manifest is not the pinned one")

def snapshot():
    """dry-run/transfer/fill only: the verified local snapshot (presence, manifest sizes, the recorded full sha256 run)."""
    manifest = json.loads((STAGE / "data/bootstrap-manifest.json").read_text())
    local = {}
    for e in manifest["verifiedObjects"]:
        for ext in ("bin", "car"):
            p = SNAP / f"{e['cid']}.{ext}"
            if not p.is_file(): raise SystemExit(f"REFUSED: the local snapshot lacks {p.name}")
            local[p.name] = p.stat().st_size
            if ext == "bin" and local[p.name] != e["bytes"]: raise SystemExit(f"REFUSED: {p.name} is not the manifest's size")
    ver = json.loads(VERIFIED.read_text())
    if not (ver.get("ok") and ver.get("filesVerified") == 2 * L.PINS["objects"]): raise SystemExit("REFUSED: no full sha256 verification of the snapshot")
    return local

# The watchdog: a separate process (outside the session's tree walk) that, after @MS@, kills every DESCENDANT of the
# session started after it (PID reuse cannot pull in an older, unrelated process), children before parents, then the
# session itself. Task Scheduler's own processes (the supervisor) are never descendants of this session.
# Each target is killed only if the PID still belongs to the SAME process (start time == the snapshot's CreationDate):
# a descendant that exited meanwhile cannot have its reused PID hit an unrelated process.
WATCHER = r'''$o=[Diagnostics.Process]::GetProcessById(@OWNER@);if(!$o.WaitForExit(@MS@)){$t0=$o.StartTime;$all=@(Get-CimInstance Win32_Process);$set=@{};$cr=@{};$set[[int]@OWNER@]=0;$d=0;do{$n=0;$d++;foreach($x in $all){$pp=[int]$x.ParentProcessId;$id=[int]$x.ProcessId;if($set.ContainsKey($pp) -and -not $set.ContainsKey($id) -and $id -ne $PID -and $x.CreationDate -ge $t0){$set[$id]=$d;$cr[$id]=$x.CreationDate;$n++}}}while($n);foreach($k in @($set.Keys|Sort-Object {-$set[$_]})){if($k -ne @OWNER@){try{$q=Get-Process -Id $k -ErrorAction Stop;if([math]::Abs(($q.StartTime-$cr[$k]).TotalSeconds) -lt 1){Stop-Process -Id $k -Force -ErrorAction Stop}}catch{}}};try{$o.Kill()}catch{}}'''
WATCH = r'''$ownerPid=$PID;$watchCode=('@WATCHER@').Replace('@OWNER@',[string]$ownerPid);$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''

def session(script, seconds):
    """The complete session text: the watchdog (started first, in this session), then the script, then the watchdog's
    release. Run as ONE process (Invoke-Expression in the bootstrap's own session), so $PID is the watched session."""
    return (WATCH.replace("@WATCHER@", WATCHER.replace("@MS@", str(seconds * 1000)).replace("'", "''"))
            + "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script + "} finally {if(!$watcher.HasExited){$watcher.Kill()}}")

BOOT = ("$z=New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('@GZ@'))),"
        "[IO.Compression.CompressionMode]::Decompress);$t=(New-Object IO.StreamReader($z,[Text.Encoding]::UTF8)).ReadToEnd();Invoke-Expression $t")

def encoded(script, seconds):
    """-EncodedCommand text: a small bootstrap carrying the gzip'd session (the route accepts about 7900 characters).
    Refuses (raises) rather than send a command the route would truncate or reject."""
    gz = base64.b64encode(gzip.compress(session(script, seconds).encode("utf-8"), 9, mtime=0)).decode()
    enc = base64.b64encode(BOOT.replace("@GZ@", gz).encode("utf-16le")).decode()
    if len(enc) > ENC_MAX: raise RuntimeError(f"remote command is {len(enc)} encoded characters (> {ENC_MAX}): not sent")
    return enc

def ps(script, seconds):
    """One bounded elevated PowerShell session over the existing SSH transport. Raises on transport failure/timeout."""
    enc = encoded(script, seconds)
    r = subprocess.run(SSH + ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], capture_output=True, text=True, timeout=seconds + 60)
    out = {}
    for line in r.stdout.splitlines():
        if line.startswith("RESULT "): out = json.loads(line[7:])
    return r.returncode, out, r.stdout

def verify_ps(action):
    """PowerShell: $pinsOk true only if every file `action` executes has its pinned sha256 (checked in this session)."""
    pairs = ";".join(f"@('{p}','{h}')" for p, h in L.pins_for(action))
    return ("$pinsOk=$true;$pinBad=@();foreach($q in @(" + pairs + ")){if(!(Test-Path -LiteralPath $q[0]) -or (Get-FileHash -LiteralPath $q[0] -Algorithm SHA256).Hash.ToLower() -ne $q[1]){$pinsOk=$false;$pinBad+=$q[0]}};")

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
$np=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -like '*host-services\hs2*'})
$o.hs2NodeProcesses=$np.Count;$o.stageToolProcesses=@($np|Where-Object {$_.CommandLine -like '*hs2\bin\stage-tool.mjs*'}).Count
$o.supervisorProcesses=[int]@(Get-Process -Name hostsvc-supervisor -ErrorAction SilentlyContinue).Count
$o.node=[string](& 'C:\Program Files\nodejs\node.exe' --version)
$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());$o.sessionElevated=[bool]$pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o.at=[DateTime]::UtcNow.ToString('o')
'RESULT '+($o|ConvertTo-Json -Compress -Depth 4)'''.replace("@STAGE@", L.STAGE_DIR).replace("@STAGING@", L.STAGING).replace("@SCRIPTS@", ",".join(f"'{s}'" for s in L.SCRIPTS))

PROBE_STAGING = (r"""$o=[ordered]@{};$sd='""" + L.STAGE_DIR + r"""';$o.scripts=[ordered]@{};foreach($s in @(""" + ",".join(f"'{x}'" for x in L.SCRIPTS) + r""")){$p=Join-Path $sd ($s -replace '/','\');if(Test-Path -LiteralPath $p){$o.scripts[$s]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}}
$sg='""" + L.STAGING + r"""';if(Test-Path -LiteralPath $sg){$mk=Join-Path $sg '.hs2-artifacts-snapshot';$o.stagingMarker=$(if(Test-Path -LiteralPath $mk){([IO.File]::ReadAllText($mk)).Trim()}else{''});$o.staging=@(Get-ChildItem -LiteralPath $sg -File -Force|ForEach-Object {$_.Name+'|'+$_.Length})}else{$o.staging=$null;$o.stagingMarker=$null}
""" + r"""
'RESULT '+($o|ConvertTo-Json -Compress -Depth 4)""")

class ProbeError(Exception): pass

def probe():
    rc, out, raw = ps(PROBE, 120)
    if rc != 0 or not out: raise ProbeError(f"the read-only probe failed (ssh {rc})")
    rc2, st, raw2 = ps(PROBE_STAGING, 120)
    if rc2 != 0 or not st or "stagingMarker" not in st: raise ProbeError(f"the read-only staging probe failed (ssh {rc2})")
    out["staging"], out["stagingMarker"] = st.get("staging"), st.get("stagingMarker")
    out["scripts"] = st.get("scripts") or {}
    out["staging"] = None if out.get("staging") is None else {x.rsplit("|", 1)[0]: int(x.rsplit("|", 1)[1]) for x in out["staging"]}
    out["listeners"] = [(x.split("|")[0], x.split("|")[1], int(x.split("|")[2])) for x in out.get("listeners") or []]
    return out

LOGS = "$lg='C:\\ProgramData\\Enclave\\staging\\hs2-activation-logs-20261021';New-Item -ItemType Directory -Force -Path $lg|Out-Null;"
ENTER = "Set-Location -LiteralPath '" + L.STAGE_DIR + "';Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force;" + LOGS
TAIL = r"function Tail($f){$x=@(Get-Content -LiteralPath $f);$i=[array]::LastIndexOf($x,'{');if($i -ge 0){($x[$i..($x.Count-1)]) -join [char]10}else{''}};"
REFUSED = "if(!$pinsOk){'RESULT '+(@{refused=$true;pinBad=$pinBad}|ConvertTo-Json -Compress)}else{"
FILL = (verify_ps("fill") + REFUSED + ENTER + TAIL
        + f"& .\\windows\\fill-data.ps1 artifacts -ToolArgs '--from-dir','{L.STAGING}' *> (Join-Path $lg 'fill-artifacts.log');$a=$LASTEXITCODE;"
        "& .\\windows\\fill-data.ps1 policy *> (Join-Path $lg 'fill-policy.log');$p=$LASTEXITCODE;"
        "'RESULT '+(@{artRc=$a;art=(Tail (Join-Path $lg 'fill-artifacts.log'));polRc=$p;pol=(Tail (Join-Path $lg 'fill-policy.log'))}|ConvertTo-Json -Compress)}")
START = (verify_ps("start") + REFUSED + ENTER
         + "& .\\windows\\start.ps1 -WaitSeconds 600 *> (Join-Path $lg 'start.log');$s=$LASTEXITCODE;"
         "& .\\windows\\health.ps1 *> (Join-Path $lg 'health.log');$h=$LASTEXITCODE;"
         "$hl=@(Get-Content -LiteralPath (Join-Path $lg 'health.log')|Where-Object {$_ -match '^(PASS|FAIL)'}|ForEach-Object {$_.Substring(0,[Math]::Min(300,$_.Length))});"
         "'RESULT '+(@{startRc=$s;healthRc=$h;health=$hl}|ConvertTo-Json -Compress)}")
# The emergency stop: no Set-Location (a missing stage dir must not prevent it), no local input. Pinned stop.ps1 when its
# inputs verify; otherwise ONLY the built-in Stop-ScheduledTask, and only for the exact task whose action is the pinned
# supervisor path (ending it ends the whole job tree: KILL_ON_JOB_CLOSE). Never a drifted script.
STOP = (verify_ps("stop") + "try{" + LOGS + "}catch{$lg=$env:TEMP};"
        "$t=Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue;"
        "if($pinsOk){Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force;& '" + L.remote_path("windows/stop.ps1") + "' *> (Join-Path $lg 'stop.log');$rc=$LASTEXITCODE;$mode='stop.ps1'}"
        "elseif($t -and [string]$t.Actions[0].Execute -eq '" + L.TASK_EXE + "'){if($t.State -eq 'Running'){Stop-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'enclave-host-services-hs2'};$rc=0;$mode='fallback-Stop-ScheduledTask'}"
        "elseif(-not $t){$rc=0;$mode='no-task'}else{$rc=5;$mode='refused-task-action-changed'};"
        "'RESULT '+(@{mode=$mode;stopRc=$rc;pinBad=$pinBad}|ConvertTo-Json -Compress)")
ROLLBACK = lambda keep: (verify_ps("rollback") + REFUSED + ENTER
        + f"& .\\windows\\rollback.ps1{keep} *> (Join-Path $lg 'rollback.log');'RESULT '+(@{{rbRc=$LASTEXITCODE}}|ConvertTo-Json -Compress)}}")

def receipt(phase, o):
    d = HERE / "receipts"; d.mkdir(exist_ok=True)
    o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "phase": phase, "helperSha256": sha(__file__), "libSha256": sha(HERE / "hs2lib.py"), **o}
    p = d / f"{phase}-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}.json"
    p.write_text(json.dumps(o, indent=1, default=str) + "\n"); print(json.dumps({k: o[k] for k in o if k in ("phase", "exit", "result", "refusals")}, indent=1, default=str)); return p

def done(phase, code, result, **kw):
    receipt(phase, {"exit": code, "result": result, **kw}); sys.exit(code)

def fill_done():
    d = HERE / "receipts"
    return d.exists() and any(json.loads(p.read_text()).get("exit") == 0 for p in d.glob("fill-*.json"))

def err(e): return f"{type(e).__name__}: {e}"[:300]

def emergency_stop(reason):
    """Never raises. Runs the pinned stop (or the built-in fallback), then PROVES quiet with a fresh probe (two tries)."""
    out, notes = {}, [reason]
    try: _, out, _ = ps(STOP, 240)
    except BaseException as e: notes.append("stop session: " + err(e))
    after = None
    for _ in range(2):
        try:
            after = probe()
            if L.quiet(after): break
        except BaseException as e: notes.append("verify probe: " + err(e)); after = None
    return {"quiet": L.quiet(after), "mode": out.get("mode"), "stopRc": out.get("stopRc"), "pinBad": out.get("pinBad"), "notes": notes,
            "after": None if after is None else {k: after.get(k) for k in ("taskState", "listeners", "hs2NodeProcesses", "supervisorProcesses", "stageToolProcesses")}}

def start_phase():
    bad, out, post = [], {}, None
    try:
        rc, out, _ = ps(START, 1200)
        if out.get("refused"): bad = ["in-session pin check refused (nothing was started): " + ", ".join(out.get("pinBad") or [])]
        else:
            post = probe()
            bad = ([f"remote session exit {rc}"] if rc else []) + L.validate_start(out.get("startRc"), out.get("healthRc"), out.get("health") or [], post["listeners"], post.get("taskState"))
    except (Exception, KeyboardInterrupt) as e:
        bad = ["exception during start/verification: " + err(e)]
    if not bad: done("start", 0, "STARTED: task Running, exactly the six stage-1 health checks PASS, loopback-only", health=out.get("health"), listeners=post["listeners"])
    st = emergency_stop("start did not verify")
    done("start", 3 if st["quiet"] else 4, "START FAILED; stopped and PROVEN quiet (installed, not started; data kept)" if st["quiet"]
         else "CRITICAL: start failed and the stage could not be PROVEN stopped", refusals=bad, health=out.get("health"), stop=st)

def fill_phase():
    bad, out, art, pol = [], {}, None, None
    try:
        rc, out, _ = ps(FILL, 3600)
        if out.get("refused"): done("fill", 2, "REFUSED by the in-session pin check (nothing ran)", pinBad=out.get("pinBad"))
        if rc: bad.append(f"remote session exit {rc}")
        art, pol = L.parse_tool_json(out.get("art") or ""), L.parse_tool_json(out.get("pol") or "")
    except (Exception, KeyboardInterrupt) as e:
        bad.append("exception during fill: " + err(e))
    try: post = probe()
    except BaseException as e: done("fill", 4, "CRITICAL: cannot verify the fill tool ended (probe failed)", refusals=bad + [err(e)])
    if post.get("stageToolProcesses", 0) or post.get("hs2NodeProcesses", 0): done("fill", 4, "CRITICAL: a stage tool is still running after the fill session ended", refusals=bad, post=post)
    bad += L.validate_fill(out.get("artRc"), art, out.get("polRc"), pol, post.get("artifactsFiles"), post.get("artifactsOther", 0))
    if bad: done("fill", 3, "FILL NOT COMPLETE (nothing started; no tool left running; re-run --fill)", refusals=bad, art=art, pol=pol)
    done("fill", 0, "FILLED: 1,872 verified object files; policy " + str(pol.get("state")), art=art, pol=pol)

def main():
    args = sys.argv[1:]
    phase = next((a[2:] for a in args if a in ("--transfer", "--fill", "--start", "--cleanup", "--stop", "--rollback")), "dry-run")
    if not L.staging_path_ok(): raise SystemExit("REFUSED: staging path guard")
    if phase == "stop":                                         # emergency path: no local stage/snapshot dependency
        pre = None
        try: pre = probe()
        except BaseException as e: pass                         # a failed probe must not prevent a stop
        if pre is not None and pre.get("sessionElevated") is False: done(phase, 2, "REFUSED: the SSH session is not elevated")
        st = emergency_stop("operator --stop")
        done(phase, 0 if st["quiet"] else 4, "STOPPED and PROVEN quiet (installed, not started)" if st["quiet"] else "CRITICAL: stop could not be PROVEN", stop=st)
    if phase != "rollback": stage_pins()
    local = snapshot() if phase in ("dry-run", "transfer", "fill") else None
    try: pre = probe()
    except BaseException as e: done(phase, 2, "REFUSED: the read-only preflight probe failed: " + err(e))
    refusals = L.evaluate(pre, phase, local_sizes=local, fill_done=fill_done())
    slim = {k: v for k, v in pre.items() if k != "staging"} | {"stagingFiles": None if pre["staging"] is None else len(pre["staging"])}
    if refusals: done(phase, 2, "REFUSED before any change", refusals=refusals, preflight=slim)
    if phase == "dry-run":
        to_send, _ = L.plan_transfer(local, pre["staging"], pre.get("stagingMarker"))
        done(phase, 0, "DRY-RUN OK: nothing changed", preflight=slim, transferPending=len(to_send), transferPendingBytes=sum(local[n] for n in to_send),
             next=("transfer" if to_send else "fill" if pre.get("artifactsFiles") != 2 * L.PINS["objects"] else "start"))
    if phase == "transfer":
        try:
            if pre["staging"] is None:
                rc, out, _ = ps(f"New-Item -ItemType Directory -Path '{L.STAGING}'|Out-Null;[IO.File]::WriteAllText('{L.STAGING}\\{L.MARKER}','{L.PINS['manifestSha256']}');'RESULT '+(@{{created=$true}}|ConvertTo-Json -Compress)", 60)
                if rc != 0 or not out.get("created"): done(phase, 4, "CRITICAL: could not create the staging dir")
                pre = probe()
            to_send, refs = L.plan_transfer(local, pre["staging"], pre.get("stagingMarker"))
            if refs: done(phase, 2, "REFUSED", refusals=refs)
            dest = HOST + ":" + L.STAGING.replace("\\", "/") + "/"
            for i in range(0, len(to_send), 48):
                r = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", *[str(SNAP / n) for n in to_send[i:i + 48]], dest], capture_output=True, text=True, timeout=3600)
                if r.returncode != 0: done(phase, 3, f"scp failed at batch {i // 48} (resumable: run --transfer again)", stderr=r.stderr[-400:])
            post = probe()
        except (Exception, KeyboardInterrupt) as e:
            done(phase, 3, "transfer interrupted (resumable: run --transfer again)", error=err(e))
        if not L.staging_complete(local, post["staging"], post.get("stagingMarker")): done(phase, 3, "the staging copy is still incomplete (resumable: run --transfer again)")
        done(phase, 0, f"TRANSFERRED: staging holds all {len(local)} snapshot files", sent=len(to_send))
    if phase == "fill": fill_phase()
    if phase == "start": start_phase()
    if phase == "cleanup":
        if pre["staging"] is None: done(phase, 0, "nothing to clean: no staging dir")
        rc, out, _ = ps(f"$sg='{L.STAGING}';if(([IO.File]::ReadAllText((Join-Path $sg '{L.MARKER}'))).Trim() -ne '{L.PINS['manifestSha256']}'){{throw 'marker mismatch'}};Remove-Item -LiteralPath $sg -Recurse -Force;'RESULT '+(@{{removed=-not (Test-Path -LiteralPath $sg)}}|ConvertTo-Json -Compress)", 300)
        done(phase, 0 if out.get("removed") else 4, "staging copy removed" if out.get("removed") else "CRITICAL: staging removal incomplete")
    if phase == "rollback":
        keep = " -KeepData" if "--keep-data" in args else ""
        rc, out, _ = ps(ROLLBACK(keep), 600)
        if out.get("refused"): done(phase, 2, "REFUSED by the in-session pin check (rollback.ps1/stop.ps1/common.ps1/supervisor drifted; nothing ran). Use --stop.", pinBad=out.get("pinBad"))
        if out.get("rbRc") != 0: done(phase, 4, f"rollback.ps1 exit {out.get('rbRc')} (4 = a changed installed file was KEPT; see its log)")
        if pre["staging"] is not None and pre.get("stagingMarker") == L.PINS["manifestSha256"]:
            ps(f"Remove-Item -LiteralPath '{L.STAGING}' -Recurse -Force;'RESULT '+(@{{ok=$true}}|ConvertTo-Json -Compress)", 300)
        done(phase, 0, "ROLLED BACK to the pre-install state" + (" (data kept)" if keep else ""))

if __name__ == "__main__":
    main()
