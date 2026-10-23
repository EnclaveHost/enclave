#!/usr/bin/env bash
# b2 (queue 768): bundle currency of the COMPOSED trial tree (tmp/compose: carriers + harness on fec43a6a, then root's admin-CLI
# commits 0eac0d60b/dfe020abf, A dfe020abf..71448f63, B 62feb3aa/8d110101, ROOT fd6a1762, all cherry-picked with -x).
#   1. every --check before any rebuild (which bundles the composition made stale)
#   2. rebuild ONLY the Linux image's own bundles, in the reviewed build order: host-admission (windows/node/host-admission.bundle.mjs
#      + metal/guest/host-policy.bundle.mjs), then the metal lease-gas conduit
#   3. every --check again; the rebuilt files are left in the working tree for review/commit (nothing is committed here)
# The relay network runtime (gitignored prerequisite), the platform API / MCP guest bundles, the Windows lease runtime and the
# host-service packages are NOT rebuilt: they are reported as the remaining build-input closure for the final composition.
set -uo pipefail
. "$(dirname "$0")/env.sh"
X=$B/tmp/compose; D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate
cd "$X" || exit 2
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "compose tree not clean"; exit 2; }
for d in . network relay; do [ -e "$d/node_modules" ] || ln -s "$D/$d/node_modules" "$d/node_modules"; done
for p in package.json package-lock.json network/package.json network/package-lock.json relay/package.json relay/package-lock.json; do
  cmp -s "$p" "$D/$p" || { echo "$p differs from the D candidate's installed tree"; exit 3; }
done
checks() {
  local tag=$1
  for s in "build-host-admission.mjs --check" "build-metal-lease-gas.mjs --check" "build-windows-lease-runtime.mjs --check" \
           "build-mcp-guest-bundle.mjs --check" "build-platform-api-guest-bundle.mjs --check" "build-host-service-packages.mjs --check"; do
    set +e; out=$(timeout -k 5 300 node scripts/$s 2>&1); rc=$?; set -e
    echo "[$tag] scripts/$s rc=$rc :: $(printf '%s' "$out" | tail -2 | tr '\n' ' ' | cut -c1-300)"
  done
}
set -e
echo "== 1 checks before"; checks before
echo "== 2 rebuild the Linux image's bundles"
node scripts/build-host-admission.mjs
node --check windows/node/host-admission.bundle.mjs; node --check metal/guest/host-policy.bundle.mjs
node scripts/build-metal-lease-gas.mjs
git status --porcelain --untracked-files=no
for f in windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs.manifest.json; do
  [ -f "$f" ] && echo "$(sha256sum < "$f" | cut -c1-64) $f"
done
echo "== 3 checks after"; checks after
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true);   # env.sh's own proof calls excluded
 [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
echo B2-DONE
