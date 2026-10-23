#!/bin/bash
# credit-vault submitter tests 1: config unit, the suites that touch cli/credit-vault.mjs createRelay/chainFor and the role
# (legacy runner test against the rebuilt package), then the real-chain packaged-role E2E (reth --dev + Helios + anvil L1 +
# E's labelled beacon/rollup). One line per suite; exit nonzero if ANY failed; FAILED= lists them.
set -u
W=/home/steven/Documents/Codex/2026-10-18/wo/work/credit-vault-submitter-verifier-20261023
R=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
BIN=$R/helios-target-base/debug/helios RETH=$R/vendor-inspect/reth-v2.8.0/bin/reth
echo "cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0  $BIN" | sha256sum -c - || exit 4
echo "8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250  $RETH" | sha256sum -c - || exit 4
mkdir -p $W/test-scratch $W/jobs/t1-logs; cd $W/repo
unshare -r -n bash -c '
  ip link set lo up; export TEST_TMP='"$W"'/test-scratch; L='"$W"'/jobs/t1-logs; failed=""
  for f in credit-vault-submitter-config receipt-source credit-vault-submitter-runner credit-vault-reserve credit-vault-relay-concurrency credit-vault-independent; do
    timeout -k 10 900 node --test --test-force-exit --test-concurrency=1 test/$f.test.mjs > $L/$f.log 2>&1; rc=$?
    echo "$f rc=$rc $(grep -E "^# (pass|fail|cancelled|skipped) " $L/$f.log | tr "\n" " ")"; [ $rc -eq 0 ] || failed="$failed $f"
  done
  export RIG_CHAIN_NODE=reth RIG_RETH_BIN='"$RETH"' RIG_RETH_GENESIS='"$R"'/fixture-tools/reth-dev-8453-genesis.json RIG_RETH_BLOCK_TIME=2s HELIOS_BASE_BIN='"$BIN"'
  f=credit-vault-submitter-verifier.e2e
  timeout -k 10 2400 node --test --test-force-exit --test-concurrency=1 test/$f.test.mjs > $L/$f.log 2>&1; rc=$?
  grep -E "^(not )?ok " $L/$f.log; echo "$f rc=$rc $(grep -E "^# (pass|fail|cancelled|skipped) " $L/$f.log | tr "\n" " ")"; [ $rc -eq 0 ] || failed="$failed $f"
  for x in $failed; do echo "--- $x"; grep -A40 "^ *not ok" $L/$x.log | grep -E "error|expected|actual|code:|test.mjs:|Error" | head -30; done
  echo "FAILED=${failed:-none}"; [ -z "$failed" ]
'
