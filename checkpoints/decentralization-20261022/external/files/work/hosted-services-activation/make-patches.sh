#!/bin/bash
# Main-relative patch of the source this work adds or changes (the archive is built from tree/ = main + this patch).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation; M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
cd "$H"; rm -rf patches; mkdir patches
FILES=(network/host-services/runner.mjs network/host-services/stage-tool.mjs network/host-services/entries/stage-tool.mjs test/hosted-services-stage.test.mjs)
: > patches/01-runner-endpoint-and-stage-tool.patch
for f in "${FILES[@]}"; do a=/dev/null; [ -e "$M/$f" ] && a="$M/$f"
  diff -u --label "a/$f" --label "b/$f" "$a" "tree/$f" >> patches/01-runner-endpoint-and-stage-tool.patch || [ $? -eq 1 ]; done
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for f in "${FILES[@]}"; do [ -e "$M/$f" ] && { mkdir -p "$T/$(dirname "$f")"; cp "$M/$f" "$T/$f"; }; done
(cd "$T" && patch -p1 -s < "$H/patches/01-runner-endpoint-and-stage-tool.patch")
for f in "${FILES[@]}"; do cmp -s "$T/$f" "tree/$f" || { echo "patch result differs: $f"; exit 1; }; done
(cd tree && sha256sum "${FILES[@]}") > patches/FILES.sha256
sha256sum patches/01-runner-endpoint-and-stage-tool.patch >> patches/FILES.sha256
echo "patch applies to main and reproduces tree/: ${#FILES[@]} files"
