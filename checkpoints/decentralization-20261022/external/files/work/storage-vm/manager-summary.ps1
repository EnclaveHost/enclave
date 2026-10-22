$ErrorActionPreference='Stop'
$v=(Invoke-RestMethod http://127.0.0.1:8091/vms).vms
$v|ForEach-Object{[pscustomobject]@{keys=$_.PSObject.Properties.Name;id=$_.id;deploymentId=$_.deploymentId;name=$_.name;status=$_.status}}|ConvertTo-Json -Depth 4 -Compress
Get-ChildItem 'C:\ProgramData\Enclave\logs'|Select-Object Name,LastWriteTime|ConvertTo-Json -Compress
