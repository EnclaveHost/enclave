# 15-install-relay.ps1 - installs and starts the moved key as this host's OWN loopback relay (task \Enclave\Relay), with the
# reviewed release and the source relay's own settings (same record, RPCs, quorum and approved float; loopback 8549).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\15-install-relay.ps1 -Reviewed
# 1. the migration gate again (14-relay-migration-check.ps1 must pass right now);
# 2. relay\install-lease-relay.ps1 -ExpectedPayee (MIGRATION mode): no key is ever generated; the existing key and send
#    record are kept; the relay must answer as exactly the moved payee for the reviewed record, else its task is stopped and
#    disabled. Nothing points the node agent at it yet (20-activate.ps1 does, after this passed).
# Exit: 0 serving the moved key | 2 refused, nothing installed | other: the installer's (3 no answer, 4 another payee: the
# task is stopped and disabled; the key and send record are kept).
param([string]$Stage = $PSScriptRoot, [switch]$Reviewed)
. (Join-Path $Stage 'common.ps1')
if (-not $Reviewed) { Say "refused: run with -Reviewed after 14-relay-migration-check.ps1 passed"; exit 2 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '00-verify-stage.ps1') -Stage $Stage
if ($LASTEXITCODE -ne 0) { Say "refused: the stage does not verify; nothing was installed"; exit 2 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '14-relay-migration-check.ps1') -Stage $Stage
if ($LASTEXITCODE -ne 0) { Say "refused: the migration gate did not pass; nothing was installed"; exit 2 }
$relMan = Get-Content -LiteralPath (Join-Path $Relay 'release\manifest.json') -Raw | ConvertFrom-Json
if ($relMan.artifact.sha256 -ne $RelaySha) { Say "refused: the staged release is $($relMan.artifact.sha256), not the reviewed $RelaySha"; exit 2 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Relay 'install-lease-relay.ps1') -Release (Join-Path $Relay 'release') -ArtifactSha256 $RelaySha `
  -Record $LeaseDep -Digest $Digest -Rpcs $Rpcs -Quorum $Quorum -MaxFloatEth $MaxFloat -MinFloatEth $MinFloat -Port $RelayPort -ExpectedPayee $Payee
$code = $LASTEXITCODE
if ($code -ne 0) { Say "the installer exited ${code}: the relay is not serving the moved key (its task is stopped and disabled when it answered otherwise); see $PD\logs\lease-relay.log"; exit $code }
if (-not (RelayIsTheMovedKey)) { Say "error: the relay does not answer as the moved key"; exit 1 }
Say "SERVING: $RelayUrl answers as the moved key $Payee; next: 10-preflight.ps1 -AfterRelay, then 20-activate.ps1 -Reviewed"
exit 0
