$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$roots=@('C:\EnclaveRpcDefinition-d8dd438f26664cd0ad3065b30a97f436\d8dd438f26664cd0ad3065b30a97f436','C:\EnclaveRpcVm-7a8586db00c64f6f8ab024ae134fe641\7a8586db00c64f6f8ab024ae134fe641')
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
$procs=@(Get-CimInstance Win32_Process -Filter "Name='definition-controller.exe' OR Name='definition-entry.exe'" -Property ProcessId,CreationDate,ExecutablePath,CommandLine -OperationTimeoutSec 3|Where-Object{$_.CommandLine -like '*d8dd438f26664cd0ad3065b30a97f436*'}|Select-Object ProcessId,CreationDate,ExecutablePath)
if($procs.Count -gt 8){throw 'Exact process bound'}
$tasks=@(foreach($name in @('EnclaveRpcDefinition-d8dd438f26664cd0ad3065b30a97f436-owner','EnclaveRpcDefinition-d8dd438f26664cd0ad3065b30a97f436-observer')){$t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($t){@{name=$name;state=[string]$t.State}}})
$vms=@(Get-VM|Select-Object Id,State,MemoryAssigned,Name,Path);if($vms.Count -gt 32){throw 'VM bound'}
$x=[Diagnostics.Process]::GetProcessById(38076);try{$h=$x.Handle;$creation=$x.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();if($x.HasExited -or $creation -cne '134375086385617521'){throw 'Original8091 changed'}}finally{$x.Dispose()}
$priorDeaths=@(foreach($item in @(@{label='read-r1';pid=50212;creation='134379682877816054'},@{label='read-r2';pid=28280;creation='134379683304849901'},@{label='read-r3';pid=57864;creation='134379684023051581'},@{label='publish';pid=31188;creation='134379684123791305'})){
 $q=$null;try{$q=[Diagnostics.Process]::GetProcessById($item.pid);$h=$q.Handle;$c=$q.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();@{label=$item.label;pid=$item.pid;expectedCreation=$item.creation;sameIncarnationAlive=(!$q.HasExited -and $c -ceq $item.creation);currentCreation=$c}}catch [ArgumentException]{@{label=$item.label;pid=$item.pid;expectedCreation=$item.creation;sameIncarnationAlive=$false;absent=$true}}finally{if($q){$q.Dispose()}}
})
[pscustomobject]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');processId=$PID;creationFileTime=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString());exactDeaths=$roleDeaths;priorStageDeaths=$priorDeaths;roots=$results;exactDefinitionProcesses=$procs;exactTasks=$tasks;vms=$vms;original8091Alive=$true;readOnly=$true;noRetry=$true;reservationMayRelease=$false}|ConvertTo-Json -Depth 12 -Compress
