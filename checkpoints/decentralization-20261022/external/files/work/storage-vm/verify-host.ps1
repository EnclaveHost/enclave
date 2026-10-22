$ErrorActionPreference='Stop'
$node=Invoke-RestMethod http://127.0.0.1:9600/v1/host/state
$baseline=Get-Content -Raw 'C:\ProgramData\Enclave\storage-vm\baseline-vms.json'|ConvertFrom-Json
$changed=@()
foreach($b in $baseline){$v=Get-VM -Id $b.Id;if($v.State.ToString() -ne 'Running'){$changed+=$b.Name}}
$n=Get-Content 'C:\ProgramData\Enclave\network\state\status.json'|ConvertFrom-Json
[pscustomobject]@{checkedAt=[DateTime]::UtcNow.ToString('o');runningDeployments=@($node.deployments|Where-Object status -eq 'running').Count;originalGuestsStillRunning=($changed.Count -eq 0);originalGuestCount=$baseline.Count;networkApps=@($n.apps).Count;networkStates=@($n.apps|Select-Object deploymentId,ready,state,fallbackActive)}|ConvertTo-Json -Depth 4 -Compress
