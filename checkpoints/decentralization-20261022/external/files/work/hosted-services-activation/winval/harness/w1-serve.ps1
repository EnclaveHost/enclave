# W1 (the job holds the tree), W7 (minimal env: sockets + crypto), W4 (graceful stop: CTRL_BREAK -> SIGBREAK, exit 0)
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w1"
$p = Start-Sup $run
Check 'W1 runner + 3 children started' (Wait-Until { (Test-Path "$run\state\runner.json") -and @((Read-Json "$run\state\runner.json").children).Count -eq 3 } 60) $null
$r = Read-Json "$run\state\runner.json"
$tree = [ordered]@{ supervisor = $p.Id; runner = [int]$r.pid; runnerParent = (ParentOf $r.pid); children = @($r.children); childParents = @($r.children | ForEach-Object { ParentOf $_ }) }
Check 'W1 tree: supervisor -> runner -> 3 children' (($tree.runnerParent -eq $p.Id) -and (@($tree.childParents | Where-Object { $_ -ne [int]$r.pid }).Count -eq 0)) $tree
$jobs = [ordered]@{ supervisor = [WinvalJob]::InJob($p.Id); runner = [WinvalJob]::InJob([int]$r.pid); children = @($r.children | ForEach-Object { [WinvalJob]::InJob([int]$_) }) }
Check 'W1 runner and children are in a job' (($jobs.runner -eq 'in-a-job') -and (@($jobs.children | Where-Object { $_ -ne 'in-a-job' }).Count -eq 0)) $jobs
Check 'W7 the runner sees only PATH, SystemRoot, WINDIR' ((@($r.envKeys) -join ',') -eq 'PATH,SystemRoot,WINDIR') @($r.envKeys)
$sock = @(foreach ($i in 0..2) {
  $c = Read-Json "$run\state\child-$i.json"
  try { $t = New-Object Net.Sockets.TcpClient; $t.Connect('127.0.0.1', [int]$c.port); $line = (New-Object IO.StreamReader($t.GetStream())).ReadLine(); $t.Close(); "$($c.port):$line" } catch { "$($c.port):error" }
})
$c0 = Read-Json "$run\state\child-0.json"
Check 'W7 children serve loopback sockets and get crypto randomness under the minimal env' ((@($sock | Where-Object { $_ -notlike '*:ok' }).Count -eq 0) -and $c0.randomOk) ([ordered]@{ sockets = $sock; childEnv = @($c0.envKeys) })
$rc = Stop-Sup $run
Check 'W4 stop event set by an Administrator' ($rc -eq 0) $rc
$exited = Wait-Until { $p.HasExited } 45
$log = Text "$run\state\supervisor.log"; $fake = Text "$run\state\fake-runner.log"
Check 'W4 graceful: runner got SIGBREAK, stopped its children, exit 0; the job was NOT terminated' ($exited -and $p.ExitCode -eq 0 -and $log -match 'runner stopped \(0\)' -and $log -notmatch 'terminating the job' -and $fake -match 'SIGBREAK received') ([ordered]@{ exited = $exited; exitCode = $(if ($exited) { $p.ExitCode } else { $null }) })
Check 'W4 nothing of the tree remains' (Wait-Until { @(@($r.children) + @([int]$r.pid) | Where-Object { Alive $_ }).Count -eq 0 } 10) $null
Done
