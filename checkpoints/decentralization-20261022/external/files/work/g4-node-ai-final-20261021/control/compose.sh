#!/usr/bin/env bash
# Compose the minipc CONTROL change set on the exact LIVE baselines (probe out-20261021T212012Z: every target hash read live).
# old/ = the live bytes (local copies whose sha equals the live file); new/ = the candidate bytes. Nothing remote.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/node-hold-package-20261021; O=$P/control/old; N=$P/control/new; R=$W/node-cold-policy-20261021/revision2
rm -rf $O $N; mkdir -p $O $N
pin(){ [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || { echo "PIN MISMATCH $1 (want $2)"; exit 1; }; }
PATCH=$R/host-integration/patch-node.py; pin $PATCH 887e7b443c2fa068bf031ff45dd31aad9e5f80cd9ca19d2cf831dd95742d3732
# live baselines
cp $W/cron-startup-20261021/release-source/deployed/windows/node/host.mjs $O/host.mjs;                      pin $O/host.mjs c4629529903ee87edd258fb5b1964525bcf29b3a1109d9f0c30e74b06d05cfd0
cp $W/offchain-heartbeat/base/layer0/windows/node/agent.mjs $O/agent.mjs;                                    pin $O/agent.mjs c223c0435d859f0bde0d496a2eb1e8a2db4af44a47e32bf653710244c5ccd2ba
cp $W/enclave/windows/node/appzone.mjs $O/appzone.mjs;                                                       pin $O/appzone.mjs ba9d9bb13f2ea19cdcbdcdbc021ddbabbd201618ff1e834b733cc220fc8c26c6
cp $W/cron-startup-20261021/release-source/deployed/windows/node/host-admission.bundle.mjs $O/host-admission.bundle.mjs; pin $O/host-admission.bundle.mjs 66c6e15a793b8dc4cb80f209b6ffa405c40c7d235284727384e4833576610067
cp $W/enclavedns-upload-502-20261021/retry-timing/fix/base/hvcert.mjs $O/hvcert.mjs; pin $O/hvcert.mjs 91b9f2db7eb3be98efec1594dfe95245475a0cf234d9ce6843657b37bc2b1557
E=$(python3 -c "import json;print(json.load(open('$P/probe/live-control-map.json'))['found']['windows\\\\node\\\\network-enroll.mjs'])"); cp "$E" $O/network-enroll.mjs
# candidates
for f in agent appzone; do cp $O/$f.mjs $N/$f.mjs; done
cp $W/host-service-tls-20261021/compose5/windows/node/network-enroll.mjs $N/network-enroll.mjs; pin $N/network-enroll.mjs ab947363f5fda0bc2ffd52ce6a77ae75cf0886a8c8f035e512298c9224e95f9d
python3 $PATCH $N agent appzone enroll
# host.mjs: ROOT's accepted D1 integration (revision2/tree-live: live c4629529 + patch-node.py + 7d's single hold() call)
cp $R/tree-live/windows/node/host.mjs $N/host.mjs; pin $N/host.mjs 0c82e9ba3fe9919435b9876168132db2fb63614920b9a90f0efbeb5f23ffc6e7
cp $R/bundle-build/out/candidate.host-admission.bundle.mjs $N/host-admission.bundle.mjs; pin $N/host-admission.bundle.mjs 6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18   # live sources + decision(); 0 DO mirrors
cp $W/enclave/windows/node/hvcert.mjs $N/hvcert.mjs; pin $N/hvcert.mjs 3a87d9b897765fc8bc42a2648f310f8ad504022798534603bce9b0fdafe0d9d5
cp $R/tree-live/network/wallet-admission.mjs $N/wallet-admission.mjs; pin $N/wallet-admission.mjs 0fa7678f7586388b4725f1432683fa4ab172fd1d57c163d9a63195fbb2f445ee   # ROOT's accepted D1 writer (the ONLY retry layer)
cp $W/host-service-tls-20261021/compose5/network/host-service-names.mjs $N/host-service-names.mjs
cp $W/host-service-tls-20261021/compose5/network/host-service-transport.mjs $N/host-service-transport.mjs
cd $P/control; sha256sum old/* new/* | tee SHA256SUMS.txt
cd $P/control; sha256sum old/* new/* > SHA256SUMS.txt; cat SHA256SUMS.txt
