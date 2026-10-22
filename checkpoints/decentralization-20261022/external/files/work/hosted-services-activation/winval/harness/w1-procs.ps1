# W1 job membership, by effect: IsProcessInJob(NULL) is NOT proof here (this PowerShell, and so the supervisor, already
# runs inside the SSH session's job). The w1-procs job allows 3 active processes: the runner + 2 children. The runner
# starts 4 children one by one; if they are in THIS job, exactly the last 2 are refused by the job, not by anything else.
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w1-procs"
$p = Start-Sup $run
$exited = Wait-Until { $p.HasExited } 60
$r = Read-Json "$run\state\runner.json"
Check 'W1 the job admits the runner + 2 children and refuses children 3 and 4 (ActiveProcessLimit 3)' ((@($r.children).Count -eq 2) -and (@($r.refused).Count -eq 2) -and (@($r.refused | ForEach-Object { $_.i }) -join ',') -eq '2,3') ([ordered]@{ spawned = @($r.children); refused = @($r.refused) })
Check 'W1 the supervisor treated the runner''s clean exit as final' ($exited -and $p.ExitCode -eq 0) ([ordered]@{ exitCode = $(if ($exited) { $p.ExitCode } else { $null }) })
Check 'W1 nothing of the tree remains' (Wait-Until { @(@($r.children) + @([int]$r.pid) | Where-Object { Alive $_ }).Count -eq 0 } 10) $null
Done
