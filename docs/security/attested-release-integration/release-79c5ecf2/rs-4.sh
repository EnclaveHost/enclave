#!/usr/bin/env bash
# rs-4: the relay's predictor gets release 79c5ecf2 BEFORE guestd builds from its tree (the S4 tree switch refuses until the
# relay predicts AND admits it). Staged on nan by stage-release.sh (d3ed78aa) at /opt/enclave-predict/rel-79c5ecf24eb4,
# sandboxed check PASS. This feeds rs-4-remote.sh to nan (root): the two env lines, line-wise, ONE api-relay restart.
#   rs-4.sh apply      PREDICT_RELEASES + 79c5ecf2 (5c3561f9, 6f14ce75, a4f22748 kept), DOMAIN_RELEASES = 79c5ecf2
#   rs-4.sh rollback   the two lines back (DOMAIN_RELEASES = a4f22748); after a tree-switch rollback, before any release turn-on
# Then: rs-4-accept.sh apply|rollback. The release stays OFF throughout (the remote refuses otherwise).
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-4.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/rel-79c5ecf24eb4
NEW_SHA=6f816b31766403acb439ccdc6bffde2cc32ecbfbd775d4cc2534d3d1163d5c55   # predict-lines.env (the two new lines)
OLD_SHA=b3f4a67aa76fe9aed4c724ae7d890c9b4883eb586bb470967d735bc719288fd7   # predict-lines.before.env (= the live two lines at staging)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs4-$MODE-inv0.txt"
say "rs-4 $MODE: the two predictor lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs4-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/rs-4-remote.sh" > "$RS/rs4-$MODE.txt" 2>&1; rc=$?; set -e
cat "$RS/rs4-$MODE.txt"; say "rs-4 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-4-accept.sh $MODE")"
exit $rc
