#!/usr/bin/env bash
# Changed role artifacts ONLY, after the tests: JS release artifacts of the committed head, in this tree and in an
# independent --local --no-hardlinks clone (C's two-path recipe), Go denied (no Go source changed; no image rebuild).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure
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
cp "$O/a.sha256" "$H/artifacts-js-14d1e495.sha256"; rm -rf "$B"
