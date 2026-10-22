#!/usr/bin/env python3
# Read-only, bounded (90 s watchdog): minipc checker.log tail lines matching a pattern, plus hashes of the deployed
# checker files (no key or config secret is read: only checker.mjs/run-checker.mjs/checker-directories.json hashes).
import base64, subprocess, sys
pat = sys.argv[1] if len(sys.argv) > 1 else 'payloadIntegrity|134\\.209\\.248\\.172|fra1|false'
script = r'''
$d='C:\ProgramData\Enclave\network-checker'
foreach($n in 'checker.mjs','run-checker.mjs','checker-directories.json'){$p=Join-Path $d $n;if(Test-Path -LiteralPath $p){'HASH '+$n+' '+(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}}
$f=Join-Path $d 'checker.log'
$i=Get-Item -LiteralPath $f; 'SIZE '+$i.Length+' MTIME '+$i.LastWriteTimeUtc.ToString('o')
$all=Get-Content -LiteralPath $f -Tail 4000
'TAILLINES '+@($all).Count
$m=$all | Where-Object { $_ -match '%PAT%' }
'MATCHES '+@($m).Count
$m | Select-Object -Last 120 | ForEach-Object { if($_.Length -gt 400){$_.Substring(0,400)}else{$_} }
'--- LAST 25 RAW'
$all | Select-Object -Last 25 | ForEach-Object { if($_.Length -gt 300){$_.Substring(0,300)}else{$_} }
'''.replace('%PAT%', pat.replace("'", "''"))
watch = r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$p.WaitForExit(90000)|Out-Null;if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''
enc = base64.b64encode((watch + script + '} finally {if(!$watcher.HasExited){$watcher.Kill()}}').encode('utf-16le')).decode()
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc], capture_output=True, text=True, timeout=110)
print('\n'.join(l for l in r.stdout.splitlines() if not l.startswith('#< CLIXML') and '<Objs' not in l)); print('EXIT', r.returncode, file=sys.stderr)
