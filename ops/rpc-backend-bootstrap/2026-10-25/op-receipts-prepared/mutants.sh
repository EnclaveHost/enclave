#!/bin/sh
# Each mutant changes ONE rule in a private copy of op-receipts-root.mjs; the unchanged tests must FAIL.
cd "$(dirname "$0")"
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:?set ANCHOR_DEPS_ROOT to a checkout with node_modules (see test/deps.mjs)}"
ip link set lo up 2>/dev/null || true
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
copy() { rm -rf "$T/s"; mkdir -p "$T/s"; cp -r op-receipts-root.mjs vendor test "$T/s/"; }
copy; (cd "$T/s" && node --test test/op-receipts-root.test.mjs >/dev/null 2>&1) || { echo "BASELINE FAILED: mutants invalid"; exit 2; }
echo "baseline passes"
rc=0
m() {
  copy
  python3 - "$T/s/op-receipts-root.mjs" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read(); assert s.count(a)==1, a; open(p,'w').write(s.replace(a,b))
PY
  (cd "$T/s" && node --test test/op-receipts-root.test.mjs >/dev/null 2>&1) && { echo "SURVIVED $1"; rc=1; } || echo "killed $1"
}
m regolith-strip 'if (r.depositNonce !== undefined && !stripDepositNonce) fields.push(r.depositNonce);' 'if (r.depositNonce !== undefined) fields.push(r.depositNonce);'
m header-hash 'if (headerHash(header, keccak) !== blockHash) fail' 'if (false) fail'
m root-compare 'if (root !== lc(header.receiptsRoot)) fail' 'if (false) fail'
m drop-deposit-nonce 'if (r.depositNonce !== undefined && !stripDepositNonce) fields.push(r.depositNonce);' 'if (false) fields.push(r.depositNonce);'
m inline-threshold 'const ref = (enc) => enc.length < 32 ? { raw: enc } : keccak(enc);' 'const ref = (enc) => enc.length <= 32 ? { raw: enc } : keccak(enc);'
m tx-index-order 'if (qty(r.transactionIndex, `${what}.transactionIndex`) !== BigInt(i)) fail' 'if (false) fail'
m receipt-bloom 'if (r.logsBloom !== undefined && toHex(logsBloom(logs, keccak)) !== lc(r.logsBloom)) fail' 'if (false) fail'
m deposit-version 'if (canyon && (!hasVer || qty(r.depositReceiptVersion, `${what}.depositReceiptVersion`) !== 1n)) fail' 'if (false) fail'
m gas-total 'if ((receipts.length ? cum : 0n) !== gasUsed) fail' 'if (false) fail'
m status-encoding 'const fields = [r.status ? Uint8Array.of(1) : new Uint8Array(0),' 'const fields = [r.status ? Uint8Array.of(1) : Uint8Array.of(0),'
m brand-check 'if (!VERIFIED.has(v)) fail' 'if (false) fail'
m tx-unbound 'if (v.txHashBinding !== "verified-body") fail' 'if (false) fail'
m safe-integer 'if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail' 'if (false) fail'
m resource-bound 'if (receipts.length > maxReceipts) fail' 'if (false) fail'
echo "## mutants rc=$rc"; exit $rc
