#!/usr/bin/env bash
# rs-7 (enclave-87's GO 09-26): the relay's predictor gets the HARDENED release f7888d86 (image b63c2def: 5d's dominit +
# 298924ae's front) BESIDE 52156652, before 63's S7 tree switch builds guests from it. Staged on nan by stage-release-keep.sh
# at /opt/enclave-predict/rel-f7888d869084 (sandboxed check PASS: api-mcp-adapter a3a4c718 under f7888d86, 52156652 kept at
# 20b36648; 63's independent pins equal mine). This feeds rs-7-remote.sh to nan (root): two env lines, ONE api-relay restart.
#   rs-7.sh apply      PREDICT_RELEASES + f7888d86 (5c3561f9, 6f14ce75, 52156652 kept); DOMAIN_RELEASES = 52156652,f7888d86
#   rs-7.sh rollback   the two lines back (= rs-6's); only before any guest runs f7888d86
# Then: rs-7-accept.sh apply|rollback. The release stays ON for the 7 listed deployments. The retire of 52156652 (rs-8) only
# after every running guest has moved.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-7.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/rel-f7888d869084
NEW_SHA=79f3f32abf86a70ad054f2b871fcd576d0d23425eed814879b952b79374926bf   # predict-lines.env (staged 03:06:41-03:07:50Z, sandboxed check PASS)
OLD_SHA=0dabb75b92e979692bf4b9c10446d15fcbeb4b2d0b9618d4956df9e73fc13bb6   # predict-lines.before.env (= the live lines = rs-6's after)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs7-$MODE-inv0.txt"
say "rs-7 $MODE: the two predictor lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs7-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/rs-7-remote.sh" > "$RS/rs7-$MODE.txt" 2>&1; rc=$?; set -e
cat "$RS/rs7-$MODE.txt"; say "rs-7 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-7-accept.sh $MODE")"
exit $rc
