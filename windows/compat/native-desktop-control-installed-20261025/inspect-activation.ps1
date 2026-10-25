param([Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference='Stop'
$root='C:\Program Files\Enclave\control'
$data='C:\ProgramData\Enclave'
$m=Get-Content -LiteralPath $ManifestPath -Raw|ConvertFrom-Json
function Hash-File([string]$p) {
  if(-not(Test-Path -LiteralPath $p)){return $null}
  $f=Get-Item -LiteralPath $p
  if($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Non-regular input'}
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
$checks=@()
foreach($f in $m.modified){$h=Hash-File(Join-Path $root $f.path);$checks+=@{path=$f.path;expected=$f.beforeSha256;actual=$h;matches=($h -ceq $f.beforeSha256)}}
foreach($f in $m.requiredUnchanged){$h=Hash-File(Join-Path $root $f.path);$checks+=@{path=$f.path;expected=$f.sha256;actual=$h;matches=($h -ceq $f.sha256)}}
foreach($f in $m.added){$h=Hash-File(Join-Path $root $f.path);$checks+=@{path=$f.path;expected=$null;actual=$h;matches=($null -eq $h)}}
$tasks=@('Node','Shield','Update')|ForEach-Object{
  $name=$_;$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $name
  $want=Join-Path $data ('run-'+$name.ToLowerInvariant()+'.cmd')
  $knownAction=(@($t.Actions).Count -eq 1 -and $t.Actions[0].Execute -eq 'cmd.exe' -and $t.Actions[0].Arguments -ceq ('/c "'+$want+'"'))
  if($name -eq 'Update'){$knownAction=(@($t.Actions).Count -eq 1 -and $t.Actions[0].Execute -eq 'powershell.exe' -and $t.Actions[0].Arguments -like '*C:\Program Files\Enclave\update-host.ps1*')}
  @{name=$name;state=[string]$t.State;enabled=$t.Settings.Enabled;system=($t.Principal.UserId -in @('SYSTEM','S-1-5-18'));actionCount=@($t.Actions).Count;expectedAction=$knownAction}
}
# No configuration contents, process arguments, credentials or environment values are returned.
$configs=@('run-node.cmd','run-shield.cmd','node-config.cmd','node-config.local.cmd','shield-config.cmd')|ForEach-Object{@{path=(Join-Path $data $_);sha256=(Hash-File(Join-Path $data $_))}}
$procs=@(Get-CimInstance Win32_Process)
$roles=@{node='windows\node\agent.mjs';manager='windows\vbslike\manager\main.mjs'}
$processes=@()
foreach($role in $roles.Keys){
  $script=Join-Path $root $roles[$role]
  foreach($p in $procs|Where-Object{$_.Name -eq 'node.exe' -and $_.CommandLine -like ('*"'+$script+'"*')}){
    $parent=$procs|Where-Object{$_.ProcessId -eq $p.ParentProcessId}|Select-Object -First 1
    $processes+=@{role=$role;pid=$p.ProcessId;parentPid=$p.ParentProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;parentIsCmd=($parent.Name -eq 'cmd.exe')}
  }
}
$health=Invoke-RestMethod -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 10
$list=Invoke-RestMethod -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 10
$records=@($list.vms|ForEach-Object{@{id=$_.id;name=$_.name;appId=$_.appId;vmId=$_.launcherVmId;status=$_.status;appReady=$_.appReady;recovered=$_.recovered;imageRole=$_.imageRole;memory=$_.memory;cpu=$_.cpu}})
$managedIds=@($records|ForEach-Object{$_.vmId})
$vms=@(Get-VM|Sort-Object Id|ForEach-Object{@{id=[string]$_.Id;name=$_.Name;state=[string]$_.State;memoryAssigned=[long]$_.MemoryAssigned;memoryStartup=[long]$_.MemoryStartup;dynamicMemory=$_.DynamicMemoryEnabled;managerOwned=([string]$_.Id -in $managedIds)}})
$os=Get-CimInstance Win32_OperatingSystem
@{schema='native-activation-inspection/1';utc=(Get-Date).ToUniversalTime().ToString('o');productionMutations=$false;files=$checks;baselineMatches=(@($checks|Where-Object{-not $_.matches}).Count -eq 0);tasks=$tasks;configurationPins=$configs;processes=$processes;manager=@{epoch=$health.managerEpoch;canStart=$health.canStart;memory=$health.memory;cpu=$health.cpu;inventory=$health.inventory};affectedRecords=$records;vms=$vms;host=@{totalVisibleBytes=[long]$os.TotalVisibleMemorySize*1024;freeBytes=[long]$os.FreePhysicalMemory*1024;lastBoot=$os.LastBootUpTime.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Depth 10 -Compress
