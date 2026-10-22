$ErrorActionPreference='Stop'
$vm=Get-VM -Name enclave-control
[pscustomobject]@{Name=$vm.Name;State=$vm.State.ToString();Id=$vm.Id.ToString();IPAddresses=@((Get-VMNetworkAdapter -VMName enclave-control).IPAddresses)}|ConvertTo-Json -Compress
