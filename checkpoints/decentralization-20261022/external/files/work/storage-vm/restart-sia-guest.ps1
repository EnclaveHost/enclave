$ErrorActionPreference='Stop'
$id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
$before=(Invoke-RestMethod http://127.0.0.1:8091/vms).vms
if(@($before|Where-Object {$_.launching}).Count -ne 0){throw 'A launch is already in progress; do not overlap'}
$target=@($before|Where-Object name -eq $id)
if($target.Count -ne 1 -or $target[0].status -ne 'running'){throw 'Sia guest is not uniquely running'}
$before|Select-Object id,name,status|ConvertTo-Json|Set-Content 'C:\ProgramData\Enclave\storage-vm\before-sia-dns-restart.json'
$body=@{id=$id;enclave='nucbox-k11-4';force=$true}|ConvertTo-Json -Compress
Invoke-RestMethod -Uri http://127.0.0.1:9600/v1/claim-hint -Method POST -ContentType 'application/json' -Body $body -TimeoutSec 300|ConvertTo-Json -Compress
