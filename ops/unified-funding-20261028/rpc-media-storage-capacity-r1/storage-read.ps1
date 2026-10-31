$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$r='C:\EnclaveRpcBootMedia-af667437b1764a459adf62912a5ce2bf\af667437b1764a459adf62912a5ce2bf'
$f=Get-Item -LiteralPath ($r+'\boot.vhdx')
$v=Get-VHD -Path $f.FullName
$free=[int64]$d.FreeSpace
$max=4GB
$required=16GB+256MB+[Math]::Max(0,($max-$f.Length))
[ordered]@{atUtc=[DateTime]::UtcNow.ToString('o');boot=$os.LastBootUpTime.ToUniversalTime().ToString('o');physicalBytes=[int64]$os.TotalVisibleMemorySize*1024;freeMemoryBytes=[int64]$os.FreePhysicalMemory*1024;diskFreeBytes=$free;bootFileBytes=$f.Length;bootVirtualBytes=$v.Size;bootAttached=$v.Attached;bootMaximumEnvelopeBytes=$max;diskFloorBytes=16GB;artifactAllowanceBytes=256MB;requiredDiskFreeAfterStagingBytes=$required;diskBudgetFits=($free-ge $required);capacityAdmitted=$false;nativeVmAttempted=$false}|ConvertTo-Json -Compress
