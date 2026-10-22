#!/usr/bin/env bash
# ONE queued job (1024 MiB: it builds Rust). The final site frontend release + its site-host package:
#   0. credit vendor bundle --check (the manifest's bytes rebuild from the locked deps)
#   1. site build (existing scripts/build-site.mjs) + release prepare (existing site-release tool), base = production
#   2. release review + verify from scratch
#   3. frontend closure (pages, pins, local module/asset closure, features)            [result recorded, never masks 4-6]
#   4. release.lock.json -> the new CID; site-host built twice (two dirs, CAR input / release-dir input): identical wasm
#   5. site-host e2e of the new wasm under the fleet engine (every file, routes, pins, hostile requests)
#   6. named-route checks (/dashboard, /credit, /recover, private-app login paths, assets, ranges)
set -euo pipefail
cd "$(dirname "$0")"
W="$PWD"
BASE=/home/steven/Documents/Codex/2026-10-18/wo/work/logo-site-hotfix/final
FLEET=/home/steven/Documents/Codex/2026-10-18/wo/work/site-host-package/engines/fleet-49.0.0-manager.sh
export CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=4 npm_config_offline=true

echo "== 0. credit vendor bundle check"
(cd tree && node scripts/build-credit-vault-vendor.mjs --check)

echo "== 1. site build + release prepare"
(cd tree && GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git GIT_WORK_TREE="$PWD" GIT_OPTIONAL_LOCKS=0 node scripts/build-site.mjs)
mkdir -p release
out="$(cd tree && node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --commit e762a9c5 --dirty --out ../release \
  --base "$BASE" --base-built-at 2026-10-20T02:14:19.960Z)"
echo "$out" | grep -v '^  '
cid="$(echo "$out" | sed -n 's/^site release \(b[a-z2-7]*\)$/\1/p' | tail -1)"
test -n "$cid"
REL="$W/release/$cid"

echo "== 2. review + verify"
node tree/scripts/site-release/cli.mjs review "$REL"
node tree/scripts/site-release/cli.mjs verify "$REL"
echo "FINAL-RELEASE $cid"

echo "== 3. frontend closure"
closure=0; node frontend-closure.mjs "$REL" || closure=$?

echo "== 4. release.lock.json + reproducible site-host builds"
node - "$REL" site-host/release.lock.json <<'JS'
const fs = require("fs"), path = require("path");
const [rel, lockFile] = process.argv.slice(2), m = JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8"));
const lock = { schema: "site-host-release-lock/1", cid: m.cid, car: { sha256: m.car.sha256, bytes: m.car.bytes },
  provenance: `enclave site release prepared by \`site/deploy.sh prepare\` from enclave main ${m.source.commit} + its uncommitted integrations (private-browser, credit-vault final, recovery; work/site-host-final-release/MAIN-SNAPSHOT.txt); base ${m.base}` };
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
console.log("lock ->", m.cid);
JS
(cd site-host && scripts/build.sh --car "$REL/site.car")
rm -rf repro && mkdir -p repro && rsync -a --exclude target --exclude dist --exclude release/site.car --exclude release/release.json site-host/ repro/site-host/
(cd repro/site-host && scripts/build.sh --release "$REL")
a=$(sha256sum site-host/dist/site_host.wasm | cut -c1-64); b=$(sha256sum repro/site-host/dist/site_host.wasm | cut -c1-64)
echo "wasm A $a"; echo "wasm B $b"; test "$a" = "$b"; cmp site-host/dist/SOURCE.sha256 repro/site-host/dist/SOURCE.sha256
echo "REPRODUCIBLE $a"

echo "== 5. site-host e2e under the fleet engine"
(cd site-host && WASMTIME="$FLEET" scripts/test.sh "$REL")

echo "== 6. named routes"
routes=0; WASMTIME="$FLEET" node route-check.mjs site-host/dist/site_host.wasm "$REL" || routes=$?

echo "closure-rc=$closure routes-rc=$routes"
test "$closure" = 0 && test "$routes" = 0
echo "FINAL-SITE-JOB-OK $cid $a"
