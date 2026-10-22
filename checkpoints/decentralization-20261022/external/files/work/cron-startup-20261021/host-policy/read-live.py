#!/usr/bin/env python3
"""READ-ONLY minipc metadata for the wallet-policy quorum (same transport as ../probe.py: in-session watchdog,
-EncodedCommand, primitive JSON). Returns: sha256 + mtime of the live node files on the admission path; the live chain.mjs
RPCS default line (source text); and for node-config*.cmd ONLY whether BASE_RPCS is set and the HOST NAMES it lists
(no value, path, query or any other variable is read out). -> read-live.json"""
import base64, json, re, subprocess, pathlib
HEAD = ("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
        "$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',"
        "('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(SECS);while(-not $t.WaitForExit(2000)){$t.Refresh();"
        "if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID));")
def ps(script, secs=90):
    enc = base64.b64encode((HEAD.replace("SECS", str(secs)) + script).encode("utf-16-le")).decode()
    assert len(enc) < 7900, len(enc)
    r = subprocess.run(["timeout", str(secs + 60), "ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "minipc", "powershell", "-NoProfile",
                        "-NonInteractive", "-EncodedCommand", enc], capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stdout.replace("\r", "").strip().splitlines()
    try: return json.loads(out[-1])
    except Exception: return {"error": f"ssh rc {r.returncode}", "stderr": r.stderr[-200:]}
D = r"C:\Program Files\Enclave\control"
files = ["windows\\node\\host.mjs", "windows\\node\\host-admission.bundle.mjs", "windows\\node\\chain.mjs", "windows\\node\\network-enroll.mjs", "windows\\node\\agent.mjs"]
fl = ",".join("'%s'" % f for f in files)
s1 = ("$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};$o.files=@(foreach($f in @(%s)){$p=Join-Path '%s' $f;if(Test-Path -LiteralPath $p){[ordered]@{f=$f;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower();mtime=(Get-Item -LiteralPath $p).LastWriteTimeUtc.ToString('o')}}else{[ordered]@{f=$f;sha256='absent'}}});"
      "$o.rpcsLine=@(Select-String -LiteralPath (Join-Path '%s' 'windows\\node\\chain.mjs') -Pattern 'BASE_RPCS \\|\\|' | ForEach-Object {$_.Line.Trim()});"
      "$o|ConvertTo-Json -Depth 4 -Compress") % (fl, D, D)
s2 = ("$c=@(Get-ChildItem -Path 'C:\\Program Files\\Enclave','C:\\ProgramData\\Enclave' -Recurse -Filter 'node-config*.cmd' -File -ErrorAction SilentlyContinue | Select-Object -First 6);"
      "$o=@(foreach($x in $c){$h=@();$set=$false;foreach($l in (Get-Content -LiteralPath $x.FullName)){if($l -match '^\\s*set\\s+\"?BASE_RPCS='){$set=$true;$h+=@([regex]::Matches($l,'https://([A-Za-z0-9.-]+)')|ForEach-Object{$_.Groups[1].Value})}};[ordered]@{file=$x.Name;dir=$x.DirectoryName.Length;baseRpcsSet=$set;hosts=$h}});"
      "ConvertTo-Json -InputObject $o -Compress")
out = {"files": ps(s1), "nodeConfig": ps(s2)}
pathlib.Path(__file__).with_name("read-live.json").write_text(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
