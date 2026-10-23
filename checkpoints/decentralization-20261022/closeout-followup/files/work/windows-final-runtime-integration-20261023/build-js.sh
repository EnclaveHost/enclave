#!/usr/bin/env bash
# Windows final baseline: the JS release artifacts of the committed head (packages, consumers, network/build.mjs dist,
# relay network-runtime bundle) in this tree and an independent --local --no-hardlinks clone; Go DENIED (no image rebuild).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
B="$H/tmp/repro-b"; O="$H/tmp/js-out"; export TMPDIR="$H/tmp/t" PATH="$H/stubs:/usr/local/bin:/usr/bin:/bin"
[ "$(command -v go)" = "$H/stubs/go" ]
cd "$H/candidate"; HEAD=$(git rev-parse HEAD); echo "commit $HEAD tree $(git rev-parse HEAD^{tree})"
[ -z "$(git status --porcelain --untracked-files=no)" ]
rm -rf "$B" "$O"; mkdir -p "$O"
git clone -q --local --no-hardlinks "$H/candidate" "$B"; git -C "$B" checkout -q "$HEAD"
for d in . relay network sdk/sessions e2e; do [ -d "$H/candidate/$d/node_modules" ] && cp -a "$H/candidate/$d/node_modules" "$B/$d/node_modules"; done
for T in "$B" "$H/candidate"; do
  n=$( [ "$T" = "$B" ] && echo b || echo a ); mkdir -p "$O/$n"; rm -rf "$T/network/host-services/packages"
  (cd "$T" && timeout -k 10 600 unshare -rn --pid --fork --kill-child --mount-proc sh -c "node relay/build-network.mjs >/dev/null && node scripts/build-host-service-packages.mjs | tail -1 && node scripts/build-host-service-packages.mjs --check | tail -1 && node scripts/network/build-consumers.mjs '$O/$n/consumers' >/dev/null; node network/build.mjs '$O/$n/dist' >/dev/null 2>'$O/$n.err'; echo network/build.mjs exit=\$?")
  grep -m1 "denied: go" "$O/$n.err"; rm -f "$O/$n.err"
  cp "$T"/network/host-services/packages/* "$O/$n/"; cp "$T/relay/network-runtime.bundle.mjs" "$O/$n/"
  (cd "$O/$n" && find . -type f ! -name build-manifest.json | sort | xargs sha256sum) > "$O/$n.sha256"
done
diff "$O/a.sha256" "$O/b.sha256" && echo "REPRODUCIBLE (JS): $(wc -l < "$O/a.sha256") artifacts byte-identical"
cp "$O/a.sha256" "$H/artifacts-js-final.sha256"
# the node's deploy closure (derived from agent.mjs's import graph) at the committed head; origin-request.mjs must be in it.
# Packaged as a deterministic tar of the TREE (git archive of a tree id: no commit header) on both paths, byte-compared;
# then the extracted package alone must resolve agent.mjs's whole import graph (its own deploy-files.mjs, zero problems).
for T in "$H/candidate" "$B"; do
  (cd "$T" && timeout -k 10 120 unshare -rn sh -c 'node scripts/build-host-admission.mjs --check' | tail -1)
  (cd "$T" && timeout -k 10 120 unshare -rn node windows/node/deploy-files.mjs) > "$O/closure-$(basename $T).txt"
done
cmp "$O/closure-candidate.txt" "$O/closure-repro-b.txt"; cp "$O/closure-candidate.txt" "$H/node-deploy-files.txt"
grep -qx 'windows/node/origin-request.mjs' "$H/node-deploy-files.txt" || { echo "origin-request.mjs missing from the closure"; exit 7; }
cd "$H/candidate"; xargs sha256sum < "$H/node-deploy-files.txt" > "$H/node-deploy-files.sha256"
TREE=$(git rev-parse HEAD^{tree}); git archive --format=tar "$TREE" $(cat "$H/node-deploy-files.txt") > "$O/node-closure.tar"
git -C "$B" archive --format=tar "$TREE" $(cat "$H/node-deploy-files.txt") > "$O/node-closure-b.tar"
cmp "$O/node-closure.tar" "$O/node-closure-b.tar" && echo "closure package reproducible: $(sha256sum < "$O/node-closure.tar" | cut -c1-64) ($(wc -l < "$H/node-deploy-files.txt") files)"
X="$H/tmp/closure-verify"; rm -rf "$X"; mkdir -p "$X"; tar -xf "$O/node-closure.tar" -C "$X"
(cd "$X" && sha256sum -c --quiet "$H/node-deploy-files.sha256") && echo "extracted files match node-deploy-files.sha256"
cp "$O/node-closure.tar" "$H/node-closure.tar"
"$H/verify-closure.sh" "$H/node-closure.tar"
cp "$O/node-closure.tar" "$H/node-closure.tar"; sha256sum "$H/node-closure.tar" > "$H/node-closure.tar.sha256"
[ -z "$(git status --porcelain --untracked-files=no)" ] && echo "tree clean at $(git rev-parse HEAD)"
rm -rf "$B"
