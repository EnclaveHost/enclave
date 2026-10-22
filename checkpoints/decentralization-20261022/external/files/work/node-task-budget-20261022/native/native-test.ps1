param([string]$Stage)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$task='cutover-api-canary-'+(Split-Path -Leaf $Stage);$taskPath='\Enclave\'
if(Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue){throw 'task collision'}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Stage 'cutover.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'cutover parse errors'}
$f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-TaskCommand'},$true))
if($f.Count -ne 1){throw 'task command function missing'}
. ([scriptblock]::Create($f[0].Extent.Text))
# Test-only copy delays its reply AFTER the real Scheduler has accepted the request. Never used for production Node.
$delayed=$f[0].Extent.Text.Replace('function Invoke-TaskCommand(', 'function Invoke-DelayedTaskCommand(').Replace(';exit 0}catch{exit 2}', ';Start-Sleep -Seconds 30;exit 0}catch{exit 2}')
if($delayed -eq $f[0].Extent.Text -or $delayed -notmatch 'Start-Sleep -Seconds 30'){throw 'fault injection not applied'}
. ([scriptblock]::Create($delayed))
$registered=$false;$samples=@();$result=[ordered]@{task=$task;productionTaskTouched=$false}
try {
 $payload=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Seconds 45'))
 $a=New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument ('-NoProfile -NonInteractive -EncodedCommand '+$payload)
 $p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
 $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
 $null=Register-ScheduledTask -TaskPath $taskPath -TaskName $task -Action $a -Principal $p -Settings $settings;$registered=$true
 foreach($i in 1,2) {
  $sw=[Diagnostics.Stopwatch]::StartNew();$reply=Invoke-TaskCommand 'Start' $taskPath $task 20000;if(-not $reply.responseConfirmed -or -not $reply.childExited){throw 'start response unconfirmed'};$startMs=$sw.ElapsedMilliseconds
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do{$state=[string](Get-ScheduledTask -TaskPath $taskPath -TaskName $task).State;if($state -ne 'Running'){Start-Sleep -Milliseconds 100}}while($state -ne 'Running' -and [DateTime]::UtcNow -lt $deadline)
  if($state -ne 'Running'){throw 'own test task did not run'}
  $sw.Restart();$reply=Invoke-TaskCommand 'Stop' $taskPath $task 20000;if(-not $reply.responseConfirmed -or -not $reply.childExited){throw 'stop response unconfirmed'};$stopMs=$sw.ElapsedMilliseconds
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do{$state=[string](Get-ScheduledTask -TaskPath $taskPath -TaskName $task).State;if($state -eq 'Running'){Start-Sleep -Milliseconds 100}}while($state -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
  if($state -ne 'Ready'){throw 'own test task did not stop'}
  $samples += [ordered]@{round=$i;startMs=$startMs;stopMs=$stopMs;stateAfterStop=$state}
 }
 $lost=Invoke-DelayedTaskCommand 'Start' $taskPath $task 3000
 $state=[string](Get-ScheduledTask -TaskPath $taskPath -TaskName $task).State
 if($lost.responseConfirmed -or $lost.outcome -ne 'unknown' -or -not $lost.timedOut -or -not $lost.childExited -or $state -ne 'Running'){throw 'lost reply was not treated as unknown despite accepted start'}
 $reply=Invoke-TaskCommand 'Stop' $taskPath $task 20000
 if(-not $reply.responseConfirmed){throw 'test task cleanup response missing'}
 $result.pass=$true;$result.samples=$samples;$result.lostReply=[ordered]@{outcome=$lost.outcome;childExited=$lost.childExited;elapsedMs=$lost.elapsedMs;taskActuallyRunning=$true};$result.parseErrors=$errors.Count
} finally {
 if($registered){Stop-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskPath $taskPath -TaskName $task -Confirm:$false}
 $result.taskGone=-not [bool](Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue)
}
$result|ConvertTo-Json -Depth 6 -Compress
