#!/bin/bash
cd "$(dirname "$0")/.."
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
python3 -I -c "import sys;open(sys.argv[2],'wb').write(bytes.fromhex(open(sys.argv[1]).read().strip()))" test/fixtures/base-mainnet-52965074.v4.snappy.hex $d/o.v4.snappy
echo "--- real"; artifacts/enclave-base-head-listener commitment --signer 0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a --file $d/o.v4.snappy | head -c 300; echo; echo "rc=${PIPESTATUS[0]}"
echo "--- fake"; REAL_LISTENER=$PWD/artifacts/enclave-base-head-listener FAKE_PLAN='{}' test/fixtures/fake-listener.mjs commitment --signer 0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a --file $d/o.v4.snappy > $d/out; echo "rc=$?"; wc -c $d/out; head -c 200 $d/out; echo; tail -c 100 $d/out | od -c | tail -3
