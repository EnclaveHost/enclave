# READ-ONLY, scoped probe 7 of nucbox: why did the Windows manager restart (11:28Z, 11:47Z)?
#   - sha256 of the live manager sources (server.mjs vs ec91cb03 = the reviewed live file, 58b5d7fd = the liveness fix)
#   - shield.log (the manager's stdout/stderr via the RunLoop): last 4000 lines, only start/exit/error/crash/inventory lines,
#     last 40, truncated 260; and the count of "[winmgr] inventory" starts in that window (one per manager start)
#   - the RunLoop wrapper's own exit/restart lines if it logs them there
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
$d='C:\Program Files\Enclave\control\windows\vbslike\manager'
$o.hashes=[ordered]@{}; foreach($n in 'server.mjs','main.mjs','wmi-launcher.mjs'){ $f=Join-Path $d $n; if(Test-Path -LiteralPath $f){ $i=Get-Item -LiteralPath $f; $o.hashes[$n]=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()+' '+$i.LastWriteTimeUtc.ToString('o') } }
$log='C:\ProgramData\Enclave\logs\shield.log'; $li=Get-Item -LiteralPath $log; $o.shieldLog=$li.Length.ToString()+' '+$li.LastWriteTimeUtc.ToString('o')
$tail=@(Get-Content -LiteralPath $log -Tail 4000)
$o.starts=@($tail | Where-Object { $_ -match '\[winmgr\] inventory (ready|pending|failed)' }).Count
$o.events=@($tail | Where-Object { $_ -match 'winmgr\] (inventory|serving through|runtime identity|data plane|partition consoles)|Error|error:|uncaught|unhandled|exit|exited|restart|FATAL|heap|out of memory|ELIFECYCLE|SIGTERM|killed' -and $_ -notmatch 'console enclave-app' } | Select-Object -Last 40 | ForEach-Object { trim $_ 260 })
'RESULT '+($o | ConvertTo-Json -Depth 5 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
here = pathlib.Path(__file__).parent
(here / 'probe7.out.raw').write_bytes(r.stdout + r.stderr)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
if i >= 0: (here / 'probe7.json').write_text(json.dumps(json.loads(t[i + 7:].strip().splitlines()[0]), indent=1))
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout)); raise SystemExit(r.returncode)
