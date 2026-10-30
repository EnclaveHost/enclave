#!/bin/bash
# r3 SITE BUILD SMOKE (ROOT runs it, separately from root-r3.sh; Claude did not). Private clones ONLY; outputs stay in them.
#   R3=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r3
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2048 --log $R3/logs/root-r3-build.guard -- unshare -rn bash $R3/jobs/root-r3-build.sh
# scripts/build-site.mjs rm -rf's ROOT/site/dist (ROOT = the clone) BEFORE parsing arguments, compiles contracts with the
# local solc-js (build-contract-artifacts.mjs, rewrites contracts/*.abi.json and site artifacts in the clone) and runs the
# local tailwind CLI via npx (node_modules/.bin): no network is needed; if anything tries, it fails inside unshare -rn
# and is reported, never installed. Negative builds run FIRST (they clear dist), then legacy and own-rpc builds.
# The own-rpc build uses ONLY fixtures/own-rpc.authority.json (placeholder *.own-node.example; never a production authority).
set -uo pipefail
R3=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r3; R2=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r2; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source; REV=bf77da364373a9c7d881489af5b760207a03997c; NM=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules; FIX=$R3/fixtures/own-rpc.authority.json; FIXSHA=ed5175f72ef18e38ff2354a6e2738d7ef58406779e10aa8818ac9360925266c2
ip link set lo up 2>/dev/null || { echo "## HARNESS: cannot bring up lo"; exit 2; }
(cd "$R3" && sha256sum -c --quiet MANIFEST.sha256) && (cd "$R2" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: pinned inputs changed"; exit 2; }
[ "$(sha256sum "$FIX" | cut -c1-64)" = "$FIXSHA" ] || { echo "## HARNESS: fixture changed"; exit 2; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ); WK=$R3/build-work-$STAMP; OUT=$R3/logs/root-r3-build-$STAMP
[ ! -e "$WK" ] && mkdir -p "$WK" "$OUT" || { echo "## HARNESS: work dir"; exit 2; }
clone() { git clone -q --no-local --no-checkout "$R" "$1" && git -C "$1" checkout -q --detach "$REV" && [ "$(git -C "$1" rev-parse HEAD)" = "$REV" ] && ln -s "$NM" "$1/node_modules"; }
clone "$WK/build-legacy" && clone "$WK/build-own" || { echo "## HARNESS: clones"; exit 2; }
python3 -I -c 'import json,shutil,sys;r2,dst=sys.argv[1:];p=json.load(open(r2+"/jobs/tree-pins.json"))
for f in list(p["overlaid"])+list(p["added"]): shutil.copyfile(r2+"/src/"+f, dst+"/"+f)' "$R2" "$WK/build-own" || { echo "## HARNESS: overlay"; exit 2; }
rc=0
neg() { local label=$1 want=$2; shift 2; (cd "$WK/build-own" && timeout 1800 node scripts/build-site.mjs "$@") > "$OUT/$label.out" 2>&1; local r=$?
  if [ $r != 0 ] && grep -q -- "$want" "$OUT/$label.out"; then echo "## $label: refused as expected (rc $r)"; else echo "## $label: NOT refused as expected (rc $r)"; rc=1; fi; }
neg neg-wrong-digest "not the reviewed" --read-authority "$FIX" --read-authority-digest sha256:0000000000000000000000000000000000000000000000000000000000000000
neg neg-digest-missing "go together" --read-authority "$FIX"
echo "## legacy build (no flags)"; (cd "$WK/build-legacy" && timeout 3600 node scripts/build-site.mjs) > "$OUT/build-legacy.out" 2>&1; b1=$?; tail -3 "$OUT/build-legacy.out"
echo "## own-rpc build (fixture)"; (cd "$WK/build-own" && timeout 3600 node scripts/build-site.mjs --read-authority "$FIX" --read-authority-digest "sha256:$FIXSHA") > "$OUT/build-own.out" 2>&1; b2=$?; tail -3 "$OUT/build-own.out"
[ $b1 = 0 ] && [ $b2 = 0 ] || { echo "## BUILD FAILED legacy rc $b1, own rc $b2 (missing dependency or network need: see logs; nothing is installed)"; rc=1; }
grep -q "release read authority own-rpc sha256:$FIXSHA" "$OUT/build-own.out" || { echo "## own build did not log the reviewed authority"; rc=1; }
python3 -I "$R3/jobs/check_build_smoke.py" "$WK/build-legacy" "$WK/build-own" "$OUT/build-smoke.json" || rc=1
echo "## logs: $OUT (dist + clones stay in $WK, private)"; echo "## aggregate rc=$rc"
exit $rc
