#!/bin/bash
# Mutation controls: each mutant removes one guard of src/forced-inclusion.mjs in a scratch copy; the suite must FAIL.
set -u
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C" || exit 2
M=(
  "if (lower(signer) !== lower(operator)) refuse('bad-signature'|if (false) refuse('bad-signature'"
  "if (u(s.executorNonce, 'executorNonce') !== l.nonce) refuse|if (false) refuse"
  "if (code !== '0x' \&\& !(size(code) === 23|if (false \&\& !(size(code) === 23"
  "if (source.submittedVia \&\& source.submittedVia === source.endpoint) refuse|if (false) refuse"
  "acceptableFrom: \[getAddress(from)\] }|acceptableFrom: [getAddress(from), applyL1ToL2Alias(from)] }"
  "if ((s.operatorCode || '0x').toLowerCase() !== designator) refuse|if (false) refuse"
  "if (paid.length !== 1 ||| if (false \&\& paid.length !== 1 ||"
  "if (e \&\& e.commitment === commitment) return { replay: true, entry: e };|if (false) return { replay: true, entry: e };"
  "if (e.l1Nonce !== undefined \&\& String(e.l1Nonce) !== String(l1Nonce)) refuse|if (false) refuse"
  "if (l1Receipt?.status !== 'reverted' |||if (false \&\& l1Receipt?.status !== 'reverted' ||"
)
fails=0; i=0
for m in "${M[@]}"; do
  i=$((i+1)); from=${m%%|*}; to=${m#*|}
  D="$C/tmp/mut-$i"; rm -rf "$D"; mkdir -p "$D"; cp -r src test "$D/"; ln -s "$C/fixtures" "$D/fixtures"; ln -s "$C/evidence" "$D/evidence"; ln -s "$C/node_modules" "$D/node_modules"; cp package.json "$D/"
  python3 - "$D/src/forced-inclusion.mjs" "$from" "$to" <<'PY'
import sys,re
p,a,b=sys.argv[1:]; s=open(p).read(); a=a.replace('\\&','&'); b=b.replace('\\&','&')
pat=re.escape(a).replace('\\[','[').replace('\\]',']') if False else None
a2=a.replace('\\[','[').replace('\\]',']'); b2=b.replace('\\[','[').replace('\\]',']')
n=s.count(a2); assert n==1, (n,a2); open(p,'w').write(s.replace(a2,b2))
PY
  (cd "$D" && timeout -k 5 200 unshare -rn sh -c 'ip link set lo up; node --test --test-concurrency=1 test/forced-inclusion.anvil.test.mjs test/tracker.test.mjs' > "$C/logs/mut-$i.tap" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo "MUTANT $i SURVIVED: $from"; fails=$((fails+1)); else echo "mutant $i killed ($(grep -c '^not ok' "$C/logs/mut-$i.tap") failing): $from"; fi
  rm -rf "$D"
done
echo "survivors: $fails of $i"; exit $fails
