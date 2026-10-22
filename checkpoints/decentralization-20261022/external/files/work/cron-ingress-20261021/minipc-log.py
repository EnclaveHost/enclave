#!/usr/bin/env python3
# Read-only, bounded (90 s watchdog): minipc network.log lines since 14:55Z mentioning cron/circuits/routes, last 220.
import base64, subprocess, sys
pat = sys.argv[1] if len(sys.argv) > 1 else '38f368d6|circuit|route|qualif|publish'
script = r'''
$f='C:\ProgramData\Enclave\logs\network.log'
$i=Get-Item -LiteralPath $f; 'SIZE '+$i.Length+' MTIME '+$i.LastWriteTimeUtc.ToString('o')
$lines=Get-Content -LiteralPath $f -Tail 20000 | Where-Object { $_ -match '%PAT%' }
'MATCHES '+@($lines).Count
$lines | Select-Object -Last 220 | ForEach-Object { if($_.Length -gt 260){$_.Substring(0,260)}else{$_} }
'''.replace('%PAT%', pat.replace("'", "''"))
watch = r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$p.WaitForExit(90000)|Out-Null;if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''
enc = base64.b64encode((watch + script + '} finally {if(!$watcher.HasExited){$watcher.Kill()}}').encode('utf-16le')).decode()
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc], capture_output=True, text=True, timeout=110)
print(r.stdout); print('EXIT', r.returncode, r.stderr[-400:], file=sys.stderr)
