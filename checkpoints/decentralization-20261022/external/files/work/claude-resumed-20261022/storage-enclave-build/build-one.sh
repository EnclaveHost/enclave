#!/bin/bash
# storage-enclave-build A1 step 3: ONE deterministic build of one assembled tree, through the shared queue at 1024 MiB:
#   build-one.sh <fence-enclave|c2-enclave> <a|b>
# Uses the pinned recipe work/indexd-c2-implementation/package/release/build.sh (76c14465) UNCHANGED, with a NEW empty GOCACHE.
# The only addition is GOTOOLCHAIN=local, so a toolchain download is impossible (the local go1.27.2 satisfies go 1.27.0).
# The full tree inventory (incl. go.mod/go.sum) must be byte-identical before and after.
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd); W=$(cd "$B/../.." && pwd); n=$1 l=$2
R=$W/indexd-c2-implementation/package/release/build.sh
[ "$(sha256sum "$R" | cut -d' ' -f1)" = 76c14465ce256e7f80bc838dda41694b6540bd85e84783295349b4df1f965ecd ] || { echo "recipe pin differs"; exit 1; }
t=$B/trees/$n; inv=$B/inventory/$n.sha256
(cd "$t" && sha256sum -c --quiet "$inv") && echo "$n inventory unchanged before build ($(wc -l < "$inv") files)"
[ "$(find "$t" -type f | wc -l)" = "$(wc -l < "$inv")" ] || { echo "file count differs before build"; exit 1; }
cache=$B/gocache/$n-$l; out=$B/out/$n-$l/indexd
[ ! -e "$cache" ] && [ ! -e "$out" ] || { echo "refusing: $cache or $out exists"; exit 1; }
mkdir -p "$cache" "$(dirname "$out")"; [ -z "$(ls -A "$cache")" ] && echo "GOCACHE $cache is new and empty"
start=$(date +%s)
GOTOOLCHAIN=local "$R" "$t" "$out" "$cache"
echo "build seconds: $(( $(date +%s) - start ))"
(cd "$t" && sha256sum -c --quiet "$inv") && echo "$n inventory unchanged after build (go.mod/go.sum included)"
[ "$(find "$t" -type f | wc -l)" = "$(wc -l < "$inv")" ] || { echo "file count changed by the build"; exit 1; }
echo "GOCACHE used: $(du -sm "$cache" | cut -f1) MiB"; rm -rf "$cache"
GOTOOLCHAIN=local go version -m "$out" > "$B/out/$n-$l/buildinfo.txt"; cat "$B/out/$n-$l/buildinfo.txt"
ls -l "$out"
