#!/usr/bin/env bash
# Rollback of B step 1b: the *.pre-b files back, restart enclave-tcp-relay, the canaries 200 via DNS.
set -euo pipefail; source "$(dirname "$0")/lib.sh"
$US 'test -f /opt/nan-relay/relay.js.pre-b && test -f /opt/nan-relay/fleet.mjs.pre-b' || { say "REFUSING: no *.pre-b backups on us-west"; exit 2; }
$US 'cp -p /opt/nan-relay/relay.js.pre-b /opt/nan-relay/relay.js && cp -p /opt/nan-relay/fleet.mjs.pre-b /opt/nan-relay/fleet.mjs && systemctl restart enclave-tcp-relay'
sleep 60
$US 'systemctl is-active --quiet enclave-tcp-relay' && canaries_dns && say "B us-west ROLLED BACK and the canaries serve" || { say "B us-west ROLLBACK CHECK FAILED: escalate"; exit 21; }
