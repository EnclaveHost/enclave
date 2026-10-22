#!/usr/bin/env bash
# Builds the candidate tree for the pinned host-local relay change (nothing here writes to main):
#   tree/      a real copy of CURRENT main (work/enclave, working tree), real copies of its installed node_modules,
#              contracts/foundry/out linked read-only; then the CAS overlay of src/ (each modified file only where main still
#              has the base recorded in BASE.txt; new files only where absent); then, INSIDE the tree only, the two generated
#              bundles whose source changed (windows/node/lease-gas-runtime.bundle.mjs, metal/guest/lease-gas-conduit.bundle.mjs)
#   pristine/  the same copy before the overlay (git apply --check target)
# Run through the shared queue (it runs esbuild):  python3 ../claude-test-queue.py --mib 256 --log logs/tree.guard.log -- bash make-tree.sh
set -euo pipefail
cd "$(dirname "$0")"; H=$PWD; E=$(cd ../enclave && pwd)
rm -rf "$H/tree" "$H/pristine"; mkdir -p "$H/tree"
rsync -a --exclude=node_modules --exclude=.git --exclude=contracts/foundry/out --exclude=contracts/foundry/cache --exclude=/cache "$E/" "$H/tree/"
for d in . relay network windows/node e2e sdk/sessions; do [ -d "$E/$d/node_modules" ] && cp -a "$E/$d/node_modules" "$H/tree/$d/node_modules"; done
ln -s "$E/contracts/foundry/out" "$H/tree/contracts/foundry/out"
{ date -Is; git -C "$E" rev-parse HEAD; } > "$H/MAIN-SNAPSHOT.txt"
rsync -a --exclude=node_modules "$H/tree/" "$H/pristine/"
MOD="client/lease-executor-client.mjs network/lease-gas-runtime.mjs network/lease-gas-conduit.mjs windows/installer/lease-gas-config-check.mjs"
NEW="test/lease-pinned-relay-config.test.mjs test/lease-pinned-relay.test.mjs test/fixtures/pinned-relay/absent-golden.json test/fixtures/pinned-relay/golden-compute.mjs"
: > "$H/overlay.report"
for f in $MOD; do
  base=$(grep -E "  $f$" "$H/BASE.txt" | cut -c1-64); now=$(sha256sum "$H/tree/$f" | cut -c1-64)
  if [ "$base" != "$now" ]; then echo "BASE-CHANGED $f (base $base, main now $now): NOT overlaid" >> "$H/overlay.report"; exit 3; fi
  cp "$H/src/$f" "$H/tree/$f"; echo "patched $f $base -> $(sha256sum "$H/src/$f" | cut -c1-64)" >> "$H/overlay.report"
done
for f in $NEW; do
  [ -e "$H/tree/$f" ] && { echo "EXISTS $f: NOT overwritten" >> "$H/overlay.report"; exit 3; }
  mkdir -p "$(dirname "$H/tree/$f")"; cp "$H/src/$f" "$H/tree/$f"; echo "added $f $(sha256sum "$H/src/$f" | cut -c1-64)" >> "$H/overlay.report"
done
# the generated bundles, in the TREE only (root rebuilds them once at composition)
( cd "$H/tree" && node scripts/build-windows-lease-runtime.mjs && node scripts/build-metal-lease-gas.mjs && node scripts/build-windows-lease-runtime.mjs --check && node scripts/build-metal-lease-gas.mjs --check )
for f in windows/node/lease-gas-runtime.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs; do
  echo "rebuilt-in-tree $f $(sha256sum "$E/$f" | cut -c1-64) -> $(sha256sum "$H/tree/$f" | cut -c1-64)" >> "$H/overlay.report"; done
# the exact source patch (generated bundles excluded: they are rebuilt by root), checked against the pristine copy
( cd "$H" && for f in $MOD $NEW; do diff -u --label "a/$f" --label "b/$f" "$( [ -e pristine/$f ] && echo pristine/$f || echo /dev/null )" "tree/$f" || true; done ) > "$H/pinned-relay.patch"
cp -r "$H/pristine" "$H/apply-check"; ( cd "$H/apply-check" && git init -q . && git apply --check "$H/pinned-relay.patch" && echo "git apply --check: OK" >> "$H/overlay.report" ); rm -rf "$H/apply-check"
sha256sum "$H/pinned-relay.patch" >> "$H/overlay.report"
cat "$H/overlay.report"
