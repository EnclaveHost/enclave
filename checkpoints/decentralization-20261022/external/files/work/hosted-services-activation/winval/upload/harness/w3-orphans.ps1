# W3 KILL_ON_JOB_CLOSE: the runner exits 0 while its 3 children still run (on Linux they survive: harness-local); the
# supervisor closes the job and the job must end them. Nothing is force-killed by this script.
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w3"
$p = Start-Sup $run
Check 'W3 runner exited 0 leaving children' (Wait-Until { (Text "$run\state\fake-runner.log") -match 'WITHOUT stopping the children' } 60) $null
$r = Read-Json "$run\state\runner.json"
$exited = Wait-Until { $p.HasExited } 30
Check 'W3 supervisor treated the clean exit as final (exit 0)' ($exited -and $p.ExitCode -eq 0 -and (Text "$run\state\supervisor.log") -match 'runner exited cleanly') ([ordered]@{ exitCode = $(if ($exited) { $p.ExitCode } else { $null }) })
$gone = Wait-Until { @(@($r.children) | Where-Object { Alive $_ }).Count -eq 0 } 10
Check 'W3 the job reaped all 3 orphaned children on close' $gone ([ordered]@{ children = @($r.children); stillAlive = @(@($r.children) | Where-Object { Alive $_ }) })
Done
