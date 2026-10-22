# 95-rollback-relay.ps1 - takes the moved key OUT OF SERVICE on this host (root runs it; never automatic), so that root can
# move it back to its source. It stops and disables task \Enclave\Relay and its relay process and waits until nothing
# serves 127.0.0.1:8549. It NEVER deletes or reads the key, and never deletes the send record: that record is this key's
# journal from now on (root copies it back with the key and reconciles the nonce before the source starts again).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\95-rollback-relay.ps1
# If the node still names the local relay (settings "after"), it keeps working through eu-central; run 90-rollback.ps1 too.
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
if ((CfgState) -eq 'after') { Say "note: the node still names $RelayUrl first; it falls over to $Fallback while the relay is out of service (90-rollback.ps1 restores the previous settings)" }
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -ErrorAction SilentlyContinue
Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -ErrorAction SilentlyContinue | Out-Null
for ($i = 0; $i -lt 20 -and @(RelayProcs).Count; $i++) { Start-Sleep 1 }
foreach ($p in @(RelayProcs)) { Stop-Process -Id $p.ProcessId -Force }
for ($i = 0; $i -lt 20 -and (@(RelayProcs).Count -or @(PortListeners $RelayPort).Count); $i++) { Start-Sleep 1 }
if (@(RelayProcs).Count -or (RelayInfo)) { Say "NOT OUT OF SERVICE: a relay still runs or answers on $RelayUrl; do NOT start the key anywhere else"; exit 1 }
$shape = 'absent'
if (Test-Path -LiteralPath $RelaySend) { try { $r = Get-Content -LiteralPath $RelaySend -Raw | ConvertFrom-Json; $shape = $(if ($r.hash) { "UNRESOLVED nonce $($r.nonce) hash $($r.hash): copy it back WITH the key" } else { 'nothing unresolved' }) } catch { $shape = 'not JSON: settle by hand' } }
Say "OUT OF SERVICE: task \Enclave\Relay disabled, nothing serves $RelayUrl. Kept: $RelayKey, $RelaySend (send record: $shape)"
exit 0
