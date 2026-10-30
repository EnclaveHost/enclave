$ErrorActionPreference='Stop'
$v=@(Get-VM -Name 'enclave-control' -ErrorAction Stop)
if ($v.Count -ne 1) { throw 'Expected exactly one enclave-control VM' }
$m=Get-VMMemory -VM $v[0] -ErrorAction Stop
$o=Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  readOnly=$true; capacityAdmitted=$false
  vm=[pscustomobject]@{
    Name=$v[0].Name; Id=$v[0].Id.ToString(); State=$v[0].State.ToString()
    MemoryAssigned=[int64]$v[0].MemoryAssigned; MemoryDemand=[int64]$v[0].MemoryDemand
    ProcessorCount=[int]$v[0].ProcessorCount; Generation=[int]$v[0].Generation
    DynamicMemoryEnabled=[bool]$m.DynamicMemoryEnabled
    Minimum=[int64]$m.Minimum; Maximum=[int64]$m.Maximum; Startup=[int64]$m.Startup
  }
  host=[pscustomobject]@{TotalVisibleMemoryKiB=[int64]$o.TotalVisibleMemorySize;FreePhysicalMemoryKiB=[int64]$o.FreePhysicalMemory}
}|ConvertTo-Json -Depth 5 -Compress
