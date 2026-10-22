# READ-ONLY: production must be exactly as the baseline says. Every non-canary VM keeps its name, id, state and Notes;
# every pre-existing service registration stays; \Enclave tasks keep their state; the installed release is untouched.
# Exit 1 on any drift (listed). Canary-prefixed VMs and canary-added services are reported, not counted as drift.
param([Parameter(Mandatory)] [string]$Baseline, [switch]$AllowCanaryServices)
. (Join-Path $PSScriptRoot "lib.ps1")
$b = Get-Content $Baseline -Raw | ConvertFrom-Json
if (-not $b.PSObject.Properties["installedManifestSha256"]) { throw "baseline predates installed manifest checking; capture a fresh read-only baseline" }
$n = Snapshot; $drift = @()
$prodB = @($b.vms | Where-Object { -not $_.name.StartsWith($CanaryPrefix) }); $prodN = @($n.vms | Where-Object { -not $_.name.StartsWith($CanaryPrefix) })
foreach ($v in $prodB) {
  $m = $prodN | Where-Object { $_.id -eq $v.id }
  if (-not $m) { $drift += "VM gone: $($v.name) $($v.id)" }
  elseif ($m.name -ne $v.name -or $m.state -ne $v.state -or $m.notesSha256 -ne $v.notesSha256) { $drift += "VM changed: $($v.name) ($($v.state) -> $($m.state))" }
}
foreach ($v in $prodN) { if (-not ($prodB | Where-Object { $_.id -eq $v.id })) { $drift += "VM appeared outside the canary prefix: $($v.name)" } }
foreach ($g in $b.gcs) { $m = $n.gcs | Where-Object { $_.id -eq $g.id }; if (-not $m -or $m.name -ne $g.name) { $drift += "service registration changed: $($g.id)" } }
foreach ($g in $n.gcs) { if (-not ($b.gcs | Where-Object { $_.id -eq $g.id })) {
  if ($AllowCanaryServices -and $CanaryServices.Contains($g.id)) { Write-Output "canary service present: $($g.id)" } else { $drift += "service registration added: $($g.id)" } } }
foreach ($t in $b.tasks) { $m = $n.tasks | Where-Object { $_.name -eq $t.name }; if (-not $m) { $drift += "task gone: $($t.name)" } elseif ($m.state -ne $t.state) { $drift += "task $($t.name): $($t.state) -> $($m.state)" } }
if ($n.installedManifestSha256 -ne $b.installedManifestSha256) { $drift += "the installed release changed" }
Write-Output ("canary VMs now: " + (@($n.vms | Where-Object { $_.name.StartsWith($CanaryPrefix) } | ForEach-Object { "$($_.name) $($_.state)" }) -join ", "))
if ($drift.Count) { $drift | ForEach-Object { Write-Output "DRIFT $_" }; exit 1 } else { Write-Output "INVARIANTS HOLD: $($prodB.Count) production VMs unchanged" }
