#!/usr/bin/env bash
# U7 rollback, us-west (7.5; FIRST, before nan/nan-relay): the *.pre-u7 files back, restart enclave-tcp-relay, the canaries 200.
set -euo pipefail; source ~/enclave-bench/u7-20260925/lib.sh
$US 'test -f /opt/nan-relay/relay.js.pre-u7 && test -f /opt/nan-relay/fleet.mjs.pre-u7' || { say "REFUSING: no *.pre-u7 backups on us-west"; exit 2; }
$US 'cp -p /opt/nan-relay/relay.js.pre-u7 /opt/nan-relay/relay.js && cp -p /opt/nan-relay/fleet.mjs.pre-u7 /opt/nan-relay/fleet.mjs && systemctl restart enclave-tcp-relay'
t=$(( $(date +%s) + 60 )); while [ $(date +%s) -lt $t ]; do sleep 5; done
$US 'systemctl is-active --quiet enclave-tcp-relay' && canary200 dns && say "U7 us-west ROLLED BACK and the canaries serve" || { say "U7 us-west ROLLBACK CHECK FAILED: escalate"; exit 21; }
