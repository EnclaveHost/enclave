$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
$vm=Get-VM -Name enclave-storage
[pscustomobject]@{totalRAMMiB=[math]::Round($os.TotalVisibleMemorySize/1024);freeRAMMiB=[math]::Round($os.FreePhysicalMemory/1024);storageRAMMiB=$vm.MemoryAssigned/1MB;storageVCPU=$vm.ProcessorCount;diskFreeGiB=[math]::Round((Get-Volume -DriveLetter C).SizeRemaining/1GB)}|ConvertTo-Json -Compress
