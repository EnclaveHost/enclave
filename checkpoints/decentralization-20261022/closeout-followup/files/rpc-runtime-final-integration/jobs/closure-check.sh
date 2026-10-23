#!/bin/bash
# Verify the runtime's native input closure without compiling (repo/scripts/rpc-runtime/build-binaries.sh check):
# Rust 1.96.0 installed, base/base tarball sha256, exact git trees (Helios ef320298, listener 5e178676), the listener's
# generated manifest, both Cargo.locks unchanged and resolvable --locked --offline from the lock-derived cargo homes.
set -euo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022; F=$B/rpc-runtime-final-integration
rm -rf $F/closure/check-work
export LISTENER_CARGO_HOME=$F/closure/cargo-home-listener
exec unshare -r -n bash -c 'ip link set lo up; '"$F"'/repo/scripts/rpc-runtime/build-binaries.sh '"$F"'/closure/check-work '"$B"'/witness-failover/helios '"$B"'/rpc-gossip-bridge/listener '"$F"'/closure/src/base-5476069f.tar.gz '"$F"'/closure/cargo-home-helios check all'
