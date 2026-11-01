$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$roots=@('C:\EnclaveRpcDefinition-f0155374b4744102a51890a69de4b5c6\f0155374b4744102a51890a69de4b5c6','C:\EnclaveRpcVm-7a8586db00c64f6f8ab024ae134fe641\7a8586db00c64f6f8ab024ae134fe641')
$names=@('controller.consumed','contract.txt','owner.consumed','observer.consumed','child.consumed','owner.result','observer.result','child.result','owner.failure','observer.failure','child.failure','child.binding','admit','attached','release','definition-plan.txt','definition.intent','definition.submit','definition.submit.pending','definition.native','definition.native.pending','definition.invoke','definition.invoke.pending','definition.receipt','definition.job','definition.terminal','definition.system','definition.off')
$names+=@('preparation.before-scope','preparation.after-scope','preparation.after-service','preparation.after-system','preparation.after-memory','preparation.after-cpu','preparation.after-parameters','preparation.after-system-text','preparation.after-memory-text','preparation.after-cpu-text','preparation.after-input','preparation.after-dispose')
$results=@(foreach($root in $roots){
 $files=@(foreach($name in $names){$path=Join-Path $root $name;if([IO.File]::Exists($path)){
  if([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse journal refused'}
  $f=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{if($f.Length -gt 8192){throw 'Journal bound'};$b=New-Object byte[] ([int]$f.Length);$offset=0;while($offset -lt $b.Length){$n=$f.Read($b,$offset,$b.Length-$offset);if($n -le 0){throw 'Short journal'};$offset+=$n};@{name=$name;bytes=$b.Length;text=[Text.Encoding]::UTF8.GetString($b)}}finally{$f.Dispose()}
 }})
 @{root=$root;exists=[IO.Directory]::Exists($root);files=$files}
})
$roleDeaths=@(foreach($role in @('owner','observer','child')){
 $record=@($results[0].files|Where-Object{$_.name -ceq ($role+'.consumed')})
 if($record.Count -ne 1){throw 'Exact role receipt missing'}
 $parts=$record[0].text.Split(',');if($parts.Length -ne 4 -or $parts[3] -cne $role){throw 'Role identity shape'}
 $q=$null;try{$q=[Diagnostics.Process]::GetProcessById([int]$parts[0]);$h=$q.Handle;$c=$q.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();@{role=$role;pid=$parts[0];expectedCreation=$parts[1];sameIncarnationAlive=(!$q.HasExited -and $c -ceq $parts[1]);currentCreation=$c}}catch [ArgumentException]{@{role=$role;pid=$parts[0];expectedCreation=$parts[1];sameIncarnationAlive=$false;absent=$true}}finally{if($q){$q.Dispose()}}
})
$procs=@(Get-CimInstance Win32_Process -Filter "Name='definition-controller.exe' OR Name='definition-entry.exe'" -Property ProcessId,CreationDate,ExecutablePath,CommandLine -OperationTimeoutSec 3|Where-Object{$_.CommandLine -like '*f0155374b4744102a51890a69de4b5c6*'}|Select-Object ProcessId,CreationDate,ExecutablePath)
if($procs.Count -gt 8){throw 'Exact process bound'}
$tasks=@(foreach($name in @('EnclaveRpcDefinition-f0155374b4744102a51890a69de4b5c6-owner','EnclaveRpcDefinition-f0155374b4744102a51890a69de4b5c6-observer')){$t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($t){@{name=$name;state=[string]$t.State}}})
$vms=@(Get-VM|Select-Object Id,State,MemoryAssigned,Name,Path);if($vms.Count -gt 32){throw 'VM bound'}
$x=[Diagnostics.Process]::GetProcessById(38076);try{$h=$x.Handle;$creation=$x.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();if($x.HasExited -or $creation -cne '134375086385617521'){throw 'Original8091 changed'}}finally{$x.Dispose()}
$priorDeaths=@(foreach($item in @(@{label='admission';pid=55168;creation='134379680047616114'},@{label='create';pid=51592;creation='134379680319304695'},@{label='verify';pid=43376;creation='134379680643384919'})){
 $q=$null;try{$q=[Diagnostics.Process]::GetProcessById($item.pid);$h=$q.Handle;$c=$q.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();@{label=$item.label;pid=$item.pid;expectedCreation=$item.creation;sameIncarnationAlive=(!$q.HasExited -and $c -ceq $item.creation);currentCreation=$c}}catch [ArgumentException]{@{label=$item.label;pid=$item.pid;expectedCreation=$item.creation;sameIncarnationAlive=$false;absent=$true}}finally{if($q){$q.Dispose()}}
})
[pscustomobject]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');processId=$PID;creationFileTime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString());exactDeaths=$roleDeaths;priorStageDeaths=$priorDeaths;roots=$results;exactDefinitionProcesses=$procs;exactTasks=$tasks;vms=$vms;original8091Alive=$true;readOnly=$true;noRetry=$true;reservationMayRelease=$false}|ConvertTo-Json -Depth 12 -Compress
