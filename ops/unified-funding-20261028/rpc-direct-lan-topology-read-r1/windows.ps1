$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$a=@(Get-NetAdapter);if($a.Count -gt 32){throw 'adapters bound'}
$s=@(Get-VMSwitch);if($s.Count -gt 16){throw 'switch bound'}
$n=@(Get-VMNetworkAdapter -VMName enclave-control);if($n.Count -gt 8){throw 'NIC bound'}
$r=@(Find-NetRoute -RemoteIPAddress '__SOURCE_IP__');if($r.Count -gt 32){throw 'route bound'}
[pscustomobject]@{atUtc=[DateTime]::UtcNow.ToString('o');adapters=@($a|Select-Object Name,InterfaceIndex,Status,LinkSpeed,InterfaceDescription);switches=@($s|Select-Object Name,Id,SwitchType,NetAdapterInterfaceDescription);controlNics=@($n|Select-Object VMId,SwitchName,SwitchId,IPAddresses,Status);routes=@($r|Select-Object IPAddress,InterfaceIndex,NextHop,DestinationPrefix);readOnly=$true}|ConvertTo-Json -Depth 6 -Compress
