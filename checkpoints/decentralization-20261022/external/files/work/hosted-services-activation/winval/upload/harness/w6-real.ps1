# W6/W7/W5b with the REAL runner and REAL role packages on a FIXTURE chain (loopback JSON-RPC, throwaway admin key): health
# (gate current, four roles, the captured static labels over real DNS), a role killed inside the job is restarted by the
# runner, fixture ban -> every role stops while the runner stays up, fixture unban -> roles back, graceful stop.
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w6"; $work = "$run\work"
$world = Start-Process -FilePath $Node -ArgumentList @("$V\fixtures\fixture-world.mjs", $work, "$V\packages", "$V\fixtures\app-static.json") -PassThru -WindowStyle Hidden
$null = $world.Handle
Check 'W6 fixture chain up' (Wait-Until { Test-Path "$work\world.json" } 60) $null
$w = Read-Json "$work\world.json"
$p = Start-Sup $run
$health = { & $Node "$V\bin\stage-tool.mjs" health --config "$work\host-services.json" 2>&1 | Out-String }
$h = ''
$okH = Wait-Until { $script:h = & $health; $LASTEXITCODE -eq 0 } 150
Check 'W6/W7 stage-1 health PASS with the real roles (gate current, 4 roles, static labels)' ($okH -and $h -match '"status":"current"' -and $h -match 'static platform label') ($h -split "`n" | Where-Object { $_ -match 'PASS|FAIL' })
$runnerPid = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)")[0].ProcessId
$dns = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$runnerPid" | Where-Object { $_.CommandLine -like '*route-dns.mjs*' })
$jobsR = [ordered]@{ runner = [WinvalJob]::InJob([int]$runnerPid); roles = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$runnerPid" | ForEach-Object { [WinvalJob]::InJob([int]$_.ProcessId) }) }
Check 'W1 real runner and its 4 roles are in a job' (($jobsR.runner -eq 'in-a-job') -and @($jobsR.roles).Count -eq 4 -and (@($jobsR.roles | Where-Object { $_ -ne 'in-a-job' }).Count -eq 0)) $jobsR
if ($dns.Count -eq 1) {
  $old = [int]$dns[0].ProcessId
  Stop-Process -Id $old    # a role INSIDE our own job
  $back = Wait-Until { @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$runnerPid" | Where-Object { $_.CommandLine -like '*route-dns.mjs*' -and $_.ProcessId -ne $old }).Count -eq 1 } 30
  $okH2 = Wait-Until { $script:h = & $health; $LASTEXITCODE -eq 0 } 60
  Check 'W5 a killed role is restarted by the runner and serves again' ($back -and $okH2) $old
} else { Check 'W5 a killed role is restarted by the runner and serves again' $false 'route-dns process not found' }
Invoke-RestMethod -Method Post -Uri "$($w.control)/ban" | Out-Null
$stopped = Wait-Until { -not (PortOpen ([int]$w.ports.dir)) } 60
$h = & $health
Check 'W6 fixture ban: every role stops, health fails on the gate, the runner stays up' ($stopped -and $LASTEXITCODE -eq 2 -and $h -match 'banned by platform policy' -and (Alive $runnerPid) -and -not $p.HasExited) ($h -split "`n" | Where-Object { $_ -match 'FAIL' } | Select-Object -First 2)
Invoke-RestMethod -Method Post -Uri "$($w.control)/unban" | Out-Null
$okH3 = Wait-Until { $script:h = & $health; $LASTEXITCODE -eq 0 } 150
Check 'W6 fixture unban: the same runner restarts every role, health PASS' ($okH3 -and (Alive $runnerPid)) $null
$rc = Stop-Sup $run
$exited = Wait-Until { $p.HasExited } 45
$log = Text "$run\state\supervisor.log"
Check 'W4 real runner: graceful stop (SIGBREAK), exit 0, job not terminated' ($rc -eq 0 -and $exited -and $p.ExitCode -eq 0 -and $log -match 'runner stopped \(0\)' -and $log -notmatch 'terminating the job') ([ordered]@{ exitCode = $(if ($exited) { $p.ExitCode } else { $null }) })
Check 'W4 no role process remains' (Wait-Until { @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$runnerPid").Count -eq 0 -and -not (Alive $runnerPid) } 15) $null
try { Invoke-RestMethod -Method Post -Uri "$($w.control)/shutdown" | Out-Null } catch { }
Check 'W6 fixture chain stopped' (Wait-Until { $world.HasExited } 20) $null
Done
