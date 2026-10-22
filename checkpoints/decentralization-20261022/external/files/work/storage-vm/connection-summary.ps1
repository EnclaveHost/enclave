$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'shield-egress.exe' -and $_.CommandLine -match '0xef514ed3'}
Get-NetTCPConnection -OwningProcess $p.ProcessId|Group-Object State|Select-Object Name,Count|ConvertTo-Json -Compress
(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Established).Count
Get-Content 'C:\ProgramData\Enclave\logs\partitions\enclave-app-hv4ebb03c81df5b7-ea9d4773.log' -Tail 500|ForEach-Object{[regex]::Matches($_,'public web: [a-z:-]+|egress [a-z:-]+|OOM|out of memory|panic|refused:[a-z-]+')|ForEach-Object{$_.Value}}|Group-Object|Select-Object Name,Count|ConvertTo-Json -Compress
