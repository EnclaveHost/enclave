#!/usr/bin/env bash
# Step 1 (enclave-d1's order): on nan, BEFORE the push, append predict.env's 11 lines to api-relay.env (backup first, the
# file stays 0600 root, one guard per key), install predict.conf, daemon-reload. The RUNNING (old) relay ignores the new
# env and only gains MemoryMax 1536M live: its PID and restart count must not change. Prints no values.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
[ "$(sha256sum < $RS/predict.conf | cut -c1-64)" = "$CONF_SHA" ] || { say "REFUSING: predict.conf is not the reviewed one"; exit 2; }
before=$(serving_nodes) || { say "REFUSING: /enclaves unreadable"; exit 2; }; echo "$before" > $RS/serving-before.txt
STAMP=$(date -u +%Y%m%dT%H%M%SZ); echo "$STAMP" > $RS/stamp.txt; say "step 1 ($STAMP): serving nodes before: $before"
$NAN "install -m 600 /dev/stdin /root/predict.conf.slice-$STAMP" < $RS/predict.conf || { say "REFUSING: copying predict.conf failed"; exit 3; }
$NAN "LINES_SHA=$LINES_SHA STAGED=$STAGED ENVF=$ENVF DROPIN=$DROPIN CONF_SHA=$CONF_SHA STAMP=$STAMP bash -s" < $RS/rs-1-remote.sh > $RS/step1-remote.txt 2>&1 \
  || { cat $RS/step1-remote.txt; say "STEP 1 FAILED on nan (step1-remote.txt): the relay was not restarted; rollback: rs-rollback-config.sh"; exit 3; }
cat $RS/step1-remote.txt; say "step 1 done: the env appended and the drop-in installed; the old relay is unchanged"
