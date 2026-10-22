$ErrorActionPreference='Continue'
Get-VMNetworkAdapter -VMName enclave-storage|Select-Object IPAddresses,MacAddress,Status|ConvertTo-Json -Compress
Get-NetNeighbor -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4|Where-Object LinkLayerAddress -eq '00-15-5D-01-33-16'|Select-Object IPAddress,State|ConvertTo-Json -Compress
Get-VMIntegrationService -VMName enclave-storage|Select-Object Name,Enabled,PrimaryStatusDescription,SecondaryStatusDescription|ConvertTo-Json -Compress
