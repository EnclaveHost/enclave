#!/usr/bin/env bash
N=$(cd "$(dirname "$0")" && pwd)
echo "== basetree (UNPATCHED live $(sha256sum $N/basetree/windows/node/host.mjs | cut -c1-8)): the cold-start test must FAIL its keep cases"
cd $N/basetree && node --test test/windows-node-wallet-cold-start.test.mjs 2>&1 | grep -E "^(not )?ok|^# (pass|fail)" | head -20
