#!/bin/bash
# READ-ONLY narrow host lines via the existing probe.py transport (redacted, bounded tails, pattern-filtered).
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
S=storage-network
timeout 300 python3 probe.py grep network.log --tail 4000 --max 40 --pat '38f368d6|ef514ed3' --not 'policy requires the current lease' > $S/net-lines.json; echo net rc=$?
timeout 300 python3 probe.py grep 'partitions\enclave-app-hv80df703cb1442b*' --tail 400 --max 40 --pat 'egress|storage|FENCED|cron|proxy|refused|route|dns|resolve' > $S/partition-lines.json; echo part rc=$?
timeout 300 python3 probe.py grep node.log --tail 6000 --max 25 --pat '38f368d6|hv80df703' > $S/node-lines.json; echo node rc=$?
