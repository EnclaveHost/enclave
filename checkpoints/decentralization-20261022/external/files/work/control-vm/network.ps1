$ErrorActionPreference='Stop'
$mac=(Get-VMNetworkAdapter -VMName enclave-control).MacAddress
$match=($mac -replace '(..)(?!$)','$1-')
$neighbors=@(Get-NetNeighbor -AddressFamily IPv4|Where-Object LinkLayerAddress -eq $match|Select-Object IPAddress,LinkLayerAddress,State)
[pscustomobject]@{mac=$mac;neighbors=$neighbors;adapters=@(Get-NetIPAddress -InterfaceAlias '*Default Switch*' -AddressFamily IPv4|Select-Object IPAddress,PrefixLength)}|ConvertTo-Json -Depth 3 -Compress
