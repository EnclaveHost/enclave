#!/usr/bin/env bash
# the live-baseline candidate (host c4629529 / agent c223c043 / appzone ba9d9bb1 / enroll ab947363 + patch, bundle 6bef372d)
cd "$(dirname "$0")/tree-live" && sha256sum windows/node/{host,agent,appzone,network-enroll,host-admission.bundle}.mjs network/wallet-admission.mjs | cut -c1-8,65- && \
timeout 420 node --test --test-concurrency=1 test/windows-node-wallet-network-hold.test.mjs test/windows-node-appzone-wallet-hold.test.mjs \
  test/windows-node-wallet-enroll.test.mjs test/windows-node-network-enroll.test.mjs test/windows-node-wallet-policy.test.mjs \
  test/windows-node-tick-single-flight.test.mjs test/windows-node-appzone-abort.test.mjs test/windows-node-appzone-tls.test.mjs 2>&1
