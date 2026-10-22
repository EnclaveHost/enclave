# W2 DIAGNOSTIC (run 2 saw no refusal): the same as w2-alloc, but each child commits its 120 MiB as ONE Buffer.
# W2 job-wide committed-memory cap: jobMemoryMiB=300; three children each commit 120 MiB in 10 MiB steps and hold it for
# 8 s. Each alone is far below 300 MiB, so a refusal proves the cap is JOB-wide (runner + all children), not per process.
# While they hold, the harness samples every process of the tree (private bytes = commit charge) to cross-check the job.
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w2-single"
$p = Start-Sup $run
$maxSum = 0; $maxAt = $null
$end = (Get-Date).AddSeconds(90)
while (-not $p.HasExited -and (Get-Date) -lt $end) {
  $tree = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq $Node })
  $mib = @(foreach ($x in $tree) { $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; if ($g) { [ordered]@{ pid = [int]$x.ProcessId; privateMiB = [math]::Round($g.PrivateMemorySize64 / 1MB) } } })
  $sum = 0; foreach ($m in $mib) { $sum += $m.privateMiB }
  if ($sum -gt $maxSum) { $maxSum = $sum; $maxAt = $mib }
  Start-Sleep -Milliseconds 200
}
$exited = $p.HasExited
$allocs = @(foreach ($i in 0..2) { $f = "$run\state\child-$i.json"; if (Test-Path $f) { (Read-Json $f).alloc } else { [ordered]@{ ok = $false; gotMiB = 0; error = 'no report (the child could not start or was ended)' } } })
$log = Text "$run\state\supervisor.log"
$peak = if ($log -match 'job peak committed memory (\d+) MiB') { [int]$Matches[1] } else { -1 }
Check 'W2-single the first 120 MiB commit succeeds' ($allocs[0].ok -eq $true) $allocs[0]
Check 'W2-single a later commit is refused by the 300 MiB job limit' (@($allocs[1..2] | Where-Object { $_.ok -ne $true }).Count -ge 1) @($allocs)
Check 'W2-single the job peak stayed within the 300 MiB limit' ($peak -gt 0 -and $peak -le 300) ([ordered]@{ peakMiB = $peak; exited = $exited })
Check 'W2-single sampled commit of the whole tree never exceeded 300 MiB' ($maxSum -gt 0 -and $maxSum -le 300) ([ordered]@{ maxSumMiB = $maxSum; at = $maxAt })
Done
