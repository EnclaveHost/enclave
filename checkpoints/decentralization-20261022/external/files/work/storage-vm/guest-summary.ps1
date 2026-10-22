$ErrorActionPreference='Stop'
$s=Invoke-RestMethod http://127.0.0.1:9600/v1/host/state
$s.deployments|Where-Object {$_.id -like '0xef514ed3*' -or $_.deploymentId -like '0xef514ed3*'}|Select-Object id,deploymentId,status,engine,runtime,egress,vmId|ConvertTo-Json -Depth 3
Get-ChildItem 'C:\ProgramData\Enclave' -Filter '*log*' -Recurse -ErrorAction SilentlyContinue|Where-Object {$_.FullName -match 'network|manager'}|Select-Object -First 20 FullName,LastWriteTime|ConvertTo-Json -Compress
