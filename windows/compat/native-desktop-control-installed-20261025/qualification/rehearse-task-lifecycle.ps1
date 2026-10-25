$ErrorActionPreference='Stop'
$root='C:\Users\claude\kvm-box-handoff-v9-1025'
$taskPath='\Enclave-Native-Handoff-V9-1025\'
$roles=@('Node','Shield','Update')
$node='C:\Program Files\Enclave\runtime\node\node.exe'
if(Test-Path -LiteralPath $root){throw 'Fixture directory already exists'}
if(Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue){throw 'Fixture task path already exists'}
New-Item -ItemType Directory -Path $root|Out-Null
$worker=Join-Path $root 'worker.mjs'
@'
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const role=process.argv[2];
if(!['Node','Shield','Update'].includes(role))throw Error('unexpected fixture role');
fs.writeFileSync(path.join(root,role+'.ready.json'),JSON.stringify({pid:process.pid,role,started:new Date().toISOString(),native:process.env.FIXTURE_NATIVE||null}));
setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath $worker -Encoding ASCII
function Production-State {
  $p=@(Get-CimInstance Win32_Process | Where-Object{$_.Name -eq 'node.exe' -and $_.CommandLine -like '*C:\Program Files\Enclave\control\*'} | Sort-Object ProcessId | ForEach-Object{@{pid=[int]$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o')}})
  $tasks=@($roles | ForEach-Object{$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $_;@{name=$_;enabled=[bool]$t.Settings.Enabled;state=[string]$t.State}})
  $vms=@(Get-VM | Sort-Object Id | ForEach-Object{@{id=[string]$_.Id;state=[string]$_.State;memory=[long]$_.MemoryAssigned}})
  return @{processes=$p;tasks=$tasks;vms=$vms}
}
function Fixture-Processes {
  return @(Get-CimInstance Win32_Process | Where-Object{ $_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0 -and $_.Name -in @('node.exe','cmd.exe') })
}
function Wait-Ready([string]$role) {
  $until=(Get-Date).AddSeconds(20)
  do {
    $p=Join-Path $root ($role+'.ready.json')
    if(Test-Path -LiteralPath $p){$r=Get-Content -LiteralPath $p -Raw|ConvertFrom-Json;if(Get-Process -Id $r.pid -ErrorAction SilentlyContinue){return $r}}
    Start-Sleep -Milliseconds 200
  } while((Get-Date)-lt $until)
  throw ('Fixture did not start: '+$role)
}
function Wait-Stopped([string]$role) {
  $until=(Get-Date).AddSeconds(20)
  do {
    $t=Get-ScheduledTask -TaskPath $taskPath -TaskName $role
    $children=@(Fixture-Processes | Where-Object{$_.CommandLine -like ('*worker.mjs" '+$role+'*') -or $_.CommandLine -like ('*run-'+$role+'.cmd*')})
    if($t.State -ne 'Running' -and -not $t.Settings.Enabled -and $children.Count -eq 0){return @{name=$role;enabled=$false;state=[string]$t.State;remainingProcesses=0}}
    Start-Sleep -Milliseconds 200
  } while((Get-Date)-lt $until)
  throw ('Fixture stop left a process or enabled task: '+$role)
}
$before=Production-State
$result=[ordered]@{schema='native-task-lifecycle-rehearsal/1';startedUtc=(Get-Date).ToUniversalTime().ToString('o');root=$root;taskPath=$taskPath;productionBefore=$before;steps=@();success=$false}
try {
  foreach($role in $roles){
    $cmd=Join-Path $root ('run-'+$role+'.cmd')
    $lines=@('@echo off',('echo entered>"'+$root+'\'+$role+'.entered"'),('if exist "'+$root+'\native-env.cmd" call "'+$root+'\native-env.cmd"'),'if errorlevel 1 exit /b 1',':loop',('"'+$node+'" "'+$worker+'" '+$role),'ping -n 3 127.0.0.1 >nul','goto loop')
    [IO.File]::WriteAllText($cmd,($lines -join "`r`n")+"`r`n",[Text.Encoding]::ASCII)
    $action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "'+$cmd+'"')
    $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskPath $taskPath -TaskName $role -Action $action -Settings $settings -Principal $principal|Out-Null
  }
  Start-ScheduledTask -TaskPath $taskPath -TaskName 'Shield';$manager=Wait-Ready 'Shield'
  Start-ScheduledTask -TaskPath $taskPath -TaskName 'Node';$admitter=Wait-Ready 'Node'
  $result.steps+=@{name='original-start';manager=$manager;node=$admitter}
  # Real maintenance order: updater disabled, then node stopped while manager lives.
  Disable-ScheduledTask -TaskPath $taskPath -TaskName 'Update'|Out-Null
  Disable-ScheduledTask -TaskPath $taskPath -TaskName 'Node'|Out-Null
  Stop-ScheduledTask -TaskPath $taskPath -TaskName 'Node'
  $stopped=Wait-Stopped 'Node'
  if(-not(Get-Process -Id $manager.pid -ErrorAction SilentlyContinue)){throw 'Stopping node also lost manager'}
  $result.steps+=@{name='node-stopped-manager-still-running';node=$stopped;managerPid=$manager.pid}
  Disable-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'|Out-Null
  Stop-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'
  $result.steps+=@{name='manager-stopped';manager=(Wait-Stopped 'Shield')}
  if(@(Fixture-Processes).Count){throw 'Fixture descendants remain'}
  # Simulate a bad native config: runner must exit before executing its worker.
  'exit /b 1'|Set-Content -LiteralPath (Join-Path $root 'native-env.cmd') -Encoding ASCII
  Remove-Item -LiteralPath (Join-Path $root 'Shield.ready.json'),(Join-Path $root 'Shield.entered')
  Enable-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'|Out-Null
  Start-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'
  $until=(Get-Date).AddSeconds(20)
  do {
    $t=Get-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'
    $info=Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName 'Shield'
    if((Test-Path (Join-Path $root 'Shield.entered')) -and $t.State -ne 'Running' -and $info.LastTaskResult -eq 1){break}
    Start-Sleep -Milliseconds 200
  } while((Get-Date)-lt $until)
  if(-not(Test-Path (Join-Path $root 'Shield.entered')) -or $t.State -eq 'Running' -or $info.LastTaskResult -ne 1 -or (Test-Path (Join-Path $root 'Shield.ready.json'))){throw 'Failed environment did not prevent worker launch'}
  if((Get-ScheduledTask -TaskPath $taskPath -TaskName 'Node').Settings.Enabled){throw 'Node admitted after manager failure'}
  Disable-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'|Out-Null
  $result.steps+=@{name='failed-config-keeps-node-stopped';lastTaskResult=$info.LastTaskResult;manager=(Wait-Stopped 'Shield')}
  # Recovery removes only this fixture environment and starts manager before node.
  Remove-Item -LiteralPath (Join-Path $root 'native-env.cmd')
  Enable-ScheduledTask -TaskPath $taskPath -TaskName 'Shield'|Out-Null
  Start-ScheduledTask -TaskPath $taskPath -TaskName 'Shield';$recovered=Wait-Ready 'Shield'
  Remove-Item -LiteralPath (Join-Path $root 'Node.ready.json')
  Enable-ScheduledTask -TaskPath $taskPath -TaskName 'Node'|Out-Null
  Start-ScheduledTask -TaskPath $taskPath -TaskName 'Node';$newNode=Wait-Ready 'Node'
  if([DateTime]$recovered.started -gt [DateTime]$newNode.started){throw 'Node started before manager'}
  Enable-ScheduledTask -TaskPath $taskPath -TaskName 'Update'|Out-Null
  $result.steps+=@{name='original-runners-recovered-manager-first';manager=$recovered;node=$newNode;updaterEnabled=(Get-ScheduledTask -TaskPath $taskPath -TaskName 'Update').Settings.Enabled}
  $result.success=$true
} catch {
  $result.error=$_.Exception.Message
} finally {
  foreach($role in $roles){
    $t=Get-ScheduledTask -TaskPath $taskPath -TaskName $role -ErrorAction SilentlyContinue
    if($t){Disable-ScheduledTask -TaskPath $taskPath -TaskName $role|Out-Null;Stop-ScheduledTask -TaskPath $taskPath -TaskName $role;Unregister-ScheduledTask -TaskPath $taskPath -TaskName $role -Confirm:$false}
  }
  # Cleanup only processes whose executable role and full fixture path both match.
  $left=@(Fixture-Processes)
  $result.cleanupNeededExplicitProcessStop=($left.Count -gt 0)
  foreach($p in $left){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}
  $result.remainingFixtureProcesses=@(Fixture-Processes).Count
  $result.remainingFixtureTasks=@(Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue).Count
  $result.productionAfter=Production-State
  $result.productionUnchanged=(($before|ConvertTo-Json -Depth 8 -Compress) -ceq ($result.productionAfter|ConvertTo-Json -Depth 8 -Compress))
  $result.finishedUtc=(Get-Date).ToUniversalTime().ToString('o')
  $result|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding UTF8
}
$result|ConvertTo-Json -Depth 10 -Compress
if(-not $result.success -or $result.remainingFixtureProcesses -or $result.remainingFixtureTasks){exit 1}
