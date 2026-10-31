$ErrorActionPreference='Stop'
$expected=@(@{pid=33548;creation='134379547304582514'})
$rows=@(foreach($row in $expected){
 $process=$null
 try {$process=[Diagnostics.Process]::GetProcessById($row.pid)}catch [ArgumentException] {}
 if($null -eq $process){@{pid=$row.pid;expectedCreation=$row.creation;exactAbsent=$true;pidPresent=$false};continue}
 try {
  $held=$process.Handle;$created=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
  @{pid=$row.pid;expectedCreation=$row.creation;actualCreation=$created;exactAbsent=($created -cne $row.creation -or $process.HasExited);pidPresent=$true}
 } finally {$process.Dispose()}
})

$paths=@('C:\EnclaveRpcClock-856c8213f2a149c3a24e27904e2093c6\856c8213f2a149c3a24e27904e2093c6\clock-sample.exe','C:\EnclaveRpcFiles-495a41c7dda146ab9b27b54b7fce61a8\495a41c7dda146ab9b27b54b7fce61a8\transition-files.exe')
$running=@(Get-CimInstance Win32_Process -Filter "Name='clock-sample.exe' OR Name='transition-files.exe'" -Property ProcessId,CreationDate,ExecutablePath -OperationTimeoutSec 3|Where-Object {$paths -ccontains $_.ExecutablePath}|Select-Object ProcessId,CreationDate,ExecutablePath)
$managers=@(foreach($managerPid in @(41272,40360,41308,38076)){$exact=[Diagnostics.Process]::GetProcessById($managerPid);try{$held=$exact.Handle;@{pid=$managerPid;creation=$exact.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();alive=(-not $exact.HasExited)}}finally{$exact.Dispose()}})
$path='C:\EnclaveRpcInputs-003a39cead10462ab567812da54b8455\003a39cead10462ab567812da54b8455\observation.json';$item=Get-Item -LiteralPath $path;if($item.Length -gt 32768 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Staged readback differs'}
$hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();if($hash -cne '2caf195f409318db6da9769ce98e99607ee13b44d5aafd4821ce0e12e1321ab7'){throw 'Staged digest differs'}
$vms=@(Get-VM|Select-Object Id,State,MemoryAssigned)
[pscustomobject]@{stagedFile=@{bytes=$item.Length;sha256=$hash};vms=$vms;success=$true;atUtc=[DateTime]::UtcNow.ToString('o');processes=$rows;exactPathsRunning=$running;managers=$managers;readOnly=$true}|ConvertTo-Json -Depth 6 -Compress
