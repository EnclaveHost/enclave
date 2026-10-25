#!/usr/bin/env bash
# p4 (queue 1024): DEPENDENCY-ORDERED regeneration of the committed bundles at $C, from BOTH clones' exports, to a FIXED POINT.
# Order: host-admission (+host-policy) -> lease-gas-conduit -> relay network-runtime (generated) -> platform-api -> mcp
# (mcp embeds windows/node/host-admission.bundle.mjs; platform-api embeds the conduit and the network-runtime bundle).
# Pass 2 must change nothing; every builder --check must pass; A == B; then a binary patch vs $C (throwaway worktree).
set -uo pipefail
. "$(dirname "$0")/env.sh"
FILES="windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs.manifest.json
metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json metal/guest/mcp-server.bundle.mjs metal/guest/mcp-server.bundle.mjs.manifest.json"
regen() {
  node scripts/build-host-admission.mjs && node scripts/build-metal-lease-gas.mjs && node relay/build-network.mjs relay/network-runtime.bundle.mjs >/dev/null \
    && node scripts/build-platform-api-guest-bundle.mjs >/dev/null && node scripts/build-mcp-guest-bundle.mjs >/dev/null
}
for side in a b; do
  src=$SA; [ $side = b ] && src=$SB
  X=$B/tmp/fix-$C-$side; [ ! -e "$X" ] || { echo "$X exists"; exit 2; }
  mkdir -p "$X"; git -C "$src" archive "$C" | tar -x -C "$X"
  ln -s "$W/control-source/node_modules" "$X/node_modules"
  ln -s /home/steven/Documents/Codex/2026-10-18/wo/work/app-lease-gas/control-cv-main/relay/node_modules "$X/relay/node_modules"
  ln -s /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/network/node_modules "$X/network/node_modules"
  ( cd "$X" && regen ) > "$B/tmp/fix-$C-$side.pass1.out" 2>&1 || { echo "[$side] pass 1 FAILED"; tail -5 "$B/tmp/fix-$C-$side.pass1.out"; exit 4; }
  ( cd "$X" && sha256sum $FILES relay/network-runtime.bundle.mjs ) > "$B/tmp/fix-$C-$side.pass1.sha"
  ( cd "$X" && regen ) > "$B/tmp/fix-$C-$side.pass2.out" 2>&1 || { echo "[$side] pass 2 FAILED"; exit 4; }
  ( cd "$X" && sha256sum $FILES relay/network-runtime.bundle.mjs ) > "$B/tmp/fix-$C-$side.pass2.sha"
  cmp -s "$B/tmp/fix-$C-$side.pass1.sha" "$B/tmp/fix-$C-$side.pass2.sha" && echo "[$side] FIXED POINT: pass 2 == pass 1" || { echo "[$side] NOT a fixed point"; diff "$B/tmp/fix-$C-$side.pass1.sha" "$B/tmp/fix-$C-$side.pass2.sha"; exit 5; }
  ( cd "$X" && node scripts/build-host-admission.mjs --check && node scripts/build-metal-lease-gas.mjs --check >/dev/null && node scripts/build-platform-api-guest-bundle.mjs --check >/dev/null && node scripts/build-mcp-guest-bundle.mjs --check >/dev/null ) \
    && echo "[$side] every builder --check passes" || { echo "[$side] a builder --check REFUSES"; exit 6; }
done
cmp -s "$B/tmp/fix-$C-a.pass2.sha" "$B/tmp/fix-$C-b.pass2.sha" && echo "[determinism] clone A export == clone B export" || { echo "[determinism] A != B"; diff "$B/tmp/fix-$C-a.pass2.sha" "$B/tmp/fix-$C-b.pass2.sha"; exit 7; }
cat "$B/tmp/fix-$C-a.pass2.sha"
for f in $FILES; do cmp -s "$B/tmp/fix-$C-a/$f" <(git -C "$SA" cat-file blob "$C:$f") && echo "[vs $C] $f: unchanged" || echo "[vs $C] $f: CHANGES"; done
WT=$B/tmp/patch-wt-$C; git -C "$SA" worktree add -q --detach "$WT" "$C"
for f in $FILES; do cp "$B/tmp/fix-$C-a/$f" "$WT/$f"; done
git -C "$WT" diff --binary "$C" > "$B/receipts/$C-fixpoint.patch"
git -C "$WT" diff --stat "$C" | tail -6
git -C "$SA" worktree remove --force "$WT"; git -C "$SA" worktree prune
need "clone A clean, no worktree" [ -z "$(git -C "$SA" status --porcelain --untracked-files=all)" -a "$(git -C "$SA" worktree list | wc -l)" = 1 ]
git -C "$SB" apply --check "$B/receipts/$C-fixpoint.patch" && echo "[patch] applies cleanly on $C (checked on clone B)"
need "clone B clean" [ -z "$(git -C "$SB" status --porcelain --untracked-files=all)" ]
sha256sum "$B/receipts/$C-fixpoint.patch"
stub_none
echo P4-DONE
