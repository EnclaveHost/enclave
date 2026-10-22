# W5 Restart=on-failure + start limit: the runner exits 1 every time; restartSec=1, 5 starts per 600 s -> exit 3.
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w5"
$p = Start-Sup $run
$exited = Wait-Until { $p.HasExited } 60
$log = Text "$run\state\supervisor.log"
$starts = ([regex]::Matches($log, 'runner started \(pid')).Count
Check 'W5 five starts, then start-limit exit 3' ($exited -and $p.ExitCode -eq 3 -and $starts -eq 5 -and $log -match 'start limit hit') ([ordered]@{ exitCode = $(if ($exited) { $p.ExitCode } else { $null }); starts = $starts })
Check 'W5 restarts waited restartSec between starts' (([regex]::Matches($log, 'restarting in 1s')).Count -eq 5) ([regex]::Matches($log, 'restarting in 1s')).Count
Done
