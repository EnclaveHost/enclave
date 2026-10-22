$ErrorActionPreference='Stop'
Get-VM -Name enclave-control|Select-Object Name,State,Status,Uptime,CPUUsage|ConvertTo-Json -Compress
Get-VMIntegrationService -VMName enclave-control|Select-Object Name,Enabled,PrimaryStatusDescription,SecondaryStatusDescription|ConvertTo-Json -Compress
