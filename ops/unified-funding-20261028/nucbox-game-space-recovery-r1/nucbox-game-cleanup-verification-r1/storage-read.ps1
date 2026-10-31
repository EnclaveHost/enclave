$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
 $items=ConvertFrom-Json '[{"task":"CodexGameUninstall-4dddf5cd0e0a476ea983f34f33e70508","root":"C:\\ProgramData\\CodexGameCleanup-4dddf5cd0e0a476ea983f34f33e70508","appId":1174180},{"root":"C:\\ProgramData\\CodexGameCleanup-d1813407cc0d4d79a13c28bfedd77613","task":"CodexGameDialog-d1813407cc0d4d79a13c28bfedd77613"},{"root":"C:\\ProgramData\\CodexGameCleanup-4c8714fbcfb849baace662cc5f237838","task":"CodexGameDialog-4c8714fbcfb849baace662cc5f237838"},{"root":"C:\\ProgramData\\CodexGameCleanup-28a500e254fc488a8c0909b1d9d01ead","task":"CodexGameConfirm-28a500e254fc488a8c0909b1d9d01ead","reviewedDialogSha256":"53430ce9ef231157a0acbf94dccfdf6af2733f4eaa82603b430e3682e7665b11","appId":1174180}]'
 $service=New-Object -ComObject Schedule.Service;$service.Connect();$folder=$service.GetFolder('\');$removed=@()
 foreach($item in $items){
  $task=$folder.GetTask($item.task);$d=$task.Definition;$act=$d.Actions.Item(1);$expected='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+$item.root+'\desktop.ps1"'
  if($task.State -ne 3 -or $task.LastTaskResult -ne 0 -or $d.Principal.UserId -ne 'NUCBOX_K11\srbat' -or $d.Actions.Count -ne 1 -or $act.Path -ne 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or $act.Arguments -ne $expected){throw 'Exact completed game task association differs'}
  $folder.DeleteTask($item.task,0);$removed+=$item.task
 }
 $listeners=@(Get-NetTCPConnection -State Listen|Where-Object {$_.LocalPort -in @(8091,8095,8097,9600)}|ForEach-Object {$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess);[ordered]@{port=$_.LocalPort;pid=$p.ProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');exe=$p.ExecutablePath}})
 $os=Get-CimInstance Win32_OperatingSystem;$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 $vms=@(Get-VM|Select-Object Id,Name,State,MemoryAssigned,MemoryStartup)
 [ordered]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');removedCompletedTasks=$removed;diskFreeBytes=[int64]$disk.FreeSpace;freeMemoryBytes=[int64]$os.FreePhysicalMemory*1024;listeners=$listeners;vms=$vms;manifestExists=(Test-Path -LiteralPath 'C:\Program Files (x86)\Steam\steamapps\appmanifest_1174180.acf');gameDirectoryExists=(Test-Path -LiteralPath 'C:\Program Files (x86)\Steam\steamapps\common\Red Dead Redemption 2');uninstallEntryExists=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 1174180');nativeVmAttempted=$false}|ConvertTo-Json -Depth 8 -Compress
}catch{[ordered]@{success=$false;error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json -Compress}
