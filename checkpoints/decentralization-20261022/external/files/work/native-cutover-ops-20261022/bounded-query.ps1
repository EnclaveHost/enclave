# Trusted, read-only child queries only. This function does not cancel work in Windows services:
# never use it to wrap mutations. A timed-out reader is killed and its exit verified before returning.
# PowerShell 5.1/.NET Framework compatible; no process-name scans or process-tree kills.
function Invoke-BoundedQuery([scriptblock]$Query, [int]$BudgetMs = 15000) {
  if ($BudgetMs -lt 2500 -or $BudgetMs -gt 30000) { throw 'query budget must include 2000 ms for cleanup' }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $body = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";try{$v=& {' + $Query.ToString() + '};[Console]::Out.Write((ConvertTo-Json -InputObject @($v) -Depth 8 -Compress))}catch{exit 2}'
  $si = New-Object Diagnostics.ProcessStartInfo
  $si.FileName = Join-Path $PSHOME $(if ($env:OS -eq 'Windows_NT') { 'powershell.exe' } else { 'pwsh' })
  $si.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $si.UseShellExecute = $false; $si.CreateNoWindow = $true
  $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true
  $p = New-Object Diagnostics.Process; $p.StartInfo = $si
  $started = $false; $timedOut = $false; $reason = $null; $value = $null; $exited = $false
  try {
    $started = $p.Start()
    if (-not $started) { throw 'query process failed to start' }
    $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync()
    $left = [math]::Max(0, $BudgetMs - 2000 - $sw.ElapsedMilliseconds)
    $exited = $p.WaitForExit([int]$left)
    if (-not $exited) { $timedOut = $true; $reason = 'query deadline reached' }
    elseif ($p.ExitCode -ne 0) { $reason = 'query process failed' }
    else {
      $left = [math]::Max(0, $BudgetMs - 2000 - $sw.ElapsedMilliseconds)
      if (-not $stdout.Wait([int]$left)) { $timedOut = $true; $reason = 'query output deadline reached' }
      else { $value = ConvertFrom-Json -InputObject $stdout.Result }
    }
  } catch { $reason = 'query invocation failed' }
  finally {
    if ($started -and -not $p.HasExited) {
      try { $p.Kill() } catch {}
      $left = [math]::Max(0, $BudgetMs - $sw.ElapsedMilliseconds)
      $exited = $p.WaitForExit([int]$left)
    } elseif ($started) { $exited = $true }
    if ($started -and -not $exited) { $reason = 'query child exit unconfirmed' }
    $childId = $(if ($started) { $p.Id } else { $null }); $p.Dispose()
  }
  if ($sw.ElapsedMilliseconds -gt $BudgetMs) { $timedOut = $true; $reason = 'query exceeded total budget' }
  [pscustomobject]@{ ok = ($null -eq $reason -and $exited); value = $(if ($null -eq $reason) { $value } else { $null })
    reason = $reason; timedOut = $timedOut; childExited = $exited; childId = $childId; elapsedMs = $sw.ElapsedMilliseconds }
}
