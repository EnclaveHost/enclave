#!/usr/bin/env bash
# ONE queued job (Rust: 1024 MiB). The canonical site-host package:
#   1. input validation: the locked CAR accepted; the superseded release, a truncated CAR and a wrong release dir refused;
#   2. reproducible build: the canonical tree (CAR-only input) and a copy at another path (release-dir input) must
#      give the identical wasm;
#   3. runtime compatibility of THAT wasm, end to end (test/e2e.mjs), under each deployed engine:
#        fleet 49.0.0 (wasm manager flags); deployed Windows/m3 guest 48.0.1 (2026-10-01 domexec flags);
#        current-main m3 domexec flags on the 49.0.0 guest runtime; Pulley interpreter (Android approximation).
set -euo pipefail
cd "$(dirname "$0")"
W="$PWD"
FROZEN=/home/steven/Documents/Codex/2026-10-18/wo/work/private-browser-final-release/release
REL="$FROZEN/bafybeiex25avvxryg6vzw7d57npdliy5qtfuss3c5lrbk5i5o7tx4kzgdi"
OLD="$FROZEN/bafybeiffe3o277okkrsw6m5ia4vs5czs2hk456hakbqarderzjih2mfa6q"
A="$W/enclave-apps/site-host"
export CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=4

echo "== 1. input validation"
neg() { local what="$1"; shift; if node "$A/scripts/embed-release.mjs" "$@" --out "$W/neg-out" > "$W/neg.log" 2>&1; then echo "ACCEPTED $what"; exit 1; fi; echo "refused $what: $(grep -m1 -o 'Error: .*' "$W/neg.log")"; }
neg "the superseded release's CAR" --car "$OLD/site.car"
head -c 1000000 "$REL/site.car" > "$W/truncated.car"; neg "a truncated CAR" --car "$W/truncated.car"; rm -f "$W/truncated.car"
neg "the superseded release dir" --release "$OLD"
test ! -e "$W/neg-out/site.car"

echo "== 2a. build A: canonical tree, CAR-only input"
(cd "$A" && scripts/build.sh --car "$REL/site.car")
echo "== 2b. build B: a copy at another path, release-dir input"
rm -rf "$W/repro" && mkdir -p "$W/repro"
rsync -a --exclude target --exclude dist --exclude release/site.car --exclude release/release.json "$A/" "$W/repro/site-host/"
(cd "$W/repro/site-host" && scripts/build.sh --release "$REL")
a=$(sha256sum "$A/dist/site_host.wasm" | cut -c1-64); b=$(sha256sum "$W/repro/site-host/dist/site_host.wasm" | cut -c1-64)
echo "wasm A $a"; echo "wasm B $b"
test "$a" = "$b"
cmp "$A/dist/SOURCE.sha256" "$W/repro/site-host/dist/SOURCE.sha256"
echo "REPRODUCIBLE $a"

echo "== 3. runtime compatibility of $a"
cd "$A"
echo "-- 3a. fleet engine 49.0.0 (shared CVM, wasm manager flags)"
WASMTIME="$W/engines/fleet-49.0.0-manager.sh" scripts/test.sh "$REL"
echo "-- 3b. deployed Windows/m3 guest runtime 48.0.1, 2026-10-01 domexec flags"
DOMEXEC_BIN=/home/steven/Documents/Codex/2026-10-01/i-x20/work/cid-runtime-root/plat/rt/wasmtime DOMEXEC_FEATURES= \
  WASMTIME="$W/engines/domexec.sh" scripts/test.sh "$REL"
echo "-- 3c. current-main m3 domexec flags on the 49.0.0 guest runtime"
DOMEXEC_BIN=/home/steven/Documents/Codex/2026-10-01/co/work/public-web/release/template/rt/wasmtime \
  DOMEXEC_FEATURES=threads,shared-everything-threads,component-model-threading,shared-memory,memory64,component-model-memory64 \
  WASMTIME="$W/engines/domexec.sh" scripts/test.sh "$REL"
echo "-- 3d. Pulley interpreter (Android pVM approximation)"
# an approximation only (another wasmtime, x86 host): its outcome is reported, never allowed to mask 3a-3c
if WASMTIME="$W/engines/pulley-49.0.3.sh" scripts/test.sh "$REL"; then echo "PULLEY-APPROX-OK"; else echo "PULLEY-APPROX-FAILED rc=$?"; fi
echo "PACKAGE-JOB-OK $a"
