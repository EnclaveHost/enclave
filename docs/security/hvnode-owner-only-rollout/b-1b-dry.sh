#!/usr/bin/env bash
# B step 1b's DRY (enclave-87, 09-26): everything that can be checked with NO us-west access, before Steven opens the master.
# Read-only; never connects to us-west (only `ssh -O check`, which asks the local control socket); calls no production path.
#   1. the files 1b deploys (B's relay.js/fleet.mjs at BC) = the pins = main's today; their import closure = relay.js, fleet.mjs,
#      connlog.mjs, net-guard.mjs (+ node:*, ws, viem) with the pinned hashes, unchanged since the pre-B pair us-west runs (2144fcb3);
#   2. both parse (node --check); the relay tests that exercise them pass at main (fleet, owner-only-fleet, custom-domain-routing);
#   3. files_are_b's closure refusal against FIXTURES (a shimmed $US): matching hashes pass, a changed connlog.mjs refuses;
#   4. the acceptance's public checks against LIVE public targets: test 1 refused TODAY (pre-1b), a canary 200 on its key with its
#      document bound to the handshake, and an unleased hostname at us-west to probe as the stranger.
set -uo pipefail; source "$(dirname "$0")/lib.sh"
n=0; f=0; t() { n=$((n+1)); if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; f=$((f+1)); fi; }
M=$(git -C $MAIN rev-parse origin/main); W=$(mktemp -d); trap 'rm -rf "$W"; git -C $MAIN worktree remove --force "$W/main" 2>/dev/null' EXIT
echo "--   us-west master: $(ssh -O check us-west 2>&1 | head -1) (1b is HELD until it is running; this DRY never connects)"
for x in relay.js fleet.mjs connlog.mjs net-guard.mjs; do
  b=$(git -C $MAIN show $BC:relay/$x | sha256sum | cut -c1-64); m=$(git -C $MAIN show $M:relay/$x | sha256sum | cut -c1-64); p=$(git -C $MAIN show 2144fcb34:relay/$x | sha256sum | cut -c1-64)
  [ "$b" = "${SHA[$x]}" ] && [ "$m" = "$b" ] && t ok "$x: B = the pin = main ${M:0:8} (${b:0:12})$([ "$p" = "$b" ] && echo "; = pre-B: already on us-west" || echo "; changes from pre-B ${p:0:12}")" || t no "$x: B ${b:0:12} pin ${SHA[$x]:0:12} main ${m:0:12}"
done
imports=$(git -C $MAIN show $BC:relay/relay.js; git -C $MAIN show $BC:relay/fleet.mjs; git -C $MAIN show $BC:relay/connlog.mjs; git -C $MAIN show $BC:relay/net-guard.mjs)
rel=$(grep -oE "(from|import\() *['\"]\./[^'\"]+['\"]" <<<"$imports" | grep -oE "\./[^'\"]+" | sort -u | tr '\n' ' ')
bare=$(grep -oE "(from|import\() *['\"][^./'\"][^'\"]*['\"]" <<<"$imports" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"" | grep -v '^node:' | sort -u | tr '\n' ' ')
[ "$rel" = "./connlog.mjs ./fleet.mjs ./net-guard.mjs " ] && t ok "relative imports of the closure: $rel" || t no "relative imports: '$rel'"
[ "$bare" = "viem viem/chains ws " ] && t ok "package imports (besides node:*): $bare (unchanged from pre-B)" || t no "package imports: '$bare'"
for x in relay.js fleet.mjs; do git -C $MAIN show $BC:relay/$x > $W/$x; done
node --check $W/relay.js && node --check $W/fleet.mjs && t ok "relay.js and fleet.mjs parse" || t no "a file does not parse"
git -C $MAIN worktree add -q --detach "$W/main" $M && ln -s /home/steven/Projects/enclave/node_modules "$W/main/node_modules" 2>/dev/null; ln -s /home/steven/Projects/enclave/relay/node_modules "$W/main/relay/node_modules" 2>/dev/null
for tf in fleet relay-hvnode-owner-only-fleet custom-domain-routing; do r=$(cd "$W/main" && timeout 600 node --test test/$tf.test.mjs 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
  [[ "$r" == *"# fail 0"* ]] && t ok "test/$tf.test.mjs at main: $r" || t no "test/$tf.test.mjs: $r"; done
# files_are_b's closure refusal, against fixtures: $US is a shim answering the pinned hashes, or a changed connlog.mjs
shim() { local c=$1; [[ "$c" == *connlog.mjs* ]] && { echo "${FIX_CONNLOG:-${SHA[connlog.mjs]}}  -"; return; }; [[ "$c" == *net-guard.mjs* ]] && { echo "${SHA[net-guard.mjs]}  -"; return; }; echo "0  -"; }
files_are_b shim connlog.mjs net-guard.mjs >/dev/null && t ok "fixture: us-west's closure as pinned -> files_are_b passes" || t no "fixture: the pinned closure refused"
out=$(FIX_CONNLOG=$(printf '0%.0s' $(seq 64)) files_are_b shim connlog.mjs net-guard.mjs) && t no "fixture: a changed connlog.mjs PASSES" || t ok "fixture: a changed connlog.mjs -> refused ($out)"
# the acceptance's public checks, on live public targets (read-only)
[ "$(dig +short ${TEST1:2:8}.app.enclave.host A | head -1)" = 5.78.85.108 ] && t ok "test 1's hostname resolves to us-west" || t no "test 1's hostname does not resolve to us-west"
g=$(public_get ${TEST1:2:8}); [ "$g" = "000 -" ] && t ok "test 1 public TODAY (pre-1b): refused ('$g'), as expected" || t no "test 1 public today: '$g'"
c=$(public_get 0ddbd824); [[ "$c" =~ ^200\ [0-9a-f]{64}$ ]] && t ok "public_get on a canary: '$(cut -c1-20 <<<"$c")…' (the key check's shape works)" || t no "public_get canary: '$c'"
bd=$(public_doc_binds 0ddbd824); [ "$bd" = bound ] && t ok "public_doc_binds on a canary: bound" || t no "public_doc_binds on a canary: $bd"
st=""; for d in $UNLEASED; do [ "$(curl -sS -m 20 "$API/v1/expected-guest?id=$d" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null)" = not_leased ] || continue
  [ "$(dig +short ${d:2:8}.app.enclave.host A | head -1)" = 5.78.85.108 ] || continue; st=$d; break; done
[ -n "$st" ] && t ok "the stranger probe today: ${st:2:8} (unleased, at us-west) -> $(public_get ${st:2:8})" || t no "no unleased us-west hostname to probe"
echo "b-1b-dry: $((n-f))/$n"; [ $f = 0 ]
