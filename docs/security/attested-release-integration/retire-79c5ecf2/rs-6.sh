#!/usr/bin/env bash
# rs-6 (the RETIRE edit, enclave-87's ruling 09-26): after 63's S5 tree switch and the canaries relaunched on 52156652 with
# 4e MATCH, the relay stops admitting AND installing 79c5ecf2 and a4f22748: a guest on either gets neither secrets (the
# admitted set) nor a certificate (the installed set). Staged on nan by stage-retire.sh at /opt/enclave-predict/retire-79c5ecf2
# (sandboxed check PASS). This feeds rs-6-remote.sh to nan (root): the two env lines, line-wise, ONE api-relay restart.
#   rs-6.sh apply      PREDICT_RELEASES = 5c3561f9, 6f14ce75 (the KAT's), 52156652; DOMAIN_RELEASES = 52156652
#   rs-6.sh rollback   the two lines back (= rs-5's: 79c5ecf2 and a4f22748 installed, DOMAIN = 79c5ecf2,52156652)
# Then: rs-6-accept.sh apply|rollback. BEFORE step 6 (Steven's apps listed). The release stays ON for the 3 canaries.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-6.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/retire-79c5ecf2
NEW_SHA=__NEW__   # predict-lines.env (the two new lines; set when staged on nan)
OLD_SHA=daec659ecb4c7aac7ba7b645892972dcc8b44f0f76935fe3e8d551e9f17e0412   # predict-lines.before.env (= the live two lines = rs-5's after)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs6-$MODE-inv0.txt"
say "rs-6 $MODE: the two predictor lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs6-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/rs-6-remote.sh" > "$RS/rs6-$MODE.txt" 2>&1; rc=$?; set -e
cat "$RS/rs6-$MODE.txt"; say "rs-6 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-6-accept.sh $MODE")"
exit $rc
