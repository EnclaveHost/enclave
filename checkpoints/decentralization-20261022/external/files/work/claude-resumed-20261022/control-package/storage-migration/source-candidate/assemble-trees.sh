#!/bin/bash
# ROOT (or a root-authorized Go worker). Assembles the two source trees that carry the LIVE indexd's enclave-small.patch
# (503e6fc9: minContractGrowthRate 8 GiB, serviceAccountFundTargetBytes 1 GiB, app API 5 min timeouts + IdleTimeout)
# on top of the TESTED fence and G-C2 sources. It copies and overlays files only; it builds nothing. Build afterwards with
# the existing deterministic recipe (Go: shared queue at 1024 MiB):
#   python3 work/claude-test-queue.py --mib 1024 --log <log> -- work/indexd-c2-implementation/package/release/build.sh <tree> <out>
#   assemble-trees.sh <out-dir>   -> <out-dir>/fence-enclave/ and <out-dir>/c2-enclave/
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); W=$(cd "$here/../../../.." && pwd); out=${1:?out dir}
[ ! -e "$out" ] || { echo "refusing: $out exists"; exit 1; }
# the tested sources, verified against their own manifests first
sha256sum -c --quiet <(cd "$here" && cat SOURCE-PINS.sha256 | sed "s#  #  $here/#")
mkdir -p "$out"
for pair in "fence-enclave:$W/indexd-replica-rollout/src:overlay-fence" "c2-enclave:$W/indexd-c2-implementation/src:overlay-c2"; do
  name=${pair%%:*}; rest=${pair#*:}; src=${rest%%:*}; ov=${rest#*:}
  cp -a "$src" "$out/$name"
  # the overlay replaces exactly 4 files; each base file must still be the stock/tested bytes the patch was made against
  for f in cmd/indexd/run.go contracts/form.go contracts/funding.go; do
    [ "$(sha256sum "$out/$name/$f" | cut -d' ' -f1)" = "$(sha256sum "$W/indexd/$f" | cut -d' ' -f1)" ] || { echo "$name/$f is not the stock v0.6.0 base"; exit 1; }
  done
  cp "$here/$ov/cmd/indexd/run.go" "$out/$name/cmd/indexd/run.go"
  cp "$here/$ov/contracts/form.go" "$here/$ov/contracts/funding.go" "$out/$name/contracts/"
  cp "$here/$ov/build/meta.go" "$out/$name/build/meta.go"
  echo "$name assembled: $(cd "$out/$name" && find . -type f -name '*.go' | sort | xargs sha256sum | sha256sum | cut -c1-16) (go-file tree digest)"
done
echo "NEXT (root): build both with release/build.sh through the queue at 1024 MiB, twice each from empty Go caches; record the shas;"
echo "then re-run the C2 fixture, go test ./contracts/... ./cmd/... and the production-copy rehearsal with the NEW pins."
