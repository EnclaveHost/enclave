#!/bin/sh
# Negative fixtures for N3b's proof chain.
#
# N3b passes when the adversary's report is AUTHENTIC (VCEK to the pinned ARK, TCB meeting the floor), names B,
# and is still refused when judged with B's measurement. A pass like that is only worth something if the same
# check REFUSES a report that is not authentic - otherwise "rejected as B" could mean "rejected because it was
# nonsense", which is what the first version of judge-adv.mjs could not tell apart.
#
# So each fixture is the real report with one thing broken, and every one must fail the chain.
#
# usage: adv-report-fixtures.sh <workdir> <B-measurement> <B-appid> <ADV-measurement> <product>
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:?usage: adv-report-fixtures.sh <workdir> <measB> <idB> <measADV> <product>}
measB=$2; idB=$3; measADV=$4; product=$5
chain=$here/../../test/fixtures/amd/$product-cert_chain.pem
[ -r "$W/adv.report.b64" ] || { echo "no adversary report in $W: nothing to test"; exit 1; }
S=$W/advfix; rm -rf "$S"; mkdir -p "$S"
fails=0; n=0

judge() { node "$here/judge-adv.mjs" "$1" "$measB" "$idB" "$measADV" \
  "$W/vcek.der" "$W/min-tcb.json" "$W/B.spki.b64" "$W/adv.nonce" "$chain" "$product" 2>&1; }

# want=pass means the chain must be satisfied (only the genuine report may do that)
run() {
  want=$1; desc=$2; file=$3
  n=$((n + 1))
  out=$(judge "$file" || true)
  if printf '%s' "$out" | grep -q 'AUTHENTICATED-AND-REJECTED-AS-B'; then got=pass; else got=refuse; fi
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-6s  %s\n' "$got" "$desc"
  else
    printf 'FAIL  %-6s (wanted %s)  %s\n      -> %s\n' "$got" "$want" "$desc" \
      "$(printf '%s' "$out" | grep -aE '^(FAIL step|PROOF-CHAIN|ACCEPTED)' | head -2 | tr '\n' ' ')"
    fails=$((fails + 1))
  fi
}

# the genuine article: the only input allowed to satisfy the chain
cp "$W/adv.report.b64" "$S/genuine.b64"
run pass "the genuine adversary report satisfies the chain" "$S/genuine.b64"

mut() { # mut <name> <python-expr mutating bytearray b>
  python3 - "$W/adv.report.b64" "$S/$1.b64" "$2" <<'PY'
import base64, sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
b = bytearray(base64.b64decode(open(src).read().strip()))
exec(expr)
open(dst, 'w').write(base64.b64encode(bytes(b)).decode())
PY
}

# 1. the signature: flip a byte in it. Everything else is the real report.
mut badsig 'b[0x2A0] ^= 0xff'
run refuse "one byte flipped in the signature" "$S/badsig.b64"

# 2. the measurement rewritten to B's, which is the forgery the whole test is about
mut fakemeas "b[0x90:0xC0] = bytes.fromhex('$measB')"
run refuse "measurement rewritten to B's (the forgery N3b exists to catch)" "$S/fakemeas.b64"

# 3. report_data tampered after signing
mut badrd 'b[0x50] ^= 0xff'
run refuse "report_data altered after signing" "$S/badrd.b64"

# 4. a wholly fabricated report of the right length
mut fabricated 'b[:] = bytearray(len(b))'
run refuse "an all-zero report of the right length" "$S/fabricated.b64"

# 5. truncated
mut truncated 'del b[0x200:]'
run refuse "a truncated report" "$S/truncated.b64"

# 6. the TCB in the report lowered below the floor
mut lowtcb 'b[0x180] = 0'
run refuse "the reported TCB lowered" "$S/lowtcb.b64"

printf '\n'
if [ "$fails" -eq 0 ]; then
  echo "adv report fixtures: ALL $n PASS (only the genuine report satisfies the chain)"
else
  echo "adv report fixtures: $fails of $n FAILED"
  exit 1
fi
