# Lifecycle requests have uncertain outcomes after a timeout or failed response. This is deliberately separate from
# read-only queries: killing the request process does NOT cancel a request already received by Task Scheduler.
function Invoke-TaskCommand([ValidateSet('Start','Stop')][string]$Action, [string]$TaskPath, [string]$TaskName, [int]$BudgetMs = 20000) {
  if ($BudgetMs -lt 2500 -or $BudgetMs -gt 30000) { throw 'task request budget must include cleanup time' }
  $quote = { param($s) "'" + $s.Replace("'", "''") + "'" }
  $body = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";try{' + $Action + '-ScheduledTask -TaskPath ' + (& $quote $TaskPath) + ' -TaskName ' + (& $quote $TaskName) + ';exit 0}catch{exit 2}'
  $sw=[Diagnostics.Stopwatch]::StartNew();$si=New-Object Diagnostics.ProcessStartInfo
  $si.FileName=Join-Path $PSHOME $(if($env:OS -eq 'Windows_NT'){'powershell.exe'}else{'pwsh'})
  $si.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
  $p=New-Object Diagnostics.Process;$p.StartInfo=$si;$started=$false;$exited=$false;$confirmed=$false;$timedOut=$false
  try {
    $started=$p.Start()
    if($started){
      $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
      $left=[math]::Max(0,$BudgetMs-2000-$sw.ElapsedMilliseconds);$exited=$p.WaitForExit([int]$left)
      if($exited){$confirmed=$p.ExitCode -eq 0}else{$timedOut=$true}
    }
  } catch { $confirmed=$false }
  finally {
    if($started -and -not $p.HasExited){try{$p.Kill()}catch{};$left=[math]::Max(0,$BudgetMs-$sw.ElapsedMilliseconds);$exited=$p.WaitForExit([int]$left)}
    elseif($started){$exited=$true}
    $childId=$(if($started){$p.Id}else{$null});$p.Dispose()
  }
  if($sw.ElapsedMilliseconds -gt $BudgetMs){$confirmed=$false;$timedOut=$true}
  [pscustomobject]@{action=$Action;responseConfirmed=($confirmed -and $exited);outcome=$(if($confirmed -and $exited){'response-confirmed'}elseif($started){'unknown'}else{'not-started'});childId=$childId;childExited=$exited;timedOut=$timedOut;elapsedMs=$sw.ElapsedMilliseconds}
}
function NodeTask([ValidateSet('Start','Stop')][string]$Action, [double]$limitSec = 20) {
  if($script:TaskMutationUnknown){throw 'previous task outcome unknown; no automatic retry'}
  if($TR){
    if($Action -eq 'Start'){Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'}
    else{Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'}
    return
  }
  $ms=[int][math]::Floor(1000*(Lim ([math]::Min(20,$limitSec))))
  if($ms -lt 2500){throw 'not enough time to send a task request and confirm child cleanup'}
  $script:LastTaskCommand=Invoke-TaskCommand $Action '\Enclave\' 'Node' $ms
  if(-not $script:LastTaskCommand.responseConfirmed){$script:TaskMutationUnknown=$true;throw 'task request outcome unconfirmed; no automatic retry or rollback'}
}
