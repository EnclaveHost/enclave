$ErrorActionPreference='Stop'
Get-VM -Name enclave-storage|Select-Object Name,State,Status,Heartbeat|ConvertTo-Json -Compress
Get-VMNetworkAdapter -VMName enclave-storage|Select-Object SwitchName,IPAddresses,MacAddress|ConvertTo-Json -Compress
