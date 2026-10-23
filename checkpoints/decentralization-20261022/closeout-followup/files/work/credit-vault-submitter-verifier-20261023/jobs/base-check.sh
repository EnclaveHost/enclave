#!/bin/bash
# baseline at eab4cfac4 (no edits yet): rebuild all host-service packages in this workspace, list which tracked package files
# change (= stale at base), then restore them. Exit = the build's.
set -u
W=/home/steven/Documents/Codex/2026-10-18/wo/work/credit-vault-submitter-verifier-20261023
cd $W/base
git diff --quiet -- network/host-services/packages || { echo "workspace packages already modified; refusing"; exit 3; }
node relay/build-network.mjs relay/network-runtime.bundle.mjs > /dev/null || { echo "network-runtime bundle failed"; exit 4; }
node scripts/build-host-service-packages.mjs; rc=$?
echo "RC[build]=$rc"; echo "CHANGED AT BASE:"; git status --short -- network/host-services/packages
git checkout -- network/host-services/packages && echo restored
exit $rc
