# PREPARED ONLY. Not executed or syntax-qualified. Public source hashes only.
# Same known listener PIDs/releases as c82f06750fa44cc59381f5c0b05874e4.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
function PublicHash([string]$p){
 $i=Get-Item -LiteralPath $p -Force
 if($i.PSIsContainer -or ($i.Attributes-band [IO.FileAttributes]::ReparsePoint) -or $i.Length-gt 1048576){throw 'source file bound'}
 $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
 $a=Get-Item -LiteralPath $p -Force
 if($a.Length-ne $i.Length -or $a.LastWriteTimeUtc-ne $i.LastWriteTimeUtc){throw 'source changed during read'}
 @{path=$p;bytes=$i.Length;sha256=$h}
}
function ProcessBinding($s){
 $ls=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter ('LocalPort='+$s.port+' AND State=2') -OperationTimeoutSec 3|Select-Object -ExpandProperty OwningProcess -Unique)
 if($ls.Count-ne 1 -or $ls[0]-ne $s.processId){throw 'listener changed'}
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$s.processId) -OperationTimeoutSec 3
 if(!$p -or $p.CreationDate.ToUniversalTime().ToString('o')-cne $s.created){throw 'process incarnation changed'}
 if(-not [regex]::IsMatch([string]$p.CommandLine,[regex]::Escape($s.entry))){throw 'entry path changed'}
 return $p
}
$specs=@(
 @{port=8091;processId=38076;created='2026-10-26T17:17:18.5617520Z';root='C:\Program Files\Enclave\control';entry='C:\Program Files\Enclave\control\windows\vbslike\manager\main.mjs';pin=$null},
 @{port=8095;processId=41308;created='2026-10-27T08:02:19.4407050Z';root='C:\ProgramData\Enclave\native-manager\releases\58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929\control';entry='C:\ProgramData\Enclave\native-manager\releases\58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929\bootstrap.mjs';pin='58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929'},
 @{port=8097;processId=40360;created='2026-10-27T08:24:42.8500370Z';root='C:\ProgramData\Enclave\native-manager\releases\93564093040d89309bbac1b7220e5000aef77f481b68d58a0a4e8ac10748c292\control';entry='C:\ProgramData\Enclave\native-manager\releases\93564093040d89309bbac1b7220e5000aef77f481b68d58a0a4e8ac10748c292\bootstrap.mjs';pin='93564093040d89309bbac1b7220e5000aef77f481b68d58a0a4e8ac10748c292'}
)
$rows=@()
foreach($s in $specs){
 $before=ProcessBinding $s;$files=@()
 if($s.pin){
  $manifest=PublicHash (Join-Path (Split-Path $s.root -Parent) 'source-manifest.json')
  if($manifest.sha256-cne $s.pin){throw 'release manifest differs'};$files+=$manifest
 }
 $rels=@('manager\desktop-memory.mjs','manager\memory-share.mjs','manager\wmi-launcher.mjs','manager\server.mjs')
 if($s.port-eq 8097){$rels+=@('router\main.mjs','router\control.mjs','router\platform.mjs')}
 foreach($rel in $rels){$files+=PublicHash (Join-Path $s.root ('windows\vbslike\'+$rel))}
 $after=ProcessBinding $s
 if($before.CommandLine-cne $after.CommandLine){throw 'command changed'}
 $rows+=@{port=$s.port;processId=$s.processId;created=$s.created;releasePin=$s.pin;files=$files}
}
@{schema='minipc-sizing-source-binding/1';readOnly=$true;atUtc=[DateTime]::UtcNow.ToString('o');rows=$rows;loadedModuleBytesProven=$false;capacityAdmitted=$false}|ConvertTo-Json -Depth 7 -Compress
