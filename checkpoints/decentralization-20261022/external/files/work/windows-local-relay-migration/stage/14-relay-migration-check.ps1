# 14-relay-migration-check.ps1 - READ-ONLY gate after root has STOPPED the source relay and copied the moved key and its send
# record here, and before anything starts the key on this host. Public chain reads only; the key's content is never read.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\14-relay-migration-check.ps1
# Checks: the directory and both files are SYSTEM + Administrators only; the key file is present and non-empty; the
# migration gate (relay\lease-relay-migration-check.mjs) passes: the record is {} or the payee's own signed transaction,
# the payee's nonce is reconciled with it at a block the RPC quorum agrees on, nothing unknown is in flight, the balance is
# within the approved float, and the source origin no longer answers as this payee. Exit 0 reconciled | 1 refused.
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
$ok = $true
function Check([bool]$c, [string]$m) { if ($c) { Say "ok   $m" } else { Say "FAIL $m"; $script:ok = $false } }
Check (RelayDirAclOk) "$RelayData is SYSTEM + Administrators only"
foreach ($f in $RelayKey, $RelaySend) {
  $present = Test-Path -LiteralPath $f -PathType Leaf
  Check ($present -and (Get-Item -LiteralPath $f).Length -gt 0 -and (Get-Item -LiteralPath $f).Length -le 65536) "$f is present ($(if ($present) { "$((Get-Item -LiteralPath $f).Length) bytes" } else { 'absent' }))"
  if ($present) {
    $sids = @((Get-Acl -LiteralPath $f).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
    Check (@($sids | Where-Object { $_ -notin 'S-1-5-18', 'S-1-5-32-544' }).Count -eq 0) "$f grants only SYSTEM and Administrators ($($sids -join ','))"
  }
}
Check (@(RelayProcs).Count -eq 0 -and @(PortListeners $RelayPort).Count -eq 0) "nothing serves 127.0.0.1:$RelayPort on this host yet"
$env:LEASE_RELAY_RECORD = $LeaseDep; $env:LEASE_RELAY_DIGEST = $Digest; $env:LEASE_RELAY_RPCS = $Rpcs; $env:LEASE_RELAY_QUORUM = "$Quorum"
$env:LEASE_RELAY_STATE = $RelaySend; $env:LEASE_RELAY_EXPECTED_PAYEE = $Payee; $env:LEASE_RELAY_MAX_FLOAT_ETH = $MaxFloat; $env:LEASE_RELAY_SOURCE_ORIGIN = $SourceOrigin
$o = (& $Node $Migration 2>&1 | Out-String).Trim()
$code = $LASTEXITCODE
Say "  migration gate: $o"
Check ($code -eq 0) "the moved key's nonce is reconciled with its send record and the source no longer serves it"
Say "== $(if ($ok) { 'RECONCILED: the key may start here (15-install-relay.ps1)' } else { 'NOT RECONCILED: do not start the key here' })"
if ($ok) { exit 0 } else { exit 1 }
