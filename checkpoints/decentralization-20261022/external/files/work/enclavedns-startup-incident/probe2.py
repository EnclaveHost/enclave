# READ-ONLY probe 2 (no restart, no mutation, no env/keys/DB): the two partitions of deployment 0x59f1273d around its
# 06:47-06:49Z failure (hvc17c55a87e236f = the instance retired at 06:47:32, hv154aefd9debb9c = the one that failed as
# "Starting"): their kept consoles, Hyper-V events naming them, node-log context, the live manager's own log lines naming
# them, and the sha256 of the deployed manager/node sources (paths taken from the running node.exe command lines, .mjs only).
import subprocess, base64, pathlib
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'
$pat='hv154aefd9debb9c|hvc17c55a87e236f'; $L='C:\ProgramData\Enclave\logs'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
# 1. consoles of the two partitions (whole files are small)
$o.consoles=[ordered]@{}; foreach($f in @(Get-ChildItem -LiteralPath (Join-Path $L 'partitions') -File | Where-Object { $_.Name -match $pat })){ $o.consoles[$f.Name]=@(Get-Content -LiteralPath $f.FullName -Tail 200 | ForEach-Object { trim $_ 300 }) }
# 2. Hyper-V events 06:40-06:55Z naming them (all event ids, all Hyper-V admin/operational logs that exist)
$t0=[DateTime]::Parse('2026-10-21T06:40:00Z').ToLocalTime(); $t1=[DateTime]::Parse('2026-10-21T06:55:00Z').ToLocalTime()
foreach($log in 'Microsoft-Windows-Hyper-V-Worker-Admin','Microsoft-Windows-Hyper-V-VMMS-Admin','Microsoft-Windows-Hyper-V-Worker-Operational','Microsoft-Windows-Hyper-V-Compute-Admin','Microsoft-Windows-Hyper-V-Chipset-Admin'){
  try{ $ev=@(Get-WinEvent -FilterHashtable @{LogName=$log; StartTime=$t0; EndTime=$t1} -ErrorAction Stop | Where-Object { [string]$_.Message -match $pat })
       $o["events_$log"]=@($ev | Sort-Object TimeCreated | ForEach-Object { $_.TimeCreated.ToUniversalTime().ToString('o')+' ['+$_.Id+'] '+(trim $_.Message 600) }) }catch{ $o["eventsErr_$log"]=(trim $_.Exception.Message 200) } }
# 3. node.log: the 500 lines before the unique release line, keeping lines about this deployment, its VMs, the manager or quorum
$nl=Join-Path $L 'node.log'
$hit=Select-String -LiteralPath $nl -SimpleMatch 'released 0x59f1273d back to the fleet (tx 0x539e71e3' | Select-Object -Last 1
if($hit){ $n=$hit.LineNumber; $ctx=@(Get-Content -LiteralPath $nl -TotalCount ($n+5) | Select-Object -Skip ([Math]::Max(0,$n-600)))
  $o.nodeContext=@($ctx | Where-Object { $_ -match "59f1273d|$pat|winmgr|manager|quorum|isolation:|liveness|Starting" } | ForEach-Object { trim $_ 600 }) }
# 4. the live processes' script paths (.mjs tokens only) and the files they log to: recent logs under ProgramData\Enclave
$o.nodeScripts=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { @([regex]::Matches([string]$_.CommandLine,'[A-Za-z]:\\[^"\s]+\.mjs') | ForEach-Object { $_.Value }) } | Select-Object -Unique)
$recent=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddHours(-4) -and $_.FullName -notmatch '\\partitions\\' -and $_.Extension -in '.log','.txt','.out','.err' })
$o.recentLogs=@($recent | ForEach-Object { $_.FullName+' '+$_.Length+' '+$_.LastWriteTimeUtc.ToString('o') })
$o.managerLines=[ordered]@{}; foreach($f in $recent){ $m=@(Select-String -LiteralPath $f.FullName -Pattern "$pat|winmgr\] (liveness|answers|inventory)" | Select-Object -Last 60 | ForEach-Object { trim $_.Line 500 }); if($m.Count){ $o.managerLines[$f.FullName]=$m } }
# 5. sha256 of the deployed manager/node sources this incident touches
$o.sourceHashes=[ordered]@{}; foreach($p in $o.nodeScripts){ $d=Split-Path $p -Parent; foreach($n in 'server.mjs','wmi-launcher.mjs','main.mjs','host.mjs','isolation-lifecycle.mjs'){ $f=Join-Path $d $n; if(Test-Path -LiteralPath $f){ $o.sourceHashes[$f]=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() } } }
'RESULT '+($o | ConvertTo-Json -Depth 6 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=200)
(pathlib.Path(__file__).parent / 'probe2.out').write_bytes(r.stdout + r.stderr)
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout))
raise SystemExit(r.returncode)
