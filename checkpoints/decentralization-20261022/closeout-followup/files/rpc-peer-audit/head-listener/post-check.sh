#!/bin/bash
# Offline object re-verification (correct + wrong signer) and RPC corroboration for the last live run.
set -uo pipefail
cd "$(dirname "$0")"
RUN=$(cat runs/live.last)
BIN=target/debug/enclave-base-head-listener
SIGNER=0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a
ok=0; bad=0
for f in "$RUN"/out/objects/*.v4.snappy; do
  if timeout 20 "$BIN" verify-object --signer "$SIGNER" --file "$f" > /dev/null; then ok=$((ok+1)); else bad=$((bad+1)); fi
done
echo "verify-object pinned signer: ok=$ok failed=$bad"
first=$(ls "$RUN"/out/objects/*.v4.snappy | head -1)
timeout 20 "$BIN" verify-object --signer "$SIGNER" --file "$first"; echo "rc=$?"
timeout 20 "$BIN" verify-object --signer 0x0000000000000000000000000000000000000001 --file "$first"; echo "wrong-signer rc=$?"
timeout -k 5 120 python3 -I tools/crosscheck.py "$RUN/heads.jsonl" https://mainnet.base.org 10 > "$RUN/crosscheck.json"; echo "crosscheck rc=$?"
python3 -I -c "import json;d=json.load(open('$RUN/crosscheck.json'));print('crosscheck allMatch',d['allMatch'],'checked',d['checked'])"
