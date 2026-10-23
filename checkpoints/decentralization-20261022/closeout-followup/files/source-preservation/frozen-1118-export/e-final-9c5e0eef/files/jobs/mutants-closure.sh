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
  "src/forced-inclusion.mjs ##~## test/source-binding.anvil.test.mjs ##~## if (!isMinted(ev) || ev.kind !== kind) refuse(code ##~## if (false) refuse(code"
  "src/lease-signing-policy.mjs ##~## $P ##~## if (forced !== undefined) refuse ##~## if (false) refuse"
  "src/lease-signing-policy.mjs ##~## $P ##~## if (Number(r.renewWindow) < window) refuse ##~## if (false) refuse"
  "src/lease-signing-policy.mjs ##~## $P ##~## if (budget > BigInt(r.maxPerOpWei)) refuse ##~## if (false) refuse"
  "src/lease-signing-policy.mjs ##~## $P ##~## deadline: BigInt(c.head.timestamp + window) ##~## deadline: BigInt(c.head.timestamp + window * 10)"
  "src/forced-inclusion.mjs ##~## test/finality.test.mjs ##~## acceptEvidence(l1Evidence, 'l1-receipt', { acceptTrust }, 'l1-evidence-unverified'); ##~## "
  "src/forced-inclusion.mjs ##~## test/source-binding.anvil.test.mjs ##~## if (l2Evidence.finalized === true && l1Final) level ##~## if (l2Evidence.finalized === true) level"
  "src/forced-inclusion.mjs ##~## test/forced-inclusion.anvil.test.mjs ##~## if (!Array.isArray(verifiers) || !verifiers.every((v) => /^test-/.test(String(v)))) refuse ##~## if (false) refuse"
  "src/forced-inclusion.mjs ##~## test/source-binding.anvil.test.mjs ##~## if (!acceptTrust.includes(ev.trust)) refuse ##~## if (false) refuse"
  "src/forced-inclusion.mjs ##~## test/source-binding.anvil.test.mjs ##~## if (l1Receipt !== undefined && l1Receipt !== l1Proof.receipt) refuse ##~## if (false) refuse"
  "src/l1-source-binding.mjs ##~## test/source-binding.anvil.test.mjs ##~## need(fin && fin.hash === clFin.hash ##~## need(true"
  "src/l1-source-binding.mjs ##~## test/source-binding.test.mjs ##~## if (canon?.hash !== raw.blockHash) refuse('l1-not-canonical' ##~## if (false) refuse('l1-not-canonical'"
  "src/base-source-binding.mjs ##~## test/source-binding.anvil.test.mjs ##~## need(cur.canonical, ##~## need(true,"
  "src/l1-source-binding.mjs ##~## test/source-binding.anvil.test.mjs ##~## if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) refuse('not-local' ##~## if (false) refuse('not-local'"
  "src/l1-source-binding.mjs ##~## test/source-binding.anvil.test.mjs ##~## need(d.is_syncing === false && d.is_optimistic === false && d.el_offline === false ##~## need(true"
  "src/l1-source-binding.mjs ##~## test/source-binding.test.mjs ##~## if (!(block.transactions ?? []).map ##~## if (false && !(block.transactions ?? []).map"
  "src/evidence-brand.mjs ##~## test/evidence-immutability.test.mjs ##~## const owned = deepFreeze(structuredClone(obj)); ##~## const owned = deepFreeze(obj);"
  "src/evidence-brand.mjs ##~## test/evidence-immutability.test.mjs ##~## for (const k of Reflect.ownKeys(v)) deepFreeze(v[k]); ##~## "
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
