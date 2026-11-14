#!/bin/bash
# Make the NucBox sign a new route delegation for sia-s3 now, instead of when its cached one runs out (signed
# 2026-11-13 07:44:08Z, renewed five minutes before 11-14 07:44:08Z).
#
#   renew-route-delegation.sh status    read only: what the NucBox holds, whether the app's name resolves
#   renew-route-delegation.sh apply     remove the cached delegation from the app's route identity on the NucBox
#
# Why: the owner pinned sia-s3 to the NucBox at 00:57:58Z on 11-14. metal0 had run it since 00:17:57Z and published its
# route under a delegation signed then. The NucBox still holds its own, a day older, and every directory refuses a
# record under an older delegation than one it has seen ("route rollback or equivocation", network/route-record.mjs).
# So 0xef514ed3's name has no address, and every app that reaches storage by that name fails, on the same host too:
# the gateway app cannot rebuild its index, cron answers 503.
# What apply changes: one file on the NucBox, C:\ProgramData\Enclave\network\state\routes\identity-<app>.json. Its
# "authorization" (the cached delegation and its signature) is dropped; the route key and the sequence stay. The
# agent reads the file at every publish (about once a minute) and, finding no delegation, signs one whose epoch is now.
# A copy of the file as it was is left beside it (….before-renew-20261114; it holds the route key, like the file).
# Nothing is restarted. The key and the signatures are never printed. This edits a file the running agent owns; the
# source fix that makes the agent do this by itself (network/route-publisher.mjs, superseded) is not installed anywhere.
set -euo pipefail
MODE=${1:-status}
[ "$MODE" = status ] || [ "$MODE" = apply ] || { echo "usage: $0 status|apply"; exit 2; }
say() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
answer() { curl -s -m 10 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=ef514ed3.app.enclave.host&type=A" | grep -o '"data":"[0-9.]*"' | tr '\n' ' ' || true; }
health() { curl -s -m 15 -o /dev/null -w '%{http_code}' https://ef514ed3.app.enclave.host/healthz || true; }
gateway() { curl -s -m 20 https://7ae476a3.app.enclave.host/api/status | python3 -c "import sys,json;d=json.load(sys.stdin);print('gateway',d.get('state'),'files',d.get('files'),'queue',d.get('queue'),'hashed',d.get('hashedBytes'),'of',d.get('toHashBytes'))" 2>/dev/null || echo "gateway status unreadable"; }

say "mode $MODE"
{ echo "\$mode = '$MODE'"; cat <<'P'; } | ssh -o BatchMode=yes -o ConnectTimeout=15 minipc 'powershell -NoProfile -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 | sed '/post-quantum\|store now\|openssh.com\/pq/d'
$ErrorActionPreference = 'Stop'
$id = '0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
$old = [int64]1794555848130   # the delegation the directories refuse
$f = "C:\ProgramData\Enclave\network\state\routes\identity-$id.json"
function State { for ($i = 0; $i -lt 15; $i++) { try { return (Get-Content -Raw $f | ConvertFrom-Json) } catch { Start-Sleep -Milliseconds 200 } }; throw 'cannot read the route identity' }
function Epoch($o) { if ($o.authorization) { [int64]$o.authorization.delegation.epoch } else { [int64]0 } }
function Show($o) { $e = Epoch $o; if ($e) { 'delegation signed ' + [DateTimeOffset]::FromUnixTimeMilliseconds($e).UtcDateTime.ToString('MM-dd HH:mm:ss') + 'Z, sequence ' + $o.sequence } else { 'no delegation cached, sequence ' + $o.sequence } }
$o = State
'NucBox holds: ' + (Show $o)
if ($mode -ne 'apply') { return }
$extra = @($o.PSObject.Properties.Name | Where-Object { $_ -notin 'seed', 'sequence', 'authorization' })
if ($extra.Count -or $o.seed -notmatch '^[0-9a-f]{64}$' -or [int64]$o.sequence -lt 0) { 'STOP: the route identity is not in the shape this script knows; nothing changed'; return }
if ((Epoch $o) -ne $old) { 'NOTHING TO DO: the cached delegation is not the refused one; nothing changed'; return }
$bak = "$f.before-renew-20261114"
if (-not (Test-Path $bak)) { Copy-Item $f $bak }
for ($round = 1; $round -le 6; $round++) {
  $o = State
  if ((Epoch $o) -gt $old) { break }
  # still the old one: never removed, or the agent wrote its copy back over the removal
  if ((Epoch $o) -eq $old) {
    $tmp = "$f.renew-$PID"
    [IO.File]::WriteAllText($tmp, '{"seed":"' + $o.seed + '","sequence":' + [int64]$o.sequence + '}')
    for ($i = 0; ; $i++) { try { Move-Item -Force $tmp $f; break } catch { if ($i -ge 20) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue; throw }; Start-Sleep -Milliseconds 100 } }
    "round ${round}: cached delegation removed"
  }
  Start-Sleep -Seconds 20
}
$o = State
if ((Epoch $o) -gt $old) { 'RENEWED: ' + (Show $o) } else { 'NOT RENEWED after two minutes: ' + (Show $o) + '. The file as it was: ' + $bak }
P

say "name ef514ed3.app.enclave.host: $(a=$(answer); echo "${a:-no address}"), healthz $(health)"
gateway
[ "$MODE" = apply ] || exit 0
for i in $(seq 1 30); do
  a=$(answer); h=$(health)
  if [ -n "$a" ] && [ "$h" = 200 ]; then say "BACK: the name resolves ($a) and storage answers 200 on its public address"; gateway; exit 0; fi
  sleep 10
done
say "NOT BACK after five minutes: name $(a=$(answer); echo "${a:-no address}"), healthz $(health)"; gateway; exit 1
