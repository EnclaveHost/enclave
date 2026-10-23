#!/bin/bash
# Test runner (always launched through work/claude-test-queue.py via jobs/q.sh). Offline: unshare -rn (loopback only).
#   unit     l1pair unit tests (no client binary)
#   reth     REAL reth v2.8.0 (mainnet, empty datadir) under the launcher: loopback RPC, Base L1 methods, engine JWT, gate
#   base     REAL Base v1.5.1 (S's staged binary, read-only) via S's committed launcher against the REAL reth + a labelled
#            beacon stand-in
#   mutants  launcher mutants, each must be killed by the unit tests
set -u
NS='unshare -rn /bin/sh -c "ip link set lo up && exec \"\$0\" \"\$@\""'
cd "$(dirname "$0")/.." || exit 2
R=$PWD
echo "== pins"; sha256sum l1pair/l1pair.py l1pair/PINS.json l1pair/vendor/VENDOR.json l1pair/test/*.py
python3 -I - <<'PY' || exit 2
import hashlib, json
v = json.load(open('l1pair/vendor/VENDOR.json'))
for rel, sha in v['files'].items():
    assert hashlib.sha256(open('l1pair/vendor/' + rel, 'rb').read()).hexdigest() == sha, rel
print('vendor: OK (S composed 92b7178 byte-identical)')
PY
case "${1:-}" in
unit)    eval exec $NS python3 -u -I l1pair/test/test_l1pair.py ;;
reth)    echo "$(sha256sum bin/reth-v2.8.0)"; mkdir -p scratch
         eval exec $NS env RETH_BIN="$R/bin/reth-v2.8.0" SCRATCH="$R/scratch" python3 -u -I l1pair/test/test_reth_offline.py ;;
base)    B=../fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base; echo "$(sha256sum $B)"; mkdir -p scratch
         eval exec $NS env RETH_BIN="$R/bin/reth-v2.8.0" BASE_BIN="$(readlink -f $B)" SCRATCH="$R/scratch" python3 -u -I l1pair/test/test_base_l1_offline.py ;;
lighthouse) L=bin-staging/lighthouse-v8.3.2/lighthouse; echo "$(sha256sum bin/reth-v2.8.0)"; echo "$(sha256sum $L)"; mkdir -p scratch
         eval exec $NS env RETH_BIN="$R/bin/reth-v2.8.0" LH_BIN="$R/$L" SCRATCH="$R/scratch" python3 -u -I l1pair/test/test_lighthouse_offline.py ;;
txbroadcast) echo "$(sha256sum bin/reth-v2.8.0)"; mkdir -p scratch
         eval exec $NS env RETH_BIN="$R/bin/reth-v2.8.0" SCRATCH="$R/scratch" python3 -u -I l1pair/test/test_tx_broadcast_offline.py ;;
mutants) eval exec $NS python3 -u -I l1pair/test/mutate.py ;;
*) echo "usage: run.sh unit|reth|base|lighthouse|txbroadcast|mutants"; exit 64 ;;
esac
