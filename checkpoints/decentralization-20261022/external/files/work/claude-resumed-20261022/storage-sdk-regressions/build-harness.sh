#!/bin/bash
# ROOT-SCHEDULED offline compile; NOT run by its author. One shared-queue job at 1024 MiB, one go build at a time:
#   python3 work/claude-test-queue.py --mib 1024 --log <log> -- work/claude-resumed-20261022/storage-sdk-regressions/build-harness.sh
# Builds the real-interop harness (harness-src/cmd/harness-block) against EACH accepted enclave snapshot.
# The harness compiles indexd in through `replace go.sia.tech/indexd => <tree>`, so a harness built from another tree
# is no evidence for these snapshots. Each variant is built twice, from independent empty GOCACHEs:
#   c2e  go.c2e.mod -> storage-funding-test-fix/snapshots/c2-enclave     out/c2e-{a,b}/harness-block
#   fe   go.fe.mod  -> storage-funding-test-fix/snapshots/fence-enclave  out/fe-{a,b}/harness-block
# The two builds must be byte-identical.
# Recipe:
#   - offline: GOPROXY=off, GOTOOLCHAIN=local, GOFLAGS=-mod=readonly, inside `unshare -rn` (no network namespace);
#   - CGO_ENABLED=0 for a static binary. This is the one difference from the old CGO=1 harness: the runner's container is
#     Debian 13, and every address the harness uses is a loopback literal, so no resolver behaviour changes;
#   - GOMAXPROCS=2, GOMEMLIMIT=600MiB, taskset -c 0-1, -p 1, -trimpath, -buildvcs=false.
# The harness source pins and both snapshot inventories are verified before and after the builds.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
cd "$S"
sha256sum -c --quiet harness-src.sha256 || { echo "check failed: harness-src pins"; exit 1; }
echo "harness-src pins ok (byte-identical to indexd-c2-implementation/harness)"
python3 -B "$S/snapshot_check.py" || { echo "check failed: accepted snapshot inventories"; exit 1; }
echo "accepted snapshot inventories ok (before)"
[ ! -e out ] || { echo "refusing: out/ exists"; exit 1; }
mkdir out
for k in c2e fe; do
  for l in a b; do
    c=$(mktemp -d "$S/.gocache-$k-$l.XXXX"); mkdir -p "out/$k-$l"
    start=$(date +%s)
    ( cd harness-src && env GOCACHE="$c" GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=readonly CGO_ENABLED=0 GOMAXPROCS=2 GOMEMLIMIT=600MiB \
        unshare -rn taskset -c 0-1 go build -p 1 -trimpath -buildvcs=false -modfile "go.$k.mod" -o "../out/$k-$l/harness-block" ./cmd/harness-block )
    echo "$k-$l: $(sha256sum "out/$k-$l/harness-block" | cut -d' ' -f1) in $(( $(date +%s) - start ))s, GOCACHE $(du -sm "$c" | cut -f1) MiB"
    rm -rf "$c"
  done
  cmp "out/$k-a/harness-block" "out/$k-b/harness-block" || { echo "$k: NOT reproducible"; exit 1; }
  echo "$k: REPRODUCIBLE (two empty-cache builds byte-identical)"
  GOTOOLCHAIN=local go version -m "out/$k-a/harness-block" > "out/$k.buildinfo.txt"
  grep -A1 -E "^\s+dep\s+go.sia.tech/indexd\s" "out/$k.buildinfo.txt"
  grep -q "CGO_ENABLED=0" "out/$k.buildinfo.txt" || { echo "$k: not CGO_ENABLED=0"; exit 1; }
  file -b "out/$k-a/harness-block" | grep -q "statically linked" || { echo "$k: not statically linked"; exit 1; }
  echo "$k: static"
done
sha256sum -c --quiet harness-src.sha256 || { echo "check failed: harness-src pins"; exit 1; }
echo "harness-src pins ok (after; go.mod/go.sum untouched)"
python3 -B "$S/snapshot_check.py" || { echo "check failed: accepted snapshot inventories"; exit 1; }
echo "accepted snapshot inventories ok (after)"
(cd out && sha256sum */harness-block *.buildinfo.txt) | tee out/SHA256SUMS
echo "NEXT (root): put out/c2e-a and out/fe-a harness-block hashes into config.json harnesses.*.sha256, then run sdk_regression_runner.py"
