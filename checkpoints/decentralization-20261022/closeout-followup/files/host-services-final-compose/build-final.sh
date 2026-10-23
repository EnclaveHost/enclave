#!/usr/bin/env bash
# Final artifacts of the composed commit, C's proven recipe (windows-host-services-compose/cold/repro.sh): build in this
# candidate AND in an independent --local --no-hardlinks clone at another path, compare every artifact byte for byte.
# Offline (unshare -rn); Go: GOPROXY=off, -mod=readonly, local toolchain. Also: the packages' --check, the Go VCS stamps
# and the Windows node's derived deploy-file closure. Writes only under this directory.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose
B="$H/tmp/repro-b"; O="$H/tmp/repro-out"; export GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local TMPDIR="$H/tmp/t"
export PATH="$H/stubs:/usr/local/bin:/usr/bin:/bin"
cd "$H/candidate"; HEAD=$(git rev-parse HEAD); echo "commit $HEAD tree $(git rev-parse HEAD^{tree})"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo DIRTY; exit 5; }
go version; node --version
rm -rf "$B" "$O"; mkdir -p "$O"
git clone -q --local --no-hardlinks "$H/candidate" "$B"; git -C "$B" checkout -q "$HEAD"; git -C "$B" rev-parse HEAD
for d in . relay network sdk/sessions e2e; do [ -d "$H/candidate/$d/node_modules" ] && cp -a "$H/candidate/$d/node_modules" "$B/$d/node_modules"; done
for T in "$B" "$H/candidate"; do
  n=$( [ "$T" = "$B" ] && echo b || echo a ); mkdir -p "$O/$n"
  # C's RESULT-COLD 7.3 order: Go (network/build.mjs) on a CLEAN tree first, so vcs.modified=false; only then the untracked packages
  rm -rf "$T/network/host-services/packages"; [ -z "$(git -C "$T" status --porcelain)" ] || { git -C "$T" status --porcelain; echo "NOT CLEAN before Go"; exit 4; }
  (cd "$T" && timeout -k 10 900 unshare -rn --pid --fork --kill-child --mount-proc sh -c "node relay/build-network.mjs >/dev/null && node network/build.mjs '$O/$n/dist' >/dev/null && node scripts/build-host-service-packages.mjs | tail -1 && node scripts/build-host-service-packages.mjs --check | tail -1 && node scripts/network/build-consumers.mjs '$O/$n/consumers' >/dev/null")
  cp "$T"/network/host-services/packages/* "$O/$n/"; cp "$T/relay/network-runtime.bundle.mjs" "$O/$n/"
  (cd "$O/$n" && find . -type f ! -name build-manifest.json | sort | xargs sha256sum) > "$O/$n.sha256"
done
if diff "$O/a.sha256" "$O/b.sha256"; then echo "REPRODUCIBLE: $(wc -l < "$O/a.sha256") artifacts byte-identical"; else echo DIFFER; exit 3; fi
cp "$O/a.sha256" "$H/artifacts-final.sha256"; mkdir -p "$H/release"; rm -rf "$H/release/"*; cp -a "$O/a/." "$H/release/"; (cd "$H/release" && find . -type f | sort | xargs sha256sum) > "$H/release.sha256"
for f in enclave-wg enclave-wg.exe enclave-circuit-firewall.exe; do echo "== $f"; go version -m "$O/a/dist/$f" | grep -E "^\s+(build\s+vcs|build\s+-trimpath|build\s+GOOS)|go1\." ; done
# the Windows node's derived deploy closure (windows/node/deploy-files.mjs), with each file's sha256
node windows/node/deploy-files.mjs > "$H/node-deploy-files.txt"; xargs -a "$H/node-deploy-files.txt" sha256sum > "$H/node-deploy-files.sha256"; wc -l < "$H/node-deploy-files.txt"
rm -rf "$B"
diff <(cut -c1-64,66- "$H/artifacts-final-run1-modified.sha256" | grep -v "/dist/enclave-") <(grep -v "/dist/enclave-" "$H/artifacts-final.sha256") && echo "JS artifacts identical to the first build"
