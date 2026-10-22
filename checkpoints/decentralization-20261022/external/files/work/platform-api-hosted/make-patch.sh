#!/bin/bash
# The candidate as ONE patch for the root: the three shared files against their exact baseline (base/, equal to
# main at snapshot e762a9c5, re-checked below), plus every new file. Then `git apply --check` on a fresh copy of CURRENT
# main, and an inventory of every file with its sha256. Nothing here writes to main.
set -euo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/platform-api-hosted; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
MOD="metal/guest/measured-control.mjs metal/guest/gsup.mjs metal/build-image.mjs"
NEW="relay/state-replica.mjs metal/guest/platform-api-role.mjs metal/guest/platform-api-verify.mjs metal/guest/platform-api.bundle.mjs
 metal/guest/platform-api.bundle.mjs.manifest.json scripts/build-platform-api-guest-bundle.mjs scripts/platform-api-admin.mjs
 docs/network/hosted-platform-api.md test/platform-api-replica.test.mjs test/platform-api-config.test.mjs test/platform-api-registry.test.mjs
 test/platform-api-hosted.test.mjs"
P=$C/platform-api-hosted.patch; : > "$P"
for f in $MOD; do
  [ "$(sha256sum "$E/$f" | cut -c1-64)" = "$(sha256sum "$C/base/$f" | cut -c1-64)" ] || { echo "MAIN MOVED: $f (rebase needed, not overwritten)"; exit 3; }
  (cd "$C" && git diff --no-index --no-prefix -- "base/$f" "tree/$f" | sed -e "s#^--- base/#--- a/#" -e "s#^+++ tree/#+++ b/#" -e "s#^diff --git base/\([^ ]*\) tree/#diff --git a/\1 b/#") >> "$P" || true
done
for f in $NEW; do
  [ -e "$C/tree/$f" ] || { echo "MISSING new file $f"; exit 4; }
  [ -e "$E/$f" ] && { echo "EXISTS in main already: $f (not overwritten)"; exit 5; }
  (cd "$C/tree" && git diff --no-index -- /dev/null "$f" | sed -e "s#^+++ b/#+++ b/#") >> "$P" || true
done
# apply check on a scratch copy of the CURRENT main (no node_modules needed for an apply check)
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT
rsync -a --exclude=node_modules --exclude=.git --exclude=/cache --exclude=/shielded --exclude=/custody/dkg --exclude=contracts/foundry "$E/" "$S/"
(cd "$S" && git init -q && git apply --check "$P" && git apply "$P")
bad=0; for f in $MOD $NEW; do cmp -s "$S/$f" "$C/tree/$f" || { echo "APPLIED != candidate: $f"; bad=1; }; done
[ "$bad" = 0 ]
{ echo "platform-api-hosted.patch sha256 $(sha256sum "$P" | cut -c1-64); applies to CURRENT main $(git -C "$E" rev-parse HEAD) (+ working tree) and reproduces the candidate exactly"
  for f in $MOD; do echo "  modified $f  base $(sha256sum "$C/base/$f" | cut -c1-64)  new $(sha256sum "$C/tree/$f" | cut -c1-64)"; done
  for f in $NEW; do echo "  new      $f  $(sha256sum "$C/tree/$f" | cut -c1-64)"; done; } > "$C/PATCH-INVENTORY.txt"
cat "$C/PATCH-INVENTORY.txt"
