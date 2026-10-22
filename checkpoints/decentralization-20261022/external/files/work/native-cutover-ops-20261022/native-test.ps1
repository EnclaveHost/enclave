param([string]$Stage)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$helper=Join-Path $Stage 'bounded-query.ps1'
$tests=(& (Join-Path $Stage 'test-bounded-query.ps1') -Helper $helper)|ConvertFrom-Json
. $helper
$procs=Invoke-BoundedQuery { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 5 | Where-Object { [string]$_.CommandLine -like '*\control\windows\node\agent.mjs*' } | ForEach-Object { [ordered]@{ pid=[int]$_.ProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o') } }) } 15000
$listener=Invoke-BoundedQuery { @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'LocalPort=9600 AND State=2' -OperationTimeoutSec 5 | ForEach-Object { [int]$_.OwningProcess }) } 15000
if(-not $procs.ok -or -not $listener.ok -or @($procs.value).Count -ne 1 -or @($listener.value).Count -ne 1 -or $procs.value.pid -ne $listener.value) { throw 'native process/listener consistency check failed' }
[ordered]@{pass=$true;tests=$tests;processQuery=$procs;listenerQuery=$listener;readOnly=$true}|ConvertTo-Json -Depth 8 -Compress
