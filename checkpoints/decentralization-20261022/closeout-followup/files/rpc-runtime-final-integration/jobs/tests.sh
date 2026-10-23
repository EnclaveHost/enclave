#!/bin/bash
# rpc-runtime-final-integration offline tests: <label> <test files...>. Inside `unshare -r -n` (lo up; asserts no
# external route). Every binary is checked against its pin first. BIN_DIR=bin-release selects the release listener.
set -euo pipefail
F=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-final-integration
label=$1; shift
(cd $F/bin && sha256sum -c --quiet PINS.sha256)
B=${BIN_DIR:-$F/bin}
(cd $B && sha256sum -c --quiet PINS.sha256)
echo "cc045d9d317d08dc6971e923b3939365acdfd58d5484c65afc1f5e450ee5b5af  $F/fixtures/reth-dev-8453-genesis.json" | sha256sum -c --quiet -
cd $F/repo
echo "== $(date -u +%FT%TZ) $label HEAD $(git rev-parse --short HEAD) dirty: $(git status --porcelain -- network test docs scripts | tr '\n' ' ')"
echo "binaries from $B: $(cd $B && sha256sum enclave-base-head-listener helios-eeffcc9 witness-check | cut -c1-12 | tr '\n' ' ')"
node --version; /usr/bin/flock --version; /usr/bin/minio --version 2>/dev/null | head -1
mkdir -p $F/test-scratch
export RUNTIME_BIN_DIR=$B RIG_CHAIN_NODE=reth RIG_RETH_BIN=$F/bin/reth-v2.8.0 RIG_RETH_GENESIS=${RIG_GENESIS:-$F/fixtures/reth-dev-8453-genesis.json} RIG_RETH_BLOCK_TIME=2s \
  HELIOS_BASE_BIN=$F/bin/helios-eeffcc9 HELIOS_BIN=$F/bin/helios-eeffcc9 HELIOS_COMPAT_BIN=$F/bin/helios-compat-0a02256 OPSTACK_SERVER_BIN=$F/bin/opstack-server-eeffcc9 \
  ANVIL_BIN=$(command -v anvil) MINIO_BIN=/usr/bin/minio WITNESS_CHECK_BIN=$B/witness-check REAL_LISTENER=$B/enclave-base-head-listener \
  BASE_HEADS_DIR=$F/fixtures/base-heads-b-live-20261023T013719Z BASE_FIXTURE_DIR=$F/fixtures/base-calls-20261023T014412Z B_LISTENER_FIXTURES=$F/fixtures/b-listener-fixtures \
  EXPECT_BASE_EXECUTION=1 BASE_DEFAULT_REFUSES=0 TEST_TMP=$F/test-scratch
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  timeout -k 10 3000 node --test --test-force-exit --test-concurrency=1 --test-timeout=900000 "$@"
' _ "$@"
