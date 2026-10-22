$ErrorActionPreference='Stop'
# READ-ONLY restart-plan metadata: \Enclave\Node task, its cmd.exe + node agent processes, run-node.cmd / node-config.cmd
# (sha, mtime, structure; `set` NAMES only, no values), installed version, and every control-tree file changed after the
# agent process started (a node restart would load those).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(110);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$PD=Join-Path $env:ProgramData 'Enclave'; $PF=Join-Path $env:ProgramFiles 'Enclave'
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
"TASK state=$($t.State) actions=$(@($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ') triggers=$(@($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ',')"
$i=Get-ScheduledTaskInfo -TaskPath '\Enclave\' -TaskName 'Node'; "TASKINFO lastRun=$(([datetime]$i.LastRunTime).ToUniversalTime().ToString('o')) lastResult=$($i.LastTaskResult)"
$procs=@(Get-CimInstance Win32_Process -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like '*run-node.cmd*' -or [string]$_.CommandLine -like '*\windows\node\agent.mjs*' })
foreach($p in $procs){ $cl=[string]$p.CommandLine -replace '[A-Za-z0-9+/=_-]{40,}','<long>'; "PROC pid=$($p.ProcessId) ppid=$($p.ParentProcessId) name=$($p.Name) started=$(([datetime]$p.CreationDate).ToUniversalTime().ToString('o')) cmd=$($cl.Substring(0,[Math]::Min(200,$cl.Length)))" }
$agent=@($procs | Where-Object { $_.Name -eq 'node.exe' })[0]; $start=([datetime]$agent.CreationDate).ToUniversalTime()
foreach($f in 'run-node.cmd','node-config.cmd'){ $p=Join-Path $PD $f; $it=Get-Item $p
  "FILE $f sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()) mtime=$($it.LastWriteTimeUtc.ToString('o')) lines=$(@(Get-Content $p).Count)"
  @(Get-Content $p) | ForEach-Object { if($_ -match '^\s*set\s+"?([A-Za-z0-9_]+)='){ "  set $($Matches[1])=<value>" } elseif($_ -match '^\s*(call|cd|:loop|goto|ping|echo|@echo|rem)\b'){ "  $($_.Substring(0,[Math]::Min(120,$_.Length)) -replace '[A-Za-z0-9+/=_-]{40,}','<long>')" } elseif($_.Trim()){ "  <other line, $($_.Length) chars>" } } }
"VERSION $((Get-Content (Join-Path $PF 'manifest.json') -Raw | ConvertFrom-Json).version)"
$ctl=Join-Path $PF 'control'
$newer=@(Get-ChildItem $ctl -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt $start })
"CHANGED-AFTER-AGENT-START ($($start.ToString('o'))): $($newer.Count) file(s)"
$newer | Select-Object -First 30 | ForEach-Object { "  $($_.FullName.Substring($ctl.Length)) $($_.Length) $($_.LastWriteTimeUtc.ToString('o')) $((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower().Substring(0,16))" }
foreach($f in 'windows\node\hvcert.mjs','windows\node\agent.mjs','windows\node\host.mjs','windows\node\apptls.mjs','isolation\m4\guestd\supervisor-guestcert.mjs'){ $p=Join-Path $ctl $f; if(Test-Path $p){ "SRC $f $((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()) $((Get-Item $p).LastWriteTimeUtc.ToString('o'))" } else { "SRC $f absent" } }
