$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$names=@('New-VM','Set-VM','Set-VMMemory','Set-VMProcessor','Start-VM','Stop-VM','Get-VM','Get-Job','Stop-Job','Register-ScheduledTask','New-ScheduledTaskAction','New-ScheduledTaskTrigger','New-ScheduledTaskSettingsSet','Get-ScheduledTask','Get-ScheduledTaskInfo','Start-ScheduledTask','Stop-ScheduledTask','Unregister-ScheduledTask')
$rows=@()
foreach($name in $names){
 $c=Get-Command -Name $name -ErrorAction Stop
 $sets=@(foreach($s in $c.ParameterSets){@{name=$s.Name;parameters=@($s.Parameters|ForEach-Object Name)}})
 $rows+=@{name=$name;commandType=[string]$c.CommandType;source=$c.Source;version=[string]$c.Version;sets=$sets}
}
$os=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory -OperationTimeoutSec 3
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property DeviceID,FreeSpace,Size,FileSystem -OperationTimeoutSec 3
$vms=@(Get-VM|Select-Object Id,Name,State,MemoryAssigned,MemoryStartup,DynamicMemoryEnabled)
if($vms.Count-gt 32){throw 'VM bound'}
$id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
[pscustomobject]@{schema='owned-rpc-guardian-capability/1';readOnly=$true;atUtc=[DateTime]::UtcNow.ToString('o');boot=$os.LastBootUpTime.ToUniversalTime().ToString('o');physicalBytes=([int64]$os.TotalVisibleMemorySize*1024);freeBytes=([int64]$os.FreePhysicalMemory*1024);diskFreeBytes=[int64]$disk.FreeSpace;filesystem=$disk.FileSystem;stopwatchFrequency=[Diagnostics.Stopwatch]::Frequency;stopwatchTicks=[Diagnostics.Stopwatch]::GetTimestamp();powershellVersion=[string]$PSVersionTable.PSVersion;isAdministrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);commands=$rows;vms=$vms;tasksChanged=$false;vmsChanged=$false}|ConvertTo-Json -Depth 9 -Compress
