$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$roots=@('C:\EnclaveRpcDefinition-e394979cb25c470680c2e0b48c07e813\e394979cb25c470680c2e0b48c07e813','C:\EnclaveRpcVm-7647ee54e3c24997bb8ab5da70427109\7647ee54e3c24997bb8ab5da70427109')
$names=@('controller.consumed','contract.txt','owner.consumed','observer.consumed','child.consumed','owner.result','observer.result','child.result','child.binding','admit','attached','release','definition-plan.txt','definition.intent','definition.submit','definition.submit.pending','definition.native','definition.native.pending','definition.receipt','definition.job','definition.terminal','definition.system','definition.off')
$results=@(foreach($root in $roots){
 $files=@(foreach($name in $names){$path=Join-Path $root $name;if([IO.File]::Exists($path)){
  if([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse journal refused'}
  $f=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{if($f.Length -gt 8192){throw 'Journal bound'};$b=New-Object byte[] ([int]$f.Length);$offset=0;while($offset -lt $b.Length){$n=$f.Read($b,$offset,$b.Length-$offset);if($n -le 0){throw 'Short journal'};$offset+=$n};@{name=$name;bytes=$b.Length;text=[Text.Encoding]::UTF8.GetString($b)}}finally{$f.Dispose()}
 }})
 @{root=$root;exists=[IO.Directory]::Exists($root);files=$files}
})
$exactDeaths=@(foreach($pair in @(@(45832,'134379618832680790'),@(37372,'134379618832680770'),@(53600,'134379618834228246'),@(56944,'134379619777781272'))){
 $q=$null;try{$q=[Diagnostics.Process]::GetProcessById([int]$pair[0]);$h=$q.Handle;$c=$q.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();@{pid=$pair[0];expectedCreation=$pair[1];sameIncarnationAlive=(!$q.HasExited -and $c -ceq $pair[1]);currentCreation=$c}}catch [ArgumentException]{@{pid=$pair[0];expectedCreation=$pair[1];sameIncarnationAlive=$false;absent=$true}}finally{if($q){$q.Dispose()}}
})
$procs=@(Get-CimInstance Win32_Process -Filter "Name='definition-controller.exe' OR Name='entry.exe'" -Property ProcessId,CreationDate,ExecutablePath,CommandLine -OperationTimeoutSec 3|Where-Object{$_.CommandLine -like '*e394979cb25c470680c2e0b48c07e813*'}|Select-Object ProcessId,CreationDate,ExecutablePath)
if($procs.Count -gt 8){throw 'Exact process bound'}
$tasks=@(foreach($name in @('EnclaveRpcDefinition-e394979cb25c470680c2e0b48c07e813-owner','EnclaveRpcDefinition-e394979cb25c470680c2e0b48c07e813-observer')){$t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($t){@{name=$name;state=[string]$t.State}}})
$vms=@(Get-VM|Select-Object Id,State,MemoryAssigned,Name,Path);if($vms.Count -gt 32){throw 'VM bound'}
$x=[Diagnostics.Process]::GetProcessById(38076);try{$h=$x.Handle;$creation=$x.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();if($x.HasExited -or $creation -cne '134375086385617521'){throw 'Original8091 changed'}}finally{$x.Dispose()}
[pscustomobject]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');processId=$PID;creationFileTime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString());exactDeaths=$exactDeaths;roots=$results;exactDefinitionProcesses=$procs;exactTasks=$tasks;vms=$vms;original8091Alive=$true;readOnly=$true;noRetry=$true;reservationMayRelease=$false}|ConvertTo-Json -Depth 12 -Compress
