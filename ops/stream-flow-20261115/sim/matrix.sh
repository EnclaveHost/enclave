#!/bin/sh
# matrix.sh <repo> <seconds>   reads lines "lanes [flowsim flags...]" and prints one summary line for each
R=$1; T=$2; D=$(cd "$(dirname "$0")" && pwd)
while read lanes flags; do
  echo "== lanes $lanes $flags"
  timeout $((T+70)) unshare -r -n "$D/run.sh" "$R" $lanes $T $flags 2>&1 | python3 -c "
import sys,json
ls=[l for l in sys.stdin.read().splitlines() if l.startswith('{')]
if len(ls)<2: print('  FAILED', ls); sys.exit()
c=json.loads(ls[0]); s=json.loads(ls[1]); f=s.get('flow',{})
d=c['packetDelayMs']; fd=c['frameDelayMs']
print('  packet delay p50/p95/p99/max', d['p50'],d['p95'],d['p99'],d['max'],'| frames shown',c['frames']['shown'],'missing',c['frames']['missing'],'longest gap',c['frames']['longestGap'],'| frame delay p99',fd['p99'],'| front sent',f.get('Sent'),'dropped',f.get('Dropped'),'hedged',f.get('Hedged'),'| per5s',c['medianDelayPer5s'],'| rto',s['tcp']['timeouts'])"
done
