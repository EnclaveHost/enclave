#!/bin/bash
# waitquiet2.sh, with the desktop compositor (picom) exempt, as in run10.sh: it is
# busy for hours at a time with the user's desktop (and while the cards work),
# it is recorded per run (compositor= in .meta), and it can only slow a run.
# Every other process above 50% of a core NOW still holds the queue.
B=/home/steven/enclave-bench/b27
for i in $(seq 1 240); do
  I=$(python3 $B/cpunow.py 3 50 | tr ' ' '\n' | grep -v '^picom:' | grep -v '^$' | tr '\n' ' ')
  [ -z "$I" ] && exit 0
  sleep 12
done
echo "waitquiet3: still busy after 60 min: $I"
