#!/bin/bash
# ONE final patch: the composed API + MCP sources relative to CURRENT main. Its base is pristine-main (main at the snapshot),
# re-checked against main NOW: a file main changed since is reported, never overwritten. Then `git apply --check` + apply
# on a fresh copy of current main, and the result must equal the composed tree byte for byte. Writes FINAL-INVENTORY.txt.
set -euo pipefail
F=/home/steven/Documents/Codex/2026-10-18/wo/work/control-hosted-final; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
SHARED="metal/guest/measured-control.mjs metal/guest/gsup.mjs metal/build-image.mjs"
MCP="docs/network/hosted-mcp.md docs/network/independent-mcp.md mcp/hosted-client.mjs mcp/hosted-connector.mjs mcp/independent-secrets.mjs mcp/independent-tools.mjs
 mcp/independent.mjs mcp/remote-secrets-client.mjs mcp/server.mjs metal/guest/mcp-server.bundle.mjs metal/guest/mcp-server.bundle.mjs.manifest.json relay/mcp.js
 scripts/build-mcp-guest-bundle.mjs test/helpers/mcp-independent-rig.mjs test/mcp-hosted-control.test.mjs test/mcp-independent-unit.test.mjs test/mcp-independent.test.mjs"
API="relay/state-replica.mjs metal/guest/platform-api-role.mjs metal/guest/platform-api-verify.mjs metal/guest/platform-api.bundle.mjs
 metal/guest/platform-api.bundle.mjs.manifest.json scripts/build-platform-api-guest-bundle.mjs scripts/platform-api-admin.mjs docs/network/hosted-platform-api.md
 test/platform-api-replica.test.mjs test/platform-api-config.test.mjs test/platform-api-registry.test.mjs test/platform-api-hosted.test.mjs"
ALL="$SHARED $MCP $API"
P=$F/control-hosted-final.patch; : > "$P"
for f in $ALL; do
  if [ -e "$F/pristine-main/$f" ]; then
    [ "$(sha256sum "$E/$f" | cut -c1-64)" = "$(sha256sum "$F/pristine-main/$f" | cut -c1-64)" ] || { echo "MAIN MOVED since the snapshot: $f (not overwritten)"; exit 3; }
    (cd "$F" && git diff --no-index --no-prefix -- "pristine-main/$f" "tree/$f" | sed -e "s#^--- pristine-main/#--- a/#" -e "s#^+++ tree/#+++ b/#" -e "s#^diff --git pristine-main/\([^ ]*\) tree/#diff --git a/\1 b/#") >> "$P" || true
  else
    [ -e "$E/$f" ] && { echo "EXISTS in main now: $f (not overwritten)"; exit 5; }
    (cd "$F/tree" && git diff --no-index -- /dev/null "$f") >> "$P" || true
  fi
done
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT
rsync -a --exclude=node_modules --exclude=.git --exclude=/cache --exclude=/custody/dkg/target --exclude=contracts/foundry "$E/" "$S/"
(cd "$S" && git apply --check "$P" 2>/dev/null && git apply "$P" 2>/dev/null)
bad=0; for f in $ALL; do cmp -s "$S/$f" "$F/tree/$f" || { echo "APPLIED != composed: $f"; bad=1; }; done; [ "$bad" = 0 ]
h() { sha256sum "$1" | cut -c1-64; }
{ echo "control-hosted-final.patch sha256 $(h "$P"); relative to CURRENT main $(git -C "$E" rev-parse HEAD) + its working tree (status sha256 $(git -C "$E" status --short | sha256sum | cut -c1-64)); git apply --check + apply reproduce the composed tree exactly"
  echo "ROOT-RESOLVED shared files (work/control-hosted-composition/merged; 13 conflicts: measured-control 9, gsup 2, build-image 2; plus root's HTTP and WebSocket TCP-identity fixes):"
  for f in $SHARED; do echo "  $f  main $(h "$F/pristine-main/$f")  composed $(h "$F/tree/$f")"; done
  echo "MCP parent (work/mcp-hosted-placement INVENTORY, patch 80b7cbaf…), byte-identical to the frozen parent:"
  for f in $MCP; do b=$([ -e "$F/pristine-main/$f" ] && h "$F/pristine-main/$f" || echo new); echo "  $f  main $b  composed $(h "$F/tree/$f")"; done
  echo "API parent (work/platform-api-hosted PATCH-INVENTORY, patch c33787dc…), byte-identical EXCEPT the API bundle and manifest, REBUILT against the composed measured-control.mjs:"
  for f in $API; do echo "  $f  new  composed $(h "$F/tree/$f")"; done; } > "$F/FINAL-INVENTORY.txt"
cat "$F/FINAL-INVENTORY.txt"
