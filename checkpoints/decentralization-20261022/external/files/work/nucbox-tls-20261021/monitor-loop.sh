#!/usr/bin/env bash
# post-activation monitoring: rounds >= 65 s apart, until 10 min after the 12:13:07Z restart (12:23:07Z), stopping early after
# two consecutive rounds in which all three apps answer verified HTTPS
cd "$(dirname "$0")"
END=$(date -d '2026-10-21T12:23:07Z' +%s); ok=0; n=0
while [ "$(date +%s)" -lt "$END" ]; do
  t0=$(date +%s); n=$((n+1))
  echo "=== round $n $(date -u +%T)Z" >> monitor-rounds.log
  bash monitor-round.sh >> monitor-rounds.log 2>&1
  if tail -1 monitor.jsonl | python3 -c "import sys,json;j=json.loads(sys.stdin.read());sys.exit(0 if all(v.get('verified') for v in j['https'].values()) else 1)"; then ok=$((ok+1)); else ok=0; fi
  [ $ok -ge 2 ] && { echo "=== two consecutive verified rounds" >> monitor-rounds.log; break; }
  el=$(( $(date +%s) - t0 )); [ $el -lt 65 ] && sleep $((65 - el))
done
echo "=== monitor done $(date -u +%T)Z rounds=$n" >> monitor-rounds.log
