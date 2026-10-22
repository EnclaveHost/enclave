$ErrorActionPreference='Stop'
# READ-ONLY: VM GUID -> partition name for the 9 bridges; node-config.cmd lines that name SHIELDED_BRIDGE (value kept only
# if numeric); established-stream count of each bridge sampled 5 times over 20 s.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
Get-VM | ForEach-Object { "VM $($_.Id.ToString().Substring(0,8)) $($_.Name) $($_.State)" }
$cfg=Join-Path $env:ProgramData 'Enclave\node-config.cmd'
if(Test-Path $cfg){ @(Get-Content $cfg | Where-Object { $_ -match 'SHIELDED_BRIDGE|BRIDGE_MAX|MAX_CONNS' }) | ForEach-Object { if($_ -match '=\s*\d+\s*$'){ "CFG $_" } else { "CFG " + ($_ -replace '=.*$','=<non-numeric>') } }; "CFG lines naming the bridge: done" } else { "no node-config.cmd" }
$b=@(Get-CimInstance Win32_Process -Filter "Name='shielded-bridge.exe'" -OperationTimeoutSec 20)
for($i=0;$i -lt 5;$i++){ $c=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)
  $line="T+$($i*5)s"; foreach($p in $b){ $id=[regex]::Match([string]$p.CommandLine,'[0-9a-f]{8}-[0-9a-f]{4}-').Value; $n=@($c | Where-Object { $_.OwningProcess -eq $p.ProcessId }).Count; $line+=" $($id.Substring(0,8))=$n" }; $line; Start-Sleep -Seconds 5 }
