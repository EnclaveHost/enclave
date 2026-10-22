# W1 CPU-rate hard cap: one child spins 4 s wall time, first under cpuPercent=50 (of one logical CPU), then under 1600
# (no effective cap on 16 CPUs). At most one core for 4 s each: no disruption.
. "$PSScriptRoot\common-val.ps1"
$out = [ordered]@{}
foreach ($k in 'cpu50', 'cpu1600') {
  $run = "$V\runs\w1-$k"
  $p = Start-Sup $run
  $null = Wait-Until { $p.HasExited } 60
  $f = "$run\state\child-0.json"
  $out[$k] = if (Test-Path $f) { (Read-Json $f).cpu } else { $null }
}
$frac = { param($c) if ($c) { ($c.userMs + $c.systemMs) / [double]$c.wallMs } else { -1 } }
$capped = & $frac $out.cpu50; $free = & $frac $out.cpu1600
Check 'W1 CPU hard cap: the 50% job used at most ~0.6 of one CPU, the uncapped job ~1' (($capped -gt 0) -and ($capped -le 0.65) -and ($free -ge 0.8)) ([ordered]@{ cpu50 = $out.cpu50; cpu1600 = $out.cpu1600; fraction50 = [math]::Round($capped, 3); fraction1600 = [math]::Round($free, 3) })
Done
