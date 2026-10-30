param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
# Deliberately fixed qualification namespace. This helper cannot control production tasks.
if($Root -cne 'C:\Users\claude\kvm-box-combined-v9-1025'){throw 'Unexpected fixture root'}
$taskPath='\Enclave-Native-Combined-V9-1025\'
$roles=@('Node','Shield','Update')
function Fixture-Probe {
  $tasks=@($roles|ForEach-Object{
    $role=$_;$t=Get-ScheduledTask -TaskPath $taskPath -TaskName $role -ErrorAction SilentlyContinue
    if($t){@{name=$role;enabled=[bool]$t.Settings.Enabled;state=[string]$t.State;system=($t.Principal.UserId -in @('SYSTEM','S-1-5-18'));actionCount=@($t.Actions).Count;expectedAction=(@($t.Actions).Count -eq 1 -and $t.Actions[0].Execute -eq 'cmd.exe' -and $t.Actions[0].Arguments -ceq ('/c "'+$Root+'\data\run-'+$role.ToLowerInvariant()+'.cmd"'))}}
  })
  $procs=@(Get-CimInstance Win32_Process)
  $found=@($procs|Where-Object{$_.Name -in @('node.exe','cmd.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($Root,[StringComparison]::OrdinalIgnoreCase)-ge 0}|ForEach-Object{
    $p=$_;$role='unknown'
    if($p.CommandLine.Contains('manager-worker.mjs') -or $p.CommandLine.Contains('run-shield.cmd')){$role='manager'}
    if($p.CommandLine.Contains('admission-worker.mjs') -or $p.CommandLine.Contains('run-node.cmd')){$role='node'}
    $parent=$procs|Where-Object{$_.ProcessId -eq $p.ParentProcessId}|Select-Object -First 1
    @{role=$role;pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');kind=$p.Name;parentIsCmd=($parent.Name -eq 'cmd.exe')}
  })
  @{tasks=$tasks;processes=$found}
}
function Production-Probe {
  $procs=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'node.exe' -and $_.CommandLine -like '*C:\Program Files\Enclave\control\*'}|Sort-Object ProcessId|ForEach-Object{@{pid=[int]$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o')}})
  $tasks=@($roles|ForEach-Object{$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $_;@{name=$_;enabled=[bool]$t.Settings.Enabled;state=[string]$t.State}})
  $vms=@(Get-VM|Sort-Object Id|ForEach-Object{@{id=[string]$_.Id;state=[string]$_.State}})
  @{processes=$procs;tasks=$tasks;vms=$vms;utc=[DateTime]::UtcNow.ToString('o')}
}
while($null -ne ($line=[Console]::ReadLine())){
  try {
    $q=$line|ConvertFrom-Json;$value=$null
    switch($q.action){
      'register' {
        if(Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue){throw 'Fixture tasks already exist'}
        foreach($role in $roles){
          $runner=Join-Path $Root ('data\run-'+$role.ToLowerInvariant()+'.cmd')
          if(-not(Test-Path -LiteralPath $runner)){throw 'Fixture runner missing'}
          $action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "'+$runner+'"')
          $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
          $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
          Register-ScheduledTask -TaskPath $taskPath -TaskName $role -Action $action -Settings $settings -Principal $principal|Out-Null
        }
        $value=Fixture-Probe
      }
      'probe' {$value=Fixture-Probe}
      'production' {$value=Production-Probe}
      'start' {
        if($q.role -notin $roles){throw 'Unknown fixture role'}
        Enable-ScheduledTask -TaskPath $taskPath -TaskName $q.role|Out-Null
        Start-ScheduledTask -TaskPath $taskPath -TaskName $q.role
        $value=@{requested=$q.role}
      }
      'stop' {
        if($q.role -notin $roles){throw 'Unknown fixture role'}
        Disable-ScheduledTask -TaskPath $taskPath -TaskName $q.role|Out-Null
        Stop-ScheduledTask -TaskPath $taskPath -TaskName $q.role
        $value=@{requested=$q.role}
      }
      'enable-update' {Enable-ScheduledTask -TaskPath $taskPath -TaskName Update|Out-Null;$value=@{enabled=$true}}
      'cleanup' {
        foreach($role in $roles){
          if(Get-ScheduledTask -TaskPath $taskPath -TaskName $role -ErrorAction SilentlyContinue){
            Disable-ScheduledTask -TaskPath $taskPath -TaskName $role|Out-Null
            Stop-ScheduledTask -TaskPath $taskPath -TaskName $role
            Unregister-ScheduledTask -TaskPath $taskPath -TaskName $role -Confirm:$false
          }
        }
        $until=(Get-Date).AddSeconds(10)
        do {$state=Fixture-Probe;if(-not $state.processes.Count){break};Start-Sleep -Milliseconds 100}while((Get-Date)-lt $until)
        $forced=@($state.processes|ForEach-Object{$_.pid})
        foreach($pidToStop in $forced){Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue}
        $value=@{remaining=(Fixture-Probe);forcedFixtureProcessIds=$forced}
      }
      default {throw 'Unknown fixture action'}
    }
    [Console]::WriteLine((@{ok=$true;result=$value}|ConvertTo-Json -Depth 10 -Compress))
  } catch {[Console]::WriteLine((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress))}
}
