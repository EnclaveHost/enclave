$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'shield-egress.exe' -and $_.CommandLine -match '0xef514ed3'}
Get-NetTCPConnection -OwningProcess $p.ProcessId -State Established|Group-Object RemotePort|ForEach-Object{[pscustomobject]@{remotePort=$_.Name;count=$_.Count;oldest=($_.Group|Sort-Object CreationTime|Select-Object -First 1).CreationTime;newest=($_.Group|Sort-Object CreationTime|Select-Object -Last 1).CreationTime}}|ConvertTo-Json -Compress
