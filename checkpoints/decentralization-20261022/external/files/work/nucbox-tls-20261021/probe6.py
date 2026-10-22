# READ-ONLY, scoped probe 6 of nucbox: is it in a mass respawn, and why?
#   - start times of the Enclave node/manager/privacy-agent processes (.mjs paths only)
#   - the Windows manager's /vms records (status/reason only) and Hyper-V's enclave-app VM states/uptimes
#   - node.log: LAST 3000 lines, only isolation lifecycle lines (restart recovery / retired / spawned / giving up / held /
#     manager / winmgr), last 40, truncated 260
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
$o.procs=@(Get-CimInstance Win32_Process | Where-Object { [string]$_.CommandLine -match 'Enclave\\(control|network)\\.*\.mjs' } | ForEach-Object { [ordered]@{pid=$_.ProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o'); mjs=@([regex]::Matches([string]$_.CommandLine,'[A-Za-z]:\\[^"]+?\.mjs') | ForEach-Object { $_.Value })} })
try{ $v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms'; $o.mgrVms=@($v.vms | ForEach-Object { [ordered]@{id=$_.id; name=(trim $_.name 12); status=$_.status; recovered=$_.recovered; reason=(trim $_.reason 200)} }) }catch{ $o.mgrError=$_.Exception.Message }
try{ $h=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/health'; $o.mgrHealth=($h | ConvertTo-Json -Depth 3 -Compress).Substring(0,[Math]::Min(1500,($h | ConvertTo-Json -Depth 3 -Compress).Length)) }catch{ $o.mgrHealthError=$_.Exception.Message }
$o.vms=@(Get-VM | Where-Object { $_.Name -like 'enclave-app-*' } | ForEach-Object { $_.Name+' '+$_.State+' '+$_.Uptime })
$tail=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 3000)
$o.lifecycle=@($tail | Where-Object { $_ -match 'restart recovery|retired|spawned|giving up|held|manager|winmgr|isolation:|recovered|inventory' -and $_ -notmatch 'isolation adopted' } | Select-Object -Last 40 | ForEach-Object { trim $_ 260 })
$o.firstRestartRecovery=@($tail | Where-Object { $_ -match 'restart recovery' } | Select-Object -First 3 | ForEach-Object { trim $_ 200 })
'RESULT '+($o | ConvertTo-Json -Depth 6 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
here = pathlib.Path(__file__).parent
(here / 'probe6.out.raw').write_bytes(r.stdout + r.stderr)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
if i >= 0: (here / 'probe6.json').write_text(json.dumps(json.loads(t[i + 7:].strip().splitlines()[0]), indent=1))
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout)); raise SystemExit(r.returncode)
