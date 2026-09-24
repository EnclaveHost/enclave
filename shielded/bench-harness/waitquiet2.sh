#!/bin/bash
# Wait (max 60 min) until no foreign process uses more than 50% of a core NOW
# (cpunow.py: CPU ticks over a 3 s window). waitquiet.sh used ps's pcpu, a
# LIFETIME average: a compositor busy hours ago read as busy forever, and a
# fresh burst read as idle.
B=/home/steven/enclave-bench/b27
for i in $(seq 1 240); do
  I=$(python3 $B/cpunow.py 3 50)
  [ -z "$I" ] && exit 0
  sleep 12
done
echo "waitquiet2: still busy after 60 min: $I"
