#!/bin/sh
# Each mutant disables ONE check in a private copy of a1-anchor.mjs; the unchanged tests must FAIL (exit != 0).
cd "$(dirname "$0")"
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:?set ANCHOR_DEPS_ROOT to a checkout with node_modules (see test/deps.mjs)}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ip link set lo up 2>/dev/null || true   # inside unshare -rn loopback starts down
rc=0
m() {
  name=$1; from=$2; to=$3
  rm -rf "$T/s"; mkdir -p "$T/s"; cp -r a1-anchor.mjs a1-read.mjs vendor test "$T/s/"
  python3 - "$T/s" "$from" "$to" <<'PY'
import sys
d,a,b=sys.argv[1:]
hits=[f for f in ("a1-anchor.mjs","a1-read.mjs") if open(f"{d}/{f}").read().count(a)==1]
assert len(hits)==1, a
p=f"{d}/{hits[0]}"; s=open(p).read(); open(p,'w').write(s.replace(a,b))
PY
  (cd "$T/s" && node --test test/a1-anchor.test.mjs >/dev/null 2>&1); r=$?
  if [ $r = 0 ]; then echo "SURVIVED $name"; rc=1; else echo "killed $name"; fi
}
# baseline: the UNMUTATED copy must pass, or no kill below means anything
rm -rf "$T/s"; mkdir -p "$T/s"; cp -r a1-anchor.mjs a1-read.mjs vendor test "$T/s/"
(cd "$T/s" && node --test test/a1-anchor.test.mjs >/dev/null 2>&1) || { echo "BASELINE FAILED: mutants invalid"; exit 2; }
echo "baseline passes"
m proof-hash 'if (!eq(keccak(raw), want.hash))' 'if (false)'
m proof-extra 'if (i !== proofHex.length) fail("proof_extra"' 'if (false) fail("proof_extra"'
m game-finalized 'if (!need("isGameFinalized"))' 'if (false)'
m header-hash 'if (!hdr || headerHash(hdr, keccak) !== at.blockHash)' 'if (!hdr)'
m asr-binding 'if (asrFromPortal !== cfg.asr)' 'if (false)'
m proof-slots 'if (got.length !== slots.length || got.some((k, i) => k !== slots[i]))' 'if (false)'
m json-fields 'if (qty(r.nonce) !== acct.nonce || qty(r.balance) !== acct.balance' 'if (false && qty(r.balance) !== acct.balance'
m stale-age 'if (t - ts > cfg.maxFinalizedAgeSec)' 'if (false)'
m future-skew 'if (ts > t + MAX_FUTURE_SKEW_SEC)' 'if (false)'
m fin-number 'if (Number(qty(fin.number)) !== number)' 'if (false)'
m read-byte-cap 'if (n > maxBytes) { try' 'if (false) { try'
m read-http-status 'if (!r.ok) { try' 'if (false) { try'
echo "## mutants rc=$rc"; exit $rc
