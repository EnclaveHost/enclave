$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity=[IntPtr]2
$filter="Name='steam.exe' OR Name='steamwebhelper.exe' OR Name='RustClient.exe' OR Name='Rust.exe' OR Name='ds.exe' OR Name='ds2.exe' OR Name='witcher3.exe' OR Name='SkyrimSE.exe' OR Name='Morrowind.exe' OR Name='DOSBox.exe' OR Name='pragmata.exe'"
$rows=@(Get-CimInstance Win32_Process -Filter $filter -Property Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath,WorkingSetSize,PrivatePageCount -OperationTimeoutSec 3)
if($rows.Count -gt 48){throw 'Game process bound'}
$out=@(foreach($row in $rows){
 $p=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
 try{$held=$p.Handle;$created=$p.StartTime.ToUniversalTime().ToFileTimeUtc();if($p.HasExited){throw 'Process exited during observation'}
  if($p.ProcessName+'.exe' -ine $row.Name -or $p.MainModule.FileName -ine $row.ExecutablePath){throw 'Process image changed'}
  [ordered]@{name=$row.Name;pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;creationFileTime=$created.ToString();path=$row.ExecutablePath;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64}
 }finally{$p.Dispose()}
})
[ordered]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');processId=$PID;creationFileTime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString());processes=$out;readOnly=$true;capacityAdmitted=$false;processesTerminated=$false}|ConvertTo-Json -Depth 5 -Compress
