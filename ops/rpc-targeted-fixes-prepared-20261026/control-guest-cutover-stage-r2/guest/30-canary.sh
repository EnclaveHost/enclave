#!/usr/bin/env bash
# READ-ONLY canary of an activated candidate. It can FAIL (1) or HOLD (3); in r2 it NEVER passes: the app / lease / secrets-v1
# release canary needs a reviewed protocol (operator test app, authenticated evidence binding app + lease + verifier + release)
# that does not exist. No variable (CANARY_DEPLOYMENT or any other) changes that.
#   30-canary.sh <baseline dir> <verifier url> <tx backend url> <activated InvocationID>
. "$(dirname "$0")/lib.sh"
B=${1:?baseline} V=${2:?verifier} TX=${3:?backend} INV=${4:?activated invocation id}
fail() { say "[FAIL] $*"; exit 1; }
systemctl is-active --quiet $UNIT || fail "$UNIT not active"
cur=$(unit_inv) || fail "no InvocationID for $UNIT"
[ "$cur" = "$INV" ] || fail "$UNIT invocation $cur is not the activated invocation $INV"
inv_journal "$cur" | grep -F "$AUTH_LINE" >/dev/null || fail "the current invocation $cur did not report the local verifier authority"
env_check "$B" "$V" "$TX" || fail "relay environment is not the baseline plus the chain authority"
for p in /v1/health /availability /v1/deployments; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:8100$p" || true)
  [ "$c" = 200 ] || fail "GET $p -> $c"; done
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://127.0.0.1:8100/v1/secrets || true)
[[ "$c" =~ ^40[0-9]$ ]] || fail "unauthenticated /v1/secrets -> $c (must refuse)"
orc=0; bash "$HERE/public-rpc-egress-observe.sh" $UNIT "$OBSERVE_SECS" || orc=$?
case $orc in 0) say "egress: no public provider connection observed";; 1) fail "the relay contacted a public RPC provider";;
  *) say "egress observation inconclusive (rc $orc)";; esac
hold "local checks passed for invocation $cur; app/lease/secrets-v1 release canary NOT RUN: no reviewed protocol exists (r2 has no pass path)"
