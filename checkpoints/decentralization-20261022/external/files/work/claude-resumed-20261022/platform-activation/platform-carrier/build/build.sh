#!/usr/bin/env bash
# platform-carrier bundle build (run ONLY through work/claude-test-queue.py, 512). Existing recipe (scripts/build-host-admission.mjs,
# esbuild 0.28.1, viem 2.53.1) on an ISOLATED copy of the bundle's source closure; no canonical or frozen file is edited.
#  1 PROVENANCE: the frozen lease-readiness tree's closure (host-admission-runtime cb42269d, host 9634cb40's tree) + the live
#    release's platform-host-policy-config.mjs (PRODUCTION_MIRRORS = [], 8ec507e0) must rebuild the INSTALLED bundle 6bef372d
#    and the metal host-policy bundle acfa1b00 byte for byte.
#  2 CANDIDATE: + src/network/host-service-gate-carriers.mjs and src/network/host-admission-node.mjs (new), and the build script's
#    WINDOWS entry -> host-admission-node.mjs; host-service-gate.mjs and the metal entry are unchanged (metal stays acfa1b00).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/claude-resumed-20261022/platform-activation/platform-carrier
SRC=$W/lease-readiness-20261022/tree; REL=$W/cron-startup-20261021/release-source/source
LIVE=6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18; METAL=acfa1b0099530d4c27fe451d7d3f1d124b3f7a213171557c1c2d926976e0dc3c
T=$P/build/tree; O=$P/out; rm -rf "$T"; mkdir -p "$T"/{custody/v2,relay,site,scripts,windows/node,metal/guest} "$O"
[ "$(sha256sum "$REL/network/platform-host-policy-config.mjs" | cut -c1-64)" = 8ec507e0a13d94ccd06824c7011dcc6d32bcecac1da10ea05951ca9ffd65bb74 ] || { echo "release config is not 8ec507e0"; exit 1; }
# the frozen tree is a SYMLINK FARM (into root-validation-tree / enclave): copy REFERENTS (-L) so nothing here can write through
rsync -aL --exclude node_modules "$SRC/network/" "$T/network/"
cp -L "$SRC"/custody/v2/*.mjs "$T/custody/v2/"; cp -L "$SRC"/relay/*.mjs "$T/relay/"; rsync -aL --exclude node_modules "$SRC/site/js" "$T/site/"
cp -L "$SRC/scripts/build-host-admission.mjs" "$T/scripts/"; cp -L "$SRC/package.json" "$T/" 2>/dev/null || true
ln -s "$(readlink -f "$W/enclave/node_modules")" "$T/node_modules"; ln -s "$(readlink -f "$W/enclave/network/node_modules")" "$T/network/node_modules"
links=$(find "$T" -type l | sort | tr "\n" " "); [ "$links" = "$T/network/node_modules $T/node_modules " ] || { echo "REFUSED: unexpected symlinks in the staged tree: $links"; exit 1; }
cp --remove-destination "$REL/network/platform-host-policy-config.mjs" "$T/network/platform-host-policy-config.mjs"
(cd "$T" && node scripts/build-host-admission.mjs)
a=$(sha256sum "$T/windows/node/host-admission.bundle.mjs" | cut -c1-64); m=$(sha256sum "$T/metal/guest/host-policy.bundle.mjs" | cut -c1-64)
echo "provenance: host-admission $a metal $m"
[ "$a" = "$LIVE" ] && [ "$m" = "$METAL" ] || { echo "PROVENANCE MISMATCH (expected $LIVE / $METAL)"; exit 1; }
cmp -s "$T/windows/node/host-admission.bundle.mjs" "$W/root-control-rpc-final-20261022/control-package/files/windows/node/host-admission.bundle.mjs" || { echo "rebuilt != the frozen package's installed bytes"; exit 1; }
echo "PROVENANCE OK (== installed 6bef372d, metal acfa1b00)"
cp "$T/windows/node/host-admission.bundle.mjs" "$O/live-rebuilt.host-admission.bundle.mjs"
sha256sum "$T/network/host-service-gate.mjs" | sed 's/^/base gate: /'
for f in network/host-service-gate-carriers.mjs network/host-admission-node.mjs scripts/build-host-admission.mjs; do cp --remove-destination "$P/src/$f" "$T/$f"; done
cmp -s "$T/network/host-service-gate.mjs" "$P/base/network/host-service-gate.mjs" || { echo "the base gate must stay f829ec3b"; exit 1; }
(cd "$T" && node scripts/build-host-admission.mjs)
cp "$T/windows/node/host-admission.bundle.mjs" "$O/candidate.host-admission.bundle.mjs"; cp "$T/metal/guest/host-policy.bundle.mjs" "$O/candidate.metal-host-policy.bundle.mjs"
node --check "$O/candidate.host-admission.bundle.mjs"
node --input-type=module -e "const m=await import('$O/candidate.host-admission.bundle.mjs'),b=await import('$O/live-rebuilt.host-admission.bundle.mjs');console.log('exports',Object.keys(m).join(','));const miss=Object.keys(b).filter(k=>!(k in m));if(miss.length)throw Error('lost exports '+miss);for(const k of ['createHostServiceGate','hostPolicyCarriersFromEnv'])if(typeof m[k]!=='function')throw Error('missing '+k)"
if grep -q "134\.199\.235\.187\|134\.209\.248\.172\|165\.245\.191\.129\|146\.190\.246\.39" "$O/candidate.host-admission.bundle.mjs"; then echo "CANDIDATE CONTAINS DO MIRROR URLS"; exit 1; fi
grep -c "policy-carriers.invalid" "$O/candidate.host-admission.bundle.mjs" | sed 's/^/carrier origin occurrences: /'
cmp -s "$O/candidate.metal-host-policy.bundle.mjs" "$W/node-cold-policy-20261021/revision2/bundle-build/out/candidate.metal-host-policy.bundle.mjs" && echo "metal host-policy bundle unchanged (acfa1b00)" || { echo "metal host-policy bundle CHANGED"; exit 1; }
# the candidate's own reproducibility: a second clean build gives the same bytes
(cd "$T" && node scripts/build-host-admission.mjs --check) && echo "candidate rebuild --check OK"
sha256sum "$O"/*.mjs
rm -rf "$T"
