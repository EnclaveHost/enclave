#!/usr/bin/env bash
# READ-ONLY qualification gates. Every gate whose evidence does not exist HOLDs; nothing is inferred from a non-empty file or
# variable. Root's approval is /etc/enclave-cutover/ACK-<baseline id> (root-only), lines key=<sha256>:
#   baseline=<sha256 of BASELINE.sha256>  release-receipt=<sha256>  verifier-receipt=<sha256>  backend-receipt=<sha256>
# Receipts (root-written, same dir): accepted-release.receipt, verifier-identity.receipt, backend-readiness.receipt.
#   15-gates.sh <baseline dir> <verifier url> <tx backend url> <staged release dir>    exit 0 all pass | 3 HOLD | 9 mismatch
. "$(dirname "$0")/lib.sh"
B=${1:?baseline} V=${2:?verifier url} TX=${3:?tx backend url} STAGE=${4:?staged release dir}
holds=() bad=(); H() { holds+=("$*"); }; M() { bad+=("$*"); }
receipt() { # <ack key> <receipt file> <label>: 0 = root-pinned receipt present and hash-equal; else records HOLD/MISMATCH
  local pin; pin=$(ack_get "$B" "$1") || { H "$3: no $1 hash in the root approval file (no such receipt exists)"; return 1; }
  [ -f "$2" ] || { H "$3: receipt $2 does not exist"; return 1; }
  [ "$(fsha "$2")" = "$pin" ] || { M "$3: receipt $2 is not the root-pinned hash"; return 1; }
  [ "$(tail -n 1 "$2")" = "## rc=0" ] || { M "$3: receipt does not end in '## rc=0'"; return 1; }; }
chain_id() { curl -sS --max-time 10 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$1" 2>/dev/null | sed -n 's/.*"result" *: *"\(0x[0-9a-fA-F]*\)".*/\1/p'; }

# G0 approval bound to this exact baseline
baseline_ok "$B" || M "baseline: $B missing or altered"
if a=$(ack_get "$B" baseline); then [ "$a" = "$(fsha "$B/BASELINE.sha256")" ] || M "approval: ACK-$(basename "$B") names another baseline"
else H "approval: no root approval $PINS/ACK-$(basename "$B") with baseline=<hash>"; fi

# G1 release: a staged candidate in deploy.sh's .deploy-manifest format, bound by a root-pinned receipt to an accepted commit
ms=""
if [ ! -d "$STAGE" ] || [ ! -f "$STAGE/.deploy-manifest" ]; then H "release: no staged release with .deploy-manifest at $STAGE (no accepted artifact exists)"
else
  if ! manifest_paths_ok "$STAGE/.deploy-manifest"; then M "release: .deploy-manifest has a malformed line or refused path"
  elif ! stage_ok "$STAGE"; then M "release: staged files do not match .deploy-manifest (deploy.sh sha256sum -c --strict / stray file)"
  else ms=$(fsha "$STAGE/.deploy-manifest"); fi
  for f in api-relay.js relay-chain-authority.mjs relay-chain-env.mjs; do grep -qE "^[0-9a-f]{64}  $f\$" "$STAGE/.deploy-manifest" || M "release: manifest lacks $f"; done
  [ ! -e "$STAGE/node_modules" ] || H "release: staged node_modules - a dependency swap is not implemented in r2 (deps must be unchanged)"
fi
RR=$PINS/accepted-release.receipt
if receipt release-receipt "$RR" release; then
  grep -qE '^accepted-commit=[0-9a-f]{40}$' "$RR" || M "release: receipt names no accepted-commit=<40 hex>"
  if [ -n "$ms" ] && ! grep -qxF "deploy-manifest-sha256=$ms" "$RR"; then M "release: receipt does not bind this staged .deploy-manifest"; fi
fi

# G2 verifier: loopback, answers Base, AND a root-pinned identity receipt for exactly this URL (eth_chainId alone is never enough)
loopback_url "$V" || M "verifier: $V is not http://127.0.0.1:<port>"
if receipt verifier-receipt "$PINS/verifier-identity.receipt" verifier; then
  grep -qxF "verifier-url=$V" "$PINS/verifier-identity.receipt" || M "verifier: identity receipt is not for $V"; fi
[ "$(chain_id "$V")" = 0x2105 ] || H "verifier: $V does not answer eth_chainId 0x2105 now"

# G3 own tx backend: private literal, not the public gateway / any caddy upstream / the verifier, readiness receipt for this URL
if ! private_url "$TX"; then M "backend: $TX is not a loopback/private IPv4 literal"
else
  [ "${TX##*:}" != 8190 ] && [ "${TX##*:}" != 8190/ ] || M "backend: port 8190 is the public gateway, not an own backend"
  [ "$(hostport "$TX")" != "$(hostport "$V")" ] || M "backend: equals the verifier"
  if [ -r "$CADDY" ]; then grep -oE '"dial" *: *"[^"]*"' "$CADDY" | sed 's/.*"\([^"]*\)"$/\1/' | grep -xF "$(hostport "$TX")" >/dev/null && M "backend: $TX is a caddy upstream"
  else M "backend: cannot read $CADDY to exclude caddy upstreams"; fi
fi
if receipt backend-receipt "$PINS/backend-readiness.receipt" backend; then
  grep -qxF "tx-backend=$TX" "$PINS/backend-readiness.receipt" || M "backend: readiness receipt is not for $TX"; fi
[ "$(chain_id "$TX")" = 0x2105 ] || H "backend: $TX does not answer eth_chainId 0x2105 now"

# G4 canary protocol: none exists, so any mutation would end in rollback (30-canary.sh always HOLDs). HOLD before mutating.
if [ -n "$R" ] && [ "${CUTOVER_TEST_ALLOW_MUTATION:-}" = yes ]; then say "[TEST] canary-protocol gate bypassed inside the test root only"
else H "canary: no reviewed app/lease/secrets-v1 canary protocol exists; a cutover could not be accepted, so nothing is mutated"; fi

for x in "${bad[@]}"; do say "[MISMATCH] $x"; done; for x in "${holds[@]}"; do say "[HOLD] $x"; done
[ ${#bad[@]} = 0 ] || exit $RC_MISMATCH
[ ${#holds[@]} = 0 ] || exit $RC_HOLD
say "## all gates pass (release manifest $ms)"
