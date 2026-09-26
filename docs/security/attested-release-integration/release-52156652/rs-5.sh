#!/usr/bin/env bash
# rs-5 (rs-N, enclave-87's GO): the relay's predictor gets release 52156652 (image 4cdd5169) BEFORE guestd builds from its
# tree (63's S5 tree switch checks /v1/expected-guest lists it admitted for each canary). Staged on nan by
# stage-release-keep.sh at /opt/enclave-predict/rel-52156652d67a, sandboxed check PASS (api-mcp-adapter 20b36648 = 5d's;
# 79c5ecf2 kept at 20319b02). This feeds rs-5-remote.sh to nan (root): the two env lines, line-wise, ONE api-relay restart.
#   rs-5.sh apply      PREDICT_RELEASES + 52156652 (5c3561f9, 6f14ce75, a4f22748, 79c5ecf2 kept),
#                      DOMAIN_RELEASES = 79c5ecf2,52156652 (BOTH: the canaries run 79c5ecf2 until 63's relaunch)
#   rs-5.sh rollback   the two lines back (= rs-4's: DOMAIN_RELEASES = 79c5ecf2); only before any guest runs 52156652
# Then: rs-5-accept.sh apply|rollback. The release stays ON for exactly the 3 canaries: this edit does not touch it.
# Later (87): the RETIRE edit (DOMAIN_RELEASES = 52156652, 79c5ecf2 uninstalled) after the relaunch, before step 6.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-5.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/rel-52156652d67a
NEW_SHA=daec659ecb4c7aac7ba7b645892972dcc8b44f0f76935fe3e8d551e9f17e0412   # predict-lines.env (the two new lines)
OLD_SHA=6f816b31766403acb439ccdc6bffde2cc32ecbfbd775d4cc2534d3d1163d5c55   # predict-lines.before.env (= the live two lines at staging = rs-4's after)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs5-$MODE-inv0.txt"
say "rs-5 $MODE: the two predictor lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs5-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/rs-5-remote.sh" > "$RS/rs5-$MODE.txt" 2>&1; rc=$?; set -e
cat "$RS/rs5-$MODE.txt"; say "rs-5 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-5-accept.sh $MODE")"
exit $rc
