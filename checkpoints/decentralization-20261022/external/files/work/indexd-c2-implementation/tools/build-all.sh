#!/bin/bash
# G-C2 builds, inside ONE shared-queue allocation (768 MiB):
#   python3 work/claude-test-queue.py --mib 768 --log logs/build.guard.log -- tools/build-all.sh
# 1+2. the candidate release binary twice, each from an EMPTY Go build cache, with the unchanged rollout recipe
#      (package/release/build.sh == indexd-replica-rollout/release/build.sh 76c14465...): the two must be identical;
# 3.   the fixture client (package/fixture/c2client) against src;
# 4.   the real-interop harness (bin/harness-c2): the byte-identical harness copy built with go.c2.mod (replace -> src).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=$here/package/release/indexd-v0.6.0-fence.2-c2-linux-amd64
tmp=$(mktemp -d "$here/.build.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
"$here/package/release/build.sh" "$here/src" "$tmp/a" "$tmp/cache-a"
"$here/package/release/build.sh" "$here/src" "$tmp/b" "$tmp/cache-b"
cmp "$tmp/a" "$tmp/b"
echo "REPRODUCIBLE: two empty-cache builds are byte-identical"
cp "$tmp/a" "$out"
cd "$here/package/release" && sha256sum "$(basename "$out")" > SHA256SUMS && cat SHA256SUMS
export GOPROXY=off GOFLAGS=-mod=mod GOMEMLIMIT=600MiB GOMAXPROCS=2
cd "$here/package/fixture/client"
CGO_ENABLED=0 taskset -c 0-1 go build -p 1 -trimpath -o ../c2client .
sha256sum ../c2client
mkdir -p "$here/bin"
cd "$here/harness"
taskset -c 0-1 go build -p 1 -modfile go.c2.mod -o "$here/bin/harness-c2" ./cmd/harness-block
sha256sum "$here/bin/harness-c2"
