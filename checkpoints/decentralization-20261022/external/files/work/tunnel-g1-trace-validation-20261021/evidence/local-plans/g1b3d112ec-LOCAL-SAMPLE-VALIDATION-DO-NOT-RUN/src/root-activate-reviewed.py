#!/usr/bin/env python3
"""ROOT activation of the nucbox manager stop fix (+ optional liveness fix) on minipc. PREPARED by claude 9d6a7d6f; NOT run.

  ./root-activate.py                 preflight only (read-only)                                  [default]
  ./root-activate.py --parse-only    preflight + send every step's PowerShell text for PARSING on minipc (nothing runs)
  ./root-activate.py --execute       preflight -> backup + CAS atomic replace -> ONE manager restart -> health -> receipt
  ./root-activate.py --rollback      put the backups back (CAS against the candidates) -> ONE manager restart -> health
  add --wmiserve-only to leave server.mjs alone (by default BOTH reviewed files are activated in the same single restart)

Files (C:\\Program Files\\Enclave\\control\\windows\\vbslike\\manager):
  wmiserve-run.mjs  c0154d17... -> 8107f272...  from C:\\ProgramData\\Enclave\\hotfix\\nucbox-stopfix-20261021\\fixed (natively 21/21)
  server.mjs        ec91cb03... -> 58b5d7fd...  from C:\\ProgramData\\Enclave\\hotfix\\enclavedns-liveness-20261021\\server.mjs.fixed
The two files are independent: server.mjs does not import wmiserve-run.mjs, and the stop fix keeps runWmiserve's exports.
The restart: exactly ONE kill of the process that (a) is the ONLY listener on 127.0.0.1:8091, (b) is
C:\\Program Files\\Enclave\\runtime\\node\\node.exe running ...\\vbslike\\manager\\main.mjs, and (c) whose parent is the
cmd.exe running run-shield.cmd. Its loop logs "[run] exited", waits 10 s and starts the manager again. Nothing else is
touched: no node agent, network agent, host, task or VM operation. The kill re-validates pid + start time right before it.
Every remote session: an in-session watchdog, primitive JSON only, under cmd.exe's 8191-character limit.
"""
import base64, json, subprocess, sys, time

M = r"C:\Program Files\Enclave\control\windows\vbslike\manager"
NODE = r"C:\Program Files\Enclave\runtime\node\node.exe"
STAGE = r"C:\ProgramData\Enclave\hotfix\nucbox-stopfix-20261021"
FILES = {
  "wmiserve-run.mjs": {"live": "c0154d17372a09fa08d9c4c8675496668fa927774da5245bb2d6892410feddde",
                       "new": "8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17",
                       "src": STAGE + r"\fixed\wmiserve-run.mjs", "bak": "wmiserve-run.mjs.pre-stopfix-c0154d17"},
  "server.mjs":       {"live": "ec91cb03f694e131b0f4660bc60daed9e1f29d944bfe86dd40d53444901a7953",
                       "new": "58b5d7fd76e7d3bbd3c64780a27e8475dce4dd1aa21753f1e44aaee9c5ea8beb",
                       "src": r"C:\ProgramData\Enclave\hotfix\enclavedns-liveness-20261021\server.mjs.fixed",
                       "bak": "server.mjs.pre-liveness-ec91cb03"},
}
HEAD = ("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
        "$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',"
        "('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(SECS);while(-not $t.WaitForExit(2000)){$t.Refresh();"
        "if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID));"
        "function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}};")
# the manager, validated: the single 8091 listener, the runtime node running manager\main.mjs, child of the run-shield loop
MGR = ("function Mgr{$c=@(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue);"
       "if($c.Count -ne 1){return [ordered]@{ok=$false;why=\"$($c.Count) listeners on 8091\"}};$id=[int]$c[0].OwningProcess;"
       "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -OperationTimeoutSec 20;"
       "$pp=Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\" -OperationTimeoutSec 20;"
       "$ok=([string]$p.ExecutablePath -eq 'NODEX') -and ([string]$p.CommandLine -like '*\\control\\windows\\vbslike\\manager\\main.mjs*') "
       "-and ([string]$pp.Name -eq 'cmd.exe') -and ([string]$pp.CommandLine -like '*run-shield.cmd*');"
       "[ordered]@{ok=$ok;pid=$id;started=$p.CreationDate.ToUniversalTime().ToString('o');exe=[string]$p.ExecutablePath;parent=[string]$pp.Name}};"
       ).replace("NODEX", NODE)
LOG = r"C:\ProgramData\Enclave\logs\shield.log"
LOGC = ("function LogCounts{$t=[string]::Join(\"`n\",@(Get-Content -LiteralPath 'LOGX' -Tail 4000));"
        "[ordered]@{runExited=([regex]::Matches($t,'\\[run\\] exited')).Count;writeAfterEnd=([regex]::Matches($t,'ERR_STREAM_WRITE_AFTER_END')).Count}};").replace("LOGX", LOG)

def files(args):
    return {k: v for k, v in FILES.items() if not ("--wmiserve-only" in args and k == "server.mjs")}

def ps(script, secs=150):
    text = HEAD.replace("SECS", str(secs)) + script
    enc = base64.b64encode(text.encode("utf-16-le")).decode()
    if len(enc) > 7900: raise SystemExit(f"encoded step too long ({len(enc)})")
    r = subprocess.run(["timeout", str(secs + 60), "ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "minipc",
                        "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], capture_output=True, text=True)
    out = r.stdout.replace("\r", "").strip().splitlines()
    if not out: return {"error": f"no output (ssh rc {r.returncode})", "stderr": r.stderr[-400:]}
    try: res = json.loads(out[-1])
    except Exception: return {"error": f"unparsed (ssh rc {r.returncode})", "stdout": "\n".join(out)[-600:], "stderr": r.stderr[-400:]}
    if r.returncode != 0:
        return {"error": f"ssh rc {r.returncode}", "result": res, "stderr": r.stderr[-400:]}
    return res

def step_texts(fs, mode, mdir=M):
    """The PowerShell of each mutating step (install / restart), for --parse-only and --execute. `mdir` is the target
    directory: the live manager directory, or a staging FIXTURE directory for the CAS tests (test-activation.py)."""
    pairs = [(f"{mdir}\\{k}", v["src"], v["live" if mode == "install" else "new"], v["new" if mode == "install" else "live"],
              f"{mdir}\\{v['bak']}") for k, v in fs.items()]
    # `$rows+=,@(...)`: the unary comma keeps each row ONE element (with a single row, @(@(...)) would flatten it)
    rows = "".join("$rows+=,@('%s','%s','%s','%s','%s');" % p for p in pairs)
    # install: CAS (target must hash to EXPECT), backup kept (never overwritten with other bytes), the candidate copied
    #          beside the target, hashed, then [IO.File]::Replace onto it (same volume, one rename)
    # rollback: the backup is the source and the CAS expects the candidate
    # PHASE 1 verifies EVERY file (target CAS, source, backup state) before PHASE 2 changes ANY: all or nothing
    src = "$src" if mode == "install" else "$bak"
    install = ("$rows=@();" + rows + "$o=[ordered]@{};"
               "foreach($r in $rows){$dst,$src,$exp,$want,$bak=$r;"
               "if((FileSha $dst) -ne $exp){throw \"CAS refused: $dst is not $exp\"};"
               "if((FileSha " + src + ") -ne $want){throw \"source " + src + " is not $want\"};"
               + ("if((Test-Path -LiteralPath $bak) -and ((FileSha $bak) -ne $exp)){throw \"backup $bak exists with other bytes\"}};"
                  if mode == "install" else "};") +
               "foreach($r in $rows){$dst,$src,$exp,$want,$bak=$r;"
               + ("if(-not (Test-Path -LiteralPath $bak)){Copy-Item -LiteralPath $dst -Destination $bak;if((FileSha $bak) -ne $exp){throw 'backup mismatch'}};"
                  if mode == "install" else "") +
               "$tmp=\"$dst.new-$([guid]::NewGuid().ToString('N').Substring(0,8))\";Copy-Item -LiteralPath " + src + " -Destination $tmp;"
               "if((FileSha $tmp) -ne $want){Remove-Item -LiteralPath $tmp;throw 'staged copy mismatch'};"
               # PowerShell 5.1 hands $null to a .NET string parameter as "" ("The path is not of a legal form", found
               # by test-activation.py): NullString is a real null, i.e. no third backup file
               "try{[IO.File]::Replace($tmp,$dst,[System.Management.Automation.Language.NullString]::Value)}catch{Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue;throw};"
               "$o[(Split-Path -Leaf $dst)]=FileSha $dst};"
               "$chk=& 'NODEX' --check (Join-Path 'MX' 'wmiserve-run.mjs');$o.nodeCheckWmiserve=$LASTEXITCODE;"
               "$chk=& 'NODEX' --check (Join-Path 'MX' 'server.mjs');$o.nodeCheckServer=$LASTEXITCODE;$o|ConvertTo-Json -Compress"
               ).replace("NODEX", NODE).replace("MX", mdir)
    restart = (MGR + LOGC + "$m=Mgr;if(-not $m.ok){throw ('manager not validated: '+($m|ConvertTo-Json -Compress))};"
               "$before=LogCounts;Start-Sleep -Seconds 1;$m2=Mgr;"
               "if($m2.pid -ne $m.pid -or $m2.started -ne $m.started){throw 'manager changed under us: re-run'};"
               "Stop-Process -Id $m.pid -Force;"
               "$end=(Get-Date).AddSeconds(120);$n=$null;while((Get-Date) -lt $end){Start-Sleep -Seconds 3;$x=Mgr;if($x.ok -and $x.pid -ne $m.pid){$n=$x;break}};"
               "$h=$null;if($n){try{$h=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 15).StatusCode}catch{$h=[string]$_.Exception.Message}};"
               "[ordered]@{killed=$m.pid;killedStarted=$m.started;new=$n;health=$h;logBefore=$before;logAfter=(LogCounts)}|ConvertTo-Json -Depth 3 -Compress")
    return install, restart

def full_text(text, secs=200):
    return HEAD.replace("SECS", str(secs)) + text

def parse_remote(name, text):
    """Upload one exact step text, check its sha256 on minipc, parse it there. -> dict (an 'error' key on any failure)."""
    import hashlib, os, tempfile
    body = full_text(text).encode("utf-8")
    want = hashlib.sha256(body).hexdigest()
    with tempfile.NamedTemporaryFile("wb", suffix=".ps1.txt", delete=False) as f: f.write(body)
    try:
        up = subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", f.name,
                             "minipc:/C:/ProgramData/Enclave/hotfix/nucbox-stopfix-20261021/step-%s.ps1.txt" % name], capture_output=True)
    finally: os.unlink(f.name)
    if up.returncode != 0: return {"error": f"upload failed (scp rc {up.returncode})", "stderr": up.stderr.decode()[-300:]}
    res = ps("$p='%s\\step-%s.ps1.txt';$s=[IO.File]::ReadAllText($p);$t=$null;$e=$null;"
             "[void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);"
             "[ordered]@{sha256=FileSha $p;encodedChars=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s)).Length;"
             "parseErrors=@($e|ForEach-Object{$_.Message})}|ConvertTo-Json -Compress" % (STAGE, name))
    if "error" not in res and res.get("sha256") != want: res["error"] = f"uploaded text hashes {res.get('sha256')}, not {want}"
    return res

def parse_ok(v):
    return isinstance(v, dict) and "error" not in v and v.get("parseErrors") == [] and 0 < v.get("encodedChars", 0) <= 7900

def main(args):
    fs = files(args)
    receipt = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "mode": "execute" if "--execute" in args else
               "rollback" if "--rollback" in args else "parse-only" if "--parse-only" in args else "preflight", "files": list(fs)}
    pre = ps(MGR + LOGC + "$o=[ordered]@{};" + "".join(
        f"$o['{k}']=[ordered]@{{live=FileSha '{M}\\{k}';candidate=FileSha '{v['src']}';backup=FileSha '{M}\\{v['bak']}'}};" for k, v in fs.items())
        + "$o.manager=Mgr;$o.log=LogCounts;$o|ConvertTo-Json -Depth 4 -Compress")
    # --check needs a .mjs name (a ".fixed" file is read as CommonJS): hash-verified copies in THIS staging dir's check\
    rows = "".join("$rows+=,@('%s','%s','%s');" % (v["src"], k, v["new"]) for k, v in fs.items())
    pre["stagedCheck"] = ps(
        f"$cd='{STAGE}\\check';$null=New-Item -ItemType Directory -Force -Path $cd;$rows=@();{rows}"
        f"$r=@(foreach($x in $rows){{$src,$n,$h=$x;$c=Join-Path $cd $n;Copy-Item -LiteralPath $src -Destination $c -Force;"
        f"if((FileSha $c) -ne $h){{'copy mismatch'}}else{{$null=& '{NODE}' --check $c 2>&1;$LASTEXITCODE}}}});"
        "ConvertTo-Json -InputObject @($r) -Compress")
    receipt["preflight"] = pre
    print(json.dumps(pre, indent=1))
    want_live = "new" if "--rollback" in args else "live"
    bad = [k for k, v in fs.items() if pre.get(k, {}).get("live") != v[want_live]]
    bad += [k for k, v in fs.items() if pre.get(k, {}).get("candidate") != v["new"]]
    sc = pre.get("stagedCheck")
    if ("error" in pre or bad or not pre.get("manager", {}).get("ok")
            or not isinstance(sc, list) or len(sc) != len(fs) or any(x != 0 for x in sc)):
        receipt["refused"] = {"hashOrCandidate": bad, "manager": pre.get("manager"), "stagedCheck": pre.get("stagedCheck")}
        print("REFUSED: preflight does not match the reviewed state"); return finish(receipt, 3)
    install, restart = step_texts(fs, "rollback" if "--rollback" in args else "install")
    if "--parse-only" in args:
        # upload each EXACT step text (install, restart, rollback install, rollback restart) into the staging dir, verify
        # its sha256 there, and PARSE it with PowerShell 5.1. Nothing runs. Any missing/failed result is a failure.
        rb_install, rb_restart = step_texts(fs, "rollback")
        res = {"install": parse_remote("install", install), "restart": parse_remote("restart", restart),
               "rollback-install": parse_remote("rollback-install", rb_install), "rollback-restart": parse_remote("rollback-restart", rb_restart)}
        failed = [k for k, v in res.items() if not parse_ok(v)]
        receipt["parse"] = res; receipt["parseFailed"] = failed; print(json.dumps(res, indent=1))
        print("PARSE OK" if not failed else f"PARSE FAILED: {failed}")
        return finish(receipt, 0 if not failed else 6)
    if not ("--execute" in args or "--rollback" in args): return finish(receipt, 0)
    receipt["install"] = ps(install); print(json.dumps(receipt["install"], indent=1))
    target = {k: (v["new"] if "--execute" in args else v["live"]) for k, v in fs.items()}
    inst = receipt["install"]
    if ("error" in inst or any(inst.get(k) != h for k, h in target.items())
            or inst.get("nodeCheckWmiserve") != 0 or inst.get("nodeCheckServer") != 0):
        print("STOPPED after the file step: no restart was done; inspect the receipt"); return finish(receipt, 4)
    receipt["restart"] = ps(restart, 200); print(json.dumps(receipt["restart"], indent=1))
    r = receipt["restart"]
    ok = isinstance(r.get("new"), dict) and r.get("health") == 200
    print("ACTIVATED" if ok else "RESTART NOT CONFIRMED: check shield.log; rollback = ./root-activate.py --rollback")
    print("Then watch for 10+ min: no new '[run] exited' / ERR_STREAM_WRITE_AFTER_END in shield.log; node.log 'installed in "
          "partition'; network.log 'egress back' per app; routes list 59f1273d; dig NOERROR; curl verify 0 / 200.")
    return finish(receipt, 0 if ok else 5)

def finish(receipt, rc):
    name = f"activation-receipt-{receipt['mode']}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    with open(name, "w") as f: json.dump(receipt, f, indent=1)
    print("receipt:", name); return rc

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
