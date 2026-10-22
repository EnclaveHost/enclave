$ErrorActionPreference='Stop'
# READ-ONLY: for every shielded-bridge: VM id, worker port -> the shield-egress process listening there, its start time and
# its -deployment / -app-routes arguments (public deployment id, a state path); plus the VM name.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(90);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$vms=@{}; Get-VM | ForEach-Object { $vms[$_.Id.ToString()]=$_.Name }
$ps=@(Get-CimInstance Win32_Process -Filter "Name='shielded-bridge.exe' OR Name='shield-egress.exe'" -OperationTimeoutSec 20)
$listen=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
foreach($b in ($ps | Where-Object { $_.Name -eq 'shielded-bridge.exe' })){
  $a=([string]$b.CommandLine) -split '\s+' | Where-Object { $_ }; $vm=[regex]::Match([string]$b.CommandLine,'[0-9a-f]{8}-[0-9a-f-]{27}').Value
  $port=[int]$a[-2]; $own=@($listen | Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -eq '127.0.0.1' })[0]
  $eg=if($own){ @($ps | Where-Object { $_.ProcessId -eq $own.OwningProcess })[0] } else { $null }
  $dep=if($eg){ [regex]::Match([string]$eg.CommandLine,'-deployment\s+(\S+)').Groups[1].Value } else { '' }
  $routes=if($eg){ [regex]::Match([string]$eg.CommandLine,'-app-routes\s+(\S+)').Groups[1].Value } else { '' }
  "BRIDGE vm=$($vm.Substring(0,8)) name=$($vms[$vm]) bridgeStart=$(([datetime]$b.CreationDate).ToUniversalTime().ToString('HH:mm:ss')) port=$port egressPid=$($own.OwningProcess) egressStart=$(if($eg){([datetime]$eg.CreationDate).ToUniversalTime().ToString('HH:mm:ss')}) deployment=[$dep] len=$($dep.Length) routes=$routes"
}
"EGRESS processes without a bridge mapping:"; foreach($e in ($ps | Where-Object { $_.Name -eq 'shield-egress.exe' })){ "  pid=$($e.ProcessId) start=$(([datetime]$e.CreationDate).ToUniversalTime().ToString('HH:mm:ss')) dep=[$([regex]::Match([string]$e.CommandLine,'-deployment\s+(\S+)').Groups[1].Value)]" }
