#!/usr/bin/env bash
# One 768 MiB queue job: every remaining node suite of the composition, SEQUENTIALLY (peak = one suite's processes), each
# through its existing runner, which unshares the network (loopback only). SYNTHETIC fixtures only. Exit 0 only if all pass.
set -euo pipefail
cd "$(dirname "$0")/tree"
rc=0
step() { echo "=== $*"; c=0; "$@" || c=$?; echo "[all] $* exit=$c"; [ $c -eq 0 ] || rc=1; }
step bash test/run-shield-certificates.sh replica     # Shield replica PROCESSES (fleet), failover, refusals
step bash test/run-certificate-hosted.sh appzone      # app-zone-shield unit + app-zone challenge/replica (SNP) on the composition
step bash test/run-certificate-hosted.sh sdk          # app-zone SDK vectors + history owner tools + checkpoint transport (main's integrated history)
step bash test/run-certificate-hosted.sh regress      # owner-name Shield responder, dns-relay modes, Shield host session/custody, Windows startup/sessions, network host
step bash test/run-shield-compat.sh                   # Windows private paths/private deployments, sessions, app-zone TLS, hvcert relay path
echo "[all] exit=$rc"; exit $rc
