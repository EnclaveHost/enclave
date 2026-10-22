#!/bin/bash
# ROOT ONLY, NOT RUN BY CLAUDE. ONE offline, deterministic build of ONE rehearsal helper, through the shared queue (Go = 1024 MiB):
#   python3 work/claude-test-queue.py --mib 1024 --log <unique>.log -- work/claude-resumed-20261022/storage-enclave-rehearsal/tools/build-tools.sh <tool> <a|b>
#   tool: rehearsaltool-v27 (-> trees/fence-enclave) | c2tool | c2rclient (-> trees/c2-enclave). Run each tool twice (a, b), sequentially.
# Flags: storage-enclave-build A1's recipe (CGO off, GOPROXY=off, GOTOOLCHAIN=local, -p 1, GOMAXPROCS=2, GOMEMLIMIT=600MiB,
# taskset 0-1, -trimpath -buildvcs=false -ldflags '-s -w -buildid='), but -mod=readonly (never rewrites go.mod/go.sum),
# a NEW empty GOCACHE per build, and the existing module cache only.
# Checks:
# - the assembled tree's inventory and the tool's source files are verified before and after the build;
# - go vet runs first, as the original build.sh did.
# Output: tools/out/<tool>-<a|b>/<tool> + buildinfo.txt.
# Then root compares a with b (cmp) and writes that sha256 into tools/pins.json.
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); C=$(cd "$P/.." && pwd); t=${1:?tool} l=${2:?a|b}
case "$t" in rehearsaltool-v27) tree=fence-enclave ;; c2tool|c2rclient) tree=c2-enclave ;; *) echo "unknown tool"; exit 2 ;; esac
case "$l" in a|b) ;; *) echo "a or b"; exit 2 ;; esac
src=$P/tools/src/$t; T=$C/storage-enclave-build/trees/$tree; inv=$C/storage-enclave-build/inventory/$tree.sha256
declare -A INV=([fence-enclave]=d306f997a60105a17d06aea4f824a2d3134ab962936467a403b789de620b72df [c2-enclave]=2e8faf801e088db41abba57935f0a290940ea3ed13cb6d122efdfe0d39ba9f5e)
[ "$(sha256sum "$inv" | cut -d' ' -f1)" = "${INV[$tree]}" ] || { echo "inventory pin differs"; exit 1; }
[ "$(sha256sum /usr/lib/go/bin/go | cut -d' ' -f1)" = dc36303d0ab49f23ae5922d1468bb73c5a093bbec4e598888155b0dc99e0161d ] || { echo "go toolchain pin differs"; exit 1; }
check() { (cd "$T" && sha256sum -c --quiet "$inv") && [ "$(find "$T" -type f | wc -l)" = "$(wc -l < "$inv")" ] && (cd "$P" && sha256sum -c --quiet tools/SOURCES.sha256); }
check && echo "tree + tool sources verified before the build"
cache=$P/tools/gocache-$t-$l; out=$P/tools/out/$t-$l
[ ! -e "$cache" ] && [ ! -e "$out" ] || { echo "refusing: $cache or $out exists"; exit 1; }
mkdir -p "$cache" "$out"
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local GOMEMLIMIT=600MiB GOMAXPROCS=2 GOCACHE=$cache GOENV=off
cd "$src"
taskset -c 0-1 go vet .
taskset -c 0-1 go build -p 1 -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o "$out/$t" .
cd "$P"; check && echo "tree + tool sources unchanged after the build"
echo "GOCACHE used: $(du -sm "$cache" | cut -f1) MiB"; rm -rf "$cache"
go version -m "$out/$t" > "$out/buildinfo.txt"; sha256sum "$out/$t"
