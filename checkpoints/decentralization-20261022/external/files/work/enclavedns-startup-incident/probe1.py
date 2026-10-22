# READ-ONLY probe of ONE deployment on minipc (no restart, no mutation, no env/keys/DB): its node-log lines, the manager's
# record of it, the Hyper-V state of its VM(s), the Worker-Admin/VMMS events naming those VMs, and the tail of its kept
# partition console (raw guest bytes, control characters stripped, treated as data).
import subprocess, base64, pathlib
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'
$id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c'; $short='59f1273d'
$L='C:\ProgramData\Enclave\logs'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
# 1. every log line naming the deployment (last 120 per file), and the manager's liveness/answer sweep lines
foreach($f in 'node.log','shield.log','network.log'){ try{ $o["lines_$f"]=@(Select-String -LiteralPath (Join-Path $L $f) -SimpleMatch $short | Select-Object -Last 120 | ForEach-Object { trim $_.Line 700 }) }catch{ $o["err_$f"]=$_.Exception.Message } }
foreach($f in 'node.log','shield.log'){ try{ $o["sweep_$f"]=@(Select-String -LiteralPath (Join-Path $L $f) -Pattern 'winmgr\] (liveness|answers|inventory)|restart recovery' | Select-Object -Last 40 | ForEach-Object { trim $_.Line 400 }) }catch{} }
# 2. the manager's records naming the deployment (all fields it publishes)
try{ $v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms'; $o.mgrRecords=@($v.vms | Where-Object { ($_ | ConvertTo-Json -Depth 6 -Compress) -match $short }); $o.mgrCount=@($v.vms).Count }catch{ $o.mgrError=$_.Exception.Message }
# 3. Hyper-V: every VM whose Notes name the deployment, plus every enclave VM's name/state/uptime
$all=@(Get-VM | Select-Object Name,Id,State,Uptime,Notes,CreationTime)
$mine=@($all | Where-Object { ([string]$_.Notes) -match $short })
$o.vmsForDeployment=@($mine | ForEach-Object { [ordered]@{name=$_.Name; id=$_.Id.Guid; state=[string]$_.State; uptime=[string]$_.Uptime; created=$_.CreationTime.ToUniversalTime().ToString('o'); notes=(trim $_.Notes 400)} })
$o.allVms=@($all | ForEach-Object { [ordered]@{name=$_.Name; state=[string]$_.State; uptime=[string]$_.Uptime} })
# 4. Hyper-V events (last 24 h) naming those VMs, or, if none exist any more, naming enclave-app VMs
$names=@($mine | ForEach-Object { $_.Name }); $ids=@($mine | ForEach-Object { $_.Id.Guid })
# VM names/ids this deployment's log lines mention (a retired VM is no longer in Get-VM)
$txt=(@($o['lines_node.log'])+@($o['lines_shield.log'])+@($o.mgrRecords | ForEach-Object { $_ | ConvertTo-Json -Depth 6 -Compress })) -join "`n"
$names=@($names + @([regex]::Matches($txt,'enclave-app-[A-Za-z0-9-]+') | ForEach-Object { $_.Value })) | Select-Object -Unique
$ids=@($ids + @([regex]::Matches($txt,'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}') | ForEach-Object { $_.Value })) | Select-Object -Unique
$o.namesFromLogs=$names; $o.idsFromLogs=$ids
foreach($log in 'Microsoft-Windows-Hyper-V-Worker-Admin','Microsoft-Windows-Hyper-V-VMMS-Admin'){
  try{ $ev=@(Get-WinEvent -FilterHashtable @{LogName=$log; StartTime=(Get-Date).AddHours(-24)} -ErrorAction Stop)
       $hit=@($ev | Where-Object { $m=[string]$_.Message; ($names | Where-Object { $m -match [regex]::Escape($_) }) -or ($ids | Where-Object { $m -match $_ }) })
       if(-not $hit.Count){ $hit=@($ev | Where-Object { [string]$_.Message -match 'enclave-app' -and @(18500,18502,18504,18508,18510,18512,18514,18515,18516,18560,18590,18596) -contains $_.Id }) }
       $o["events_$log"]=@($hit | Sort-Object TimeCreated | Select-Object -Last 150 | ForEach-Object { $_.TimeCreated.ToUniversalTime().ToString('o')+' ['+$_.Id+'] '+(trim $_.Message 500) }) }catch{ $o["eventsErr_$log"]=$_.Exception.Message } }
# 5. kept partition consoles: the newest files, and the tail of each file belonging to this deployment's VMs
$P=Join-Path $L 'partitions'
try{ $files=@(Get-ChildItem -LiteralPath $P -File | Sort-Object LastWriteTimeUtc -Descending)
  $o.partitionFiles=@($files | Select-Object -First 40 | ForEach-Object { $_.Name+' '+$_.Length+' '+$_.LastWriteTimeUtc.ToString('o') })
  $want=@($files | Where-Object { $n=$_.Name; $names | Where-Object { $n.StartsWith($_) } })
  $o.consoleTails=[ordered]@{}; foreach($f in $want){ $o.consoleTails[$f.Name]=@(Get-Content -LiteralPath $f.FullName -Tail 150 | ForEach-Object { trim $_ 300 }) } }catch{ $o.partitionErr=$_.Exception.Message }
'RESULT '+($o | ConvertTo-Json -Depth 6 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
out = pathlib.Path(__file__).parent / 'probe1.out'
out.write_bytes(r.stdout + r.stderr)
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout))
raise SystemExit(r.returncode)
