# W2 job-wide committed-memory cap: jobMemoryMiB=300; three children each try to commit 120 MiB, holding it. Each alone is
# far below 300 MiB, so a refusal proves the cap is JOB-wide (runner + all children), not per process.
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w2"
$p = Start-Sup $run
$exited = Wait-Until { $p.HasExited } 90
$allocs = @(foreach ($i in 0..2) { $f = "$run\state\child-$i.json"; if (Test-Path $f) { (Read-Json $f).alloc } else { [ordered]@{ ok = $false; error = 'no report (the child could not start or was ended)' } } })
$log = Text "$run\state\supervisor.log"
$peak = if ($log -match 'job peak committed memory (\d+) MiB') { [int]$Matches[1] } else { -1 }
Check 'W2 the first 120 MiB commit succeeds' ($allocs[0].ok -eq $true) $allocs[0]
Check 'W2 a later commit is refused by the 300 MiB job limit' (@($allocs[1..2] | Where-Object { $_.ok -eq $false }).Count -ge 1) @($allocs)
Check 'W2 the job peak stayed within the 300 MiB limit' ($peak -gt 0 -and $peak -le 300) ([ordered]@{ peakMiB = $peak; exited = $exited })
Done
