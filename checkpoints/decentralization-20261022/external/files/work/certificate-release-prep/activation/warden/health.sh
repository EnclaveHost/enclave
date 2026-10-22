#!/bin/bash
# Root (read-only): the staged challenge service's health. Prints, never changes anything.  bash health.sh <label>
set -uo pipefail
ETC=/etc/enclave-challenge/$1; ok=1
zone=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).challengeReplica.zones.app' "$ETC/challenge.json")
origin=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).challengeReplica.front.origin' "$ETC/challenge.json")
echo "== unit"; systemctl show enclave-challenge-host.service -p ActiveState -p SubState -p NRestarts -p MemoryCurrent
echo "== replica /health (loopback API)"
h=$(curl -fsS http://127.0.0.1:18254/health) || { echo "FAIL replica API"; ok=0; }
[ -n "${h:-}" ] && echo "$h" | node -e 'const h=JSON.parse(require("fs").readFileSync(0,"utf8")),a=h.appChallenge||{};
 const r={readOnly:h.readOnly,mode:a.mode,judgeMode:a.judgeMode,ledgerComplete:a.ledgerIndex?.complete,snpMeasurements:a.measurements,
  shield:a.shield&&{hostExcluded:a.shield.hostExcluded,liveHostSessions:a.shield.liveHostSessions,profileDigest:a.shield.registry?.profileDigest}};
 console.log(JSON.stringify(r)); process.exit(r.readOnly===true&&r.mode==="attested-lease"&&r.judgeMode==="trusted"&&r.ledgerComplete===true?0:1)' || { echo "FAIL replica state"; ok=0; }
echo "== DNS (loopback)"; dig +norec +time=2 +tries=1 @127.0.0.1 -p 18253 SOA "$zone" | grep -E "status:|flags:|SOA" || { echo "FAIL DNS"; ok=0; }
echo "== HTTPS front (loopback, by its name)"
host=${origin#https://}; curl -fsS --resolve "$host:18443:127.0.0.1" "https://$host:18443/health" >/dev/null && echo "front OK ($origin)" || { echo "FAIL front"; ok=0; }
echo "== recent log"; journalctl -u enclave-challenge-host.service -n 15 --no-pager
[ $ok = 1 ] && echo HEALTH OK || { echo HEALTH FAIL; exit 1; }
