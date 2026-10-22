#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 250 python3 probe.py grep 'partitions\enclave-app-hv0b1723317c85ae*' --tail 300 --max 25 --pat 'certificate|egress|proxy|refused|cron|FENCED|storage|listening' > storage-network/progress-partition.json; echo part rc=$?
timeout 250 python3 probe.py grep network.log --tail 1500 --max 15 --pat '38f368d6' > storage-network/progress-net.json; echo net rc=$?
timeout 250 python3 probe.py grep node.log --tail 3000 --max 10 --pat '38f368d6' --not 'config: bafkre' > storage-network/progress-node.json; echo node rc=$?
