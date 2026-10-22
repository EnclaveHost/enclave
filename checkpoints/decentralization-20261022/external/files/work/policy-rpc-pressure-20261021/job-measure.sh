#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/policy-rpc-pressure-20261021
export ADMISSION_MODULE=$PWD/../cron-startup-20261021/release-source/deployed/windows/node/host-admission.bundle.mjs
export LEASE_READER_MODULE=$PWD/../enclave/network/lease-reader.mjs
sha256sum $ADMISSION_MODULE $LEASE_READER_MODULE measure.test.mjs | cut -c1-8,65-
date -u +%FT%TZ
for s in 3 5; do RPCSET=$s node --test --test-reporter=tap measure.test.mjs > measure-rpc$s.tap 2>&1; echo "rpc$s rc=$?"; done
date -u +%FT%TZ
