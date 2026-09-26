#!/usr/bin/env bash
# rs-8 (the RETIRE of 52156652, enclave-87's order 09-26): after 63's S7 tree switch and the canaries relaunched on the hardened
# f7888d86, the relay stops admitting AND installing 52156652: a guest on it gets neither secrets nor a certificate. Staged on
# nan by stage-retire.sh at /opt/enclave-predict/retire-52156652 (sandboxed check PASS 04:03Z). This feeds rs-8-remote.sh to
# nan (root): the two env lines, line-wise, ONE api-relay restart (the NucBox soak: at most one restart per 10 min).
#   rs-8.sh apply      PREDICT_RELEASES = 5c3561f9, 6f14ce75 (the KAT's), f7888d86; DOMAIN_RELEASES = f7888d86
#   rs-8.sh rollback   the two lines back (= rs-7's: 52156652 installed and admitted beside f7888d86)
# Then: rs-8-accept.sh apply|rollback.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-8.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/retire-52156652
NEW_SHA=1f3852b97b5a0d5aff249096cc2f2116704a92cd75fa94618ecc951c76faaf4c   # predict-lines.env (staged 04:02:17-04:03:42Z, sandboxed check PASS)
OLD_SHA=79f3f32abf86a70ad054f2b871fcd576d0d23425eed814879b952b79374926bf   # predict-lines.before.env (= the live lines = rs-7's after)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# PRECONDITION of apply (the rs-6 guard, retargeted, enclave-87): EVERY release-listed deployment holding a live lease (from
# the ledger) - the 3 canaries at least - runs on f7888d86, CHIP-VERIFIED from each serving guest's own report
# (leased-attest.mjs: AMD chain, HOST_DATA, ABI/2 binding of our TLS handshake + fresh nonce + the admitted runtime, AppID,
# measurement = the pinned f7888d86 value). A guest still on 52156652 would lose its secrets and certificates: refused.
if [ "$MODE" = apply ]; then
  node "$H/leased-attest.mjs" "$H/../../../../relay" | tee "$RS/rs8-precondition.txt" || { say "REFUSING rs-8 apply: not every leased listed deployment is chip-verified on f7888d86"; exit 3; }
fi
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs8-$MODE-inv0.txt"
say "rs-8 $MODE: the two predictor lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs8-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/rs-8-remote.sh" > "$RS/rs8-$MODE.txt" 2>&1; rc=$?; set -e
cat "$RS/rs8-$MODE.txt"; say "rs-8 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-8-accept.sh $MODE")"
exit $rc
