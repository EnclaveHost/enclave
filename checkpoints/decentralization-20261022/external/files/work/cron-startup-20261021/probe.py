#!/usr/bin/env python3
"""READ-ONLY minipc probe for deployment 0x38f368d6 (transport model: nucbox-tls-20261021/root-activate.py ps():
in-session watchdog, -EncodedCommand, primitive JSON only, < 8191 chars). Reads log TAILS only; returns only lines that
mention the deployment or a [cron] stderr line; secret-like substrings are redacted HERE before anything is printed or
written; the raw output is never stored. Never touches a process, service, file or the manager.
  probe.py list | grep [--tail N] [--max M]"""
import base64, json, re, subprocess, sys
HEAD = ("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
        "$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',"
        "('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(SECS);while(-not $t.WaitForExit(2000)){$t.Refresh();"
        "if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID));")
def ps(script, secs=120):
    enc = base64.b64encode((HEAD.replace("SECS", str(secs)) + script).encode("utf-16-le")).decode()
    if len(enc) > 7900: raise SystemExit(f"encoded step too long ({len(enc)})")
    r = subprocess.run(["timeout", str(secs + 60), "ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "minipc",
                        "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stdout.replace("\r", "").strip().splitlines()
    if not out: return {"error": f"no output (ssh rc {r.returncode})", "stderr": r.stderr[-300:]}
    try: return json.loads(out[-1])
    except Exception: return {"error": f"unparsed (ssh rc {r.returncode})"}
SECRETISH = [(re.compile(r'(?i)((?:api[_-]?key|secret|token|password|passwd|authorization|bearer|access[_-]?key|master[_-]?key|private[_-]?key|signature|cookie)["\'=: ]+)[^\s,"\'}]{6,}'), r'\1<redacted>'),
             (re.compile(r'\b(?:0x)?[0-9a-fA-F]{64,}\b'), lambda m: m.group(0)[:10] + '…<hex>'),
             (re.compile(r'\b[A-Za-z0-9+/_-]{40,}={0,2}\b'), lambda m: m.group(0)[:6] + '…<redacted>'),
             (re.compile(r'(?i)(x-api-key|eyJ)[^\s"]*'), r'\1<redacted>')]
def redact(s):
    for p, r in SECRETISH: s = p.sub(r, s)
    return s[:400]
LOGS = r"C:\ProgramData\Enclave\logs"
if sys.argv[1] == 'list':
    res = ps("$o=@(Get-ChildItem -LiteralPath '%s' -Recurse -File -ErrorAction SilentlyContinue | Where-Object {$_.LastWriteTime -gt (Get-Date).AddHours(-30)} | "
             "Sort-Object LastWriteTime -Descending | Select-Object -First 60 | ForEach-Object {[ordered]@{n=$_.FullName.Substring(%d);b=[int64]$_.Length;t=$_.LastWriteTimeUtc.ToString('o')}});"
             "ConvertTo-Json -InputObject $o -Compress" % (LOGS, len(LOGS) + 1))
    print(json.dumps(res, indent=0))
else:
    tail = int(sys.argv[sys.argv.index('--tail') + 1]) if '--tail' in sys.argv else 20000
    mx = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 80
    pats = sys.argv[sys.argv.index('--pat') + 1].split('|') if '--pat' in sys.argv else ['38f368d6', '[cron]']
    notp = sys.argv[sys.argv.index('--not') + 1] if '--not' in sys.argv else '@@never@@'
    skip = {sys.argv[i + 1] for i, a in enumerate(sys.argv) if a in ('--tail', '--max', '--pat', '--not')}
    files = [a for a in sys.argv[2:] if not a.startswith('--') and a not in skip]
    pl = ','.join("'%s'" % x.replace("'", "") for x in pats)
    out = {}
    for f in files:
        # f may be a wildcard (partitions\*.log): every matching file's tail, each line prefixed by its file name
        res = ps("$l=@(Get-ChildItem -Path (Join-Path '%s' '%s') -File | ForEach-Object {$n=$_.Name;Get-Content -LiteralPath $_.FullName -Tail %d | "
                 "Select-String -SimpleMatch -Pattern @(%s) | Where-Object {$_.Line -notlike '*%s*'} | ForEach-Object {$n+': '+$_.Line}});"
                 "[ordered]@{file='%s';matches=$l.Count;lines=@($l | Select-Object -Last %d)}|ConvertTo-Json -Compress" % (LOGS, f, tail, pl, notp.replace("'", ""), f, mx))
        if isinstance(res, dict) and 'lines' in res: res['lines'] = [redact(x) for x in (res['lines'] or [])]
        out[f] = res
    print(json.dumps(out, indent=1))
