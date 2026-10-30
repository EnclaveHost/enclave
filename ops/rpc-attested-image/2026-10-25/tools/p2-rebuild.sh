#!/usr/bin/env bash
# p2 (queue 1024): source parity of every committed bundle the --control direct image installs. A git-archive export of the
# commit (never the clones), its node_modules roots linked read-only to installs whose files equal the bundles' recorded
# node_modules inputs (p2-nm-match.py), each builder run at the commit; committed vs rebuilt bytes + manifests compared.
set -uo pipefail
. "$(dirname "$0")/env.sh"
C=${1:-$C}; LBL=${2:-e0}
X=$B/tmp/export-$LBL; [ ! -e "$X" ] || { echo "$X exists"; exit 2; }
mkdir -p "$X"; git -C "$SA" archive "$C" | tar -x -C "$X"
ln -s "$W/control-source/node_modules" "$X/node_modules"
ln -s /home/steven/Documents/Codex/2026-10-18/wo/work/app-lease-gas/control-cv-main/relay/node_modules "$X/relay/node_modules"
ln -s /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/network/node_modules "$X/network/node_modules"
python3 -I "$B/tools/p2-nm-match.py" "$SA" "$C" node_modules "$X/node_modules"
python3 -I "$B/tools/p2-nm-match.py" "$SA" "$C" relay/node_modules "$X/relay/node_modules" | grep -v 'recorded 0 '
FILES="metal/guest/lease-gas-conduit.bundle.mjs metal/guest/host-policy.bundle.mjs windows/node/host-admission.bundle.mjs metal/guest/platform-api.bundle.mjs metal/guest/mcp-server.bundle.mjs"
for f in $FILES; do cp "$X/$f" "$B/tmp/committed-$LBL.$(basename $f)"; [ -f "$X/$f.manifest.json" ] && cp "$X/$f.manifest.json" "$B/tmp/committed-$LBL.$(basename $f).manifest.json"; done
cd "$X"
echo "== the generated relay runtime bundle first (an input of the platform API bundle, never committed)"
node relay/build-network.mjs relay/network-runtime.bundle.mjs || echo "[build] relay network-runtime bundle FAILED"
echo "== builders at $C"
node scripts/build-host-admission.mjs --check && echo "[check] host-admission + host-policy: committed bytes == rebuilt (builder --check)" || echo "[check] host-admission/host-policy: STALE per builder --check"
node scripts/build-metal-lease-gas.mjs --check && echo "[check] lease-gas-conduit --check passed" || echo "[check] lease-gas-conduit --check REFUSED (stale)"
node scripts/build-platform-api-guest-bundle.mjs --check && echo "[check] platform-api --check passed" || echo "[check] platform-api --check REFUSED (stale)"
node scripts/build-mcp-guest-bundle.mjs --check && echo "[check] mcp --check passed" || echo "[check] mcp --check REFUSED (stale)"
echo "== rebuild in the export, compare bytes"
for bld in build-metal-lease-gas build-platform-api-guest-bundle build-mcp-guest-bundle build-host-admission; do node scripts/$bld.mjs > "$B/tmp/build-$LBL-$bld.out" 2>&1 && echo "[build] $bld ok" || { echo "[build] $bld FAILED:"; grep -E "ERROR|error|Could not" "$B/tmp/build-$LBL-$bld.out" | head -5; }; done
for f in $FILES; do b=$(basename $f)
  if cmp -s "$B/tmp/committed-$LBL.$b" "$X/$f"; then echo "[bytes] $f: rebuilt == committed ($(sha256sum < "$X/$f" | cut -c1-16))"; else echo "[bytes] $f: DIFFERS committed $(sha256sum < "$B/tmp/committed-$LBL.$b" | cut -c1-16) rebuilt $(sha256sum < "$X/$f" | cut -c1-16)"; fi
  if [ -f "$X/$f.manifest.json" ]; then cmp -s "$B/tmp/committed-$LBL.$b.manifest.json" "$X/$f.manifest.json" && echo "[manifest] $f: identical" || { echo "[manifest] $f: DIFFERS"; diff <(python3 -c "import json,sys;print('\n'.join(f'{k} {v}' for k,v in sorted(json.load(open(sys.argv[1]))['inputs'].items())))" "$B/tmp/committed-$LBL.$b.manifest.json") <(python3 -c "import json,sys;print('\n'.join(f'{k} {v}' for k,v in sorted(json.load(open(sys.argv[1]))['inputs'].items())))" "$X/$f.manifest.json") | grep '^[<>]' | cut -c1-140 || true; }; fi
done
mkdir -p "$B/receipts/p2-rebuilt-$LBL"; for f in $FILES; do cp "$X/$f" "$B/receipts/p2-rebuilt-$LBL/"; [ -f "$X/$f.manifest.json" ] && cp "$X/$f.manifest.json" "$B/receipts/p2-rebuilt-$LBL/"; done
stub_none
echo P2-DONE
