# W2 mechanism: the REAL hostsvc-supervisor starts jobprobe.exe (TEST-ONLY) as its runner, with jobMemoryMiB 300. The probe
# reads its own job's documented counters while concurrent children commit (winval/jobprobe/main.go). This script only
# starts our supervisor, waits for it to exit by itself (bounded), and prints the raw results.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$V = 'C:\ProgramData\Enclave\host-services-install-validation-20261021'
$run = "$V\w2"
$plog = "$run\harness-progress.log"
function Mark([string]$m) { Add-Content -LiteralPath $plog -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $m) }
# a fresh state directory for this run (only our own files: the previous run's evidence was downloaded first)
Get-ChildItem -LiteralPath "$run\state" -Force | Remove-Item -Force
Mark 'start'
$p = Start-Process -FilePath "$V\bin\hostsvc-supervisor.exe" -ArgumentList @('run', "$run\supervisor.json") -PassThru -WindowStyle Hidden
$null = $p.Handle
Mark "supervisor started pid $($p.Id)"
$end = (Get-Date).AddSeconds(180)
while (-not $p.HasExited -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 500 }
$exited = $p.HasExited
Mark "wait loop done: exited=$exited"
if (-not $exited) {
  # bounded: our own supervisor only; its job (KILL_ON_JOB_CLOSE) ends the probe tree with it
  & "$V\bin\hostsvc-supervisor.exe" stop "$run\supervisor.json" | Out-Null
  $null = $p.WaitForExit(45000)
}
$res = if (Test-Path -LiteralPath "$run\state\results.json") { Get-Content -Raw -LiteralPath "$run\state\results.json" | ConvertFrom-Json } else { $null }
Mark 'reading results'
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($V, 'OrdinalIgnoreCase') }).Count
[ordered]@{ supervisorExited = $exited; supervisorExitCode = $(if ($p.HasExited) { $p.ExitCode } else { $null }); processesOfOursLeft = $left
  supervisorExitTime = $(if ($p.HasExited) { $p.ExitTime.ToUniversalTime().ToString('o') } else { $null })
  supervisorLog = [IO.File]::ReadAllText("$run\state\supervisor.log")   # a plain string: Get-Content's PSProvider notes make ConvertTo-Json explode; results = $res } | ConvertTo-Json -Depth 12
Mark 'printed'
