$ErrorActionPreference='Stop'
$o=Get-CimInstance Win32_OperatingSystem
$v=@(Get-VM | Select-Object Id,State,MemoryAssigned,MemoryDemand,DynamicMemoryEnabled,MemoryStartup,MemoryMinimum,MemoryMaximum,ProcessorCount)
[pscustomobject]@{observedUtc=[DateTime]::UtcNow.ToString('o');bootUtc=$o.LastBootUpTime.ToUniversalTime().ToString('o');totalPhysicalKiB=[int64]$o.TotalVisibleMemorySize;freePhysicalKiB=[int64]$o.FreePhysicalMemory;totalVirtualKiB=[int64]$o.TotalVirtualMemorySize;freeVirtualKiB=[int64]$o.FreeVirtualMemory;vms=$v;pendingCommitments='NOT_QUERIED';admitted=$false}|ConvertTo-Json -Depth 5 -Compress
