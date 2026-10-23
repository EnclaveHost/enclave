#!/bin/bash
# Mutation controls for the closure guards: each mutant disables ONE guard in a scratch copy; its suite must FAIL.
#   entry = source ##~## test files ##~## from ##~## to
set -u
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C" || exit 2
V=test/vault-deposit.anvil.test.mjs; P=test/lease-signing-policy.anvil.test.mjs; L=test/l1-portal.anvil.test.mjs
M=(
  "src/vault-deposit.mjs ##~## $V ##~## if (lower(l1Sender) === lower(owner) || ##~## if (false && lower(l1Sender) === lower(owner) ||"
  "src/vault-deposit.mjs ##~## $V ##~## if (!isPlainOrDelegatedEoa(s.ownerCode)) refuse ##~## if (false) refuse"
  "src/vault-deposit.mjs ##~## $V ##~## if (!s.held.env || (Number(sess.envs) ##~## if (false && (Number(sess.envs)"
  "src/vault-deposit.mjs ##~## $V ##~## if (s.seq === undefined || BigInt(s.seq) !== (nonce ##~## if (false && BigInt(s.seq) !== (nonce"
  "src/vault-deposit.mjs ##~## $V ##~## if (((BigInt(sess.actions) >> BigInt(action)) & 1n) !== 1n) refuse ##~## if (false) refuse"
  "src/vault-deposit.mjs ##~## $V ##~## if (op === 'release' && lower(m.to) ##~## if (false && lower(m.to)"
  "src/vault-deposit.mjs ##~## $V ##~## if (String(auth.nonce).toLowerCase() !== topUp.toLowerCase()) refuse ##~## if (false) refuse"
  "src/vault-deposit.mjs ##~## $V ##~## if (sep.toLowerCase() !== String(token.separator).toLowerCase()) refuse ##~## if (false) refuse"
  "src/vault-deposit.mjs ##~## $V ##~## if (s.ownerNonceUsed !== false) refuse ##~## if (false) refuse"
  "src/forced-inclusion.mjs ##~## $L ##~## if (lower(l1Snapshot.implementation) !== lower(pin.implementation)) refuse ##~## if (false) refuse"
  "src/forced-inclusion.mjs ##~## $L ##~## export const L1_VERIFIERS = Object.freeze(['l1-light-client', 'l1-execution-proof']); ##~## export const L1_VERIFIERS = Object.freeze(['l1-light-client', 'l1-execution-proof', 'test-anvil-l1']);"
  "src/lease-signing-policy.mjs ##~## $P ##~## if (forced !== undefined) refuse ##~## if (false) refuse"
  "src/lease-signing-policy.mjs ##~## $P ##~## if (Number(r.renewWindow) < window) refuse ##~## if (false) refuse"
  "src/lease-signing-policy.mjs ##~## $P ##~## if (budget > BigInt(r.maxPerOpWei)) refuse ##~## if (false) refuse"
  "src/lease-signing-policy.mjs ##~## $P ##~## deadline: BigInt(c.head.timestamp + window) ##~## deadline: BigInt(c.head.timestamp + window * 10)"
  "src/forced-inclusion.mjs ##~## test/finality.test.mjs ##~## if (!L1_VERIFIERS.includes(l1Evidence.verifiedBy)) refuse ##~## if (false) refuse"
  "src/forced-inclusion.mjs ##~## test/finality.test.mjs ##~## if (l2Evidence.finalized === true && l1Final) level ##~## if (l2Evidence.finalized === true) level"
)
fails=0; i=0
for m in "${M[@]}"; do
  i=$((i+1))
  if [ -n "${ONLY:-}" ] && ! echo " $ONLY " | grep -q " $i "; then continue; fi   # ONLY="16 17": run just those
  D="$C/tmp/cmut-$i"; rm -rf "$D"; mkdir -p "$D"; cp -r src test "$D/"; ln -s "$C/fixtures" "$D/fixtures"; ln -s "$C/evidence" "$D/evidence"; ln -s "$C/node_modules" "$D/node_modules"; cp package.json "$D/"
  python3 - "$D" "$m" <<'PY'
import sys
d, m = sys.argv[1:]; src, tests, a, b = m.split(' ##~## ')
p = d + '/' + src; s = open(p).read(); n = s.count(a); assert n == 1, (n, a); open(p, 'w').write(s.replace(a, b))
open(d + '/.tests', 'w').write(tests)
PY
  [ -s "$D/.tests" ] || { echo "MUTANT $i NOT APPLIED"; fails=$((fails+1)); rm -rf "$D"; continue; }
  T=$(cat "$D/.tests"); from=$(echo "$m" | awk -F' ##~## ' '{print $3}')
  (cd "$D" && timeout -k 5 240 unshare -rn sh -c 'ip link set lo up; node --test --test-concurrency=1 "$@"' sh $T > "$C/logs/cmut-$i.tap" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo "MUTANT $i SURVIVED: $from"; fails=$((fails+1)); else echo "mutant $i killed ($(grep -c '^not ok' "$C/logs/cmut-$i.tap") failing): $from"; fi
  rm -rf "$D"
done
echo "survivors: $fails of $i"; exit $fails
