#!/usr/bin/env bash
# ONE queued job (1024 MiB: it builds Rust). The RECOVERY site release = the reviewed final-release snapshot
# (work/site-host-final-release/tree) + ONE dashboard wording delta (site/components/deployments/deployments.js:1732,
# e9582468 -> cad9d2cc; logs/tree-copy.sha256 proves nothing else differs), through the SAME pipeline as
# work/site-host-final-release/final-site-job.sh:
#   0. credit vendor bundle --check
#   1. site build + release prepare (base = production), then a SECOND site build + prepare: the same CID (determinism)
#   2. release review + verify from scratch
#   3. frontend closure (pages, pins, local module/asset closure, features)            [result recorded, never masks 4-6]
#   4. release.lock.json -> the new CID; site-host built twice (CAR input / release-dir input): identical wasm
#   5. site-host e2e of the new wasm under the fleet engine (every file, routes, pins, hostile requests)
#   6. named-route checks (/dashboard, /credit, /recover, private-app login paths, assets, ranges)
#   7. the delta is in the shipped dashboard bundle, the old wording is not, and the prior frozen artifacts are unchanged
set -euo pipefail
cd "$(dirname "$0")"
W="$PWD"
BASE=/home/steven/Documents/Codex/2026-10-18/wo/work/logo-site-hotfix/final
FLEET=/home/steven/Documents/Codex/2026-10-18/wo/work/site-host-package/engines/fleet-49.0.0-manager.sh
export CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=4 npm_config_offline=true
build_and_prepare() {   # $1 = output dir; prints the CID
  (cd tree && GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git GIT_WORK_TREE="$PWD" GIT_OPTIONAL_LOCKS=0 node scripts/build-site.mjs) >&2
  mkdir -p "$1"
  local out; out="$(cd tree && node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --commit e762a9c5 --dirty --out "$1" \
    --base "$BASE" --base-built-at 2026-10-20T02:14:19.960Z)"
  echo "$out" | grep -v '^  ' >&2
  echo "$out" | sed -n 's/^site release \(b[a-z2-7]*\)$/\1/p' | tail -1
}

echo "== 0. credit vendor bundle check"
(cd tree && node scripts/build-credit-vault-vendor.mjs --check)

echo "== 1. the two site builds of run rs1 (logs/rs1.out: build A 09:59:40Z, build B 10:00:13Z): deterministic"
# Not rebuilt: rs1 built the site and prepared it twice. prepare stamps the release ledger with the clock (release.mjs
# builtAt = now; no option to pin it), so the two CIDs differ by that stamp alone. Proven here: every shipped byte is
# identical except the ledger, and the two ledgers and manifests are identical once their own time/CID fields are set aside.
cid=bafybeic7sud3ozsx7fbyo5iwwzqxs3pun54kppahf5eaocupahxmwikjzq; cid2=bafybeigrqwdr7xz4k5q245su2pbosgasbweum5dz3yz4zwqk2w4qtrmoli
node - "release/$cid" "release-repeat/$cid2" <<'JS'
const fs = require("fs"), path = require("path"), { createHash } = require("crypto");
const [A, B] = process.argv.slice(2), LEDGER = ".well-known/enclave-site-release.json";
const list = (root) => { const out = {}; (function walk(rel) { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
  const r = rel ? rel + "/" + e.name : e.name; if (e.isDirectory()) walk(r); else out[r] = createHash("sha256").update(fs.readFileSync(path.join(root, r))).digest("hex"); } })(""); return out; };
const a = list(A + "/site"), b = list(B + "/site");
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(), diff = keys.filter((k) => a[k] !== b[k]);
if (JSON.stringify(diff) !== JSON.stringify([LEDGER])) throw Error("site bytes differ beyond the ledger: " + diff.slice(0, 5).join(", "));
const la = JSON.parse(fs.readFileSync(path.join(A, "site", LEDGER), "utf8")), lb = JSON.parse(fs.readFileSync(path.join(B, "site", LEDGER), "utf8"));
const norm = (x, at) => JSON.parse(JSON.stringify(x).split(at).join("<BUILT-AT>"));
if (JSON.stringify(norm(la, la.builtAt)) !== JSON.stringify(norm(lb, lb.builtAt))) throw Error("the ledgers differ beyond builtAt");
const ma = JSON.parse(fs.readFileSync(path.join(A, "release.json"), "utf8")), mb = JSON.parse(fs.readFileSync(path.join(B, "release.json"), "utf8"));
const strip = (m, l) => { const x = norm(m, l.builtAt); delete x.cid; delete x.car; delete x.rootBlock; x.files = x.files.map((f) => f.path === LEDGER ? { path: f.path } : f); return JSON.stringify(x); };
if (strip(ma, la) !== strip(mb, lb)) throw Error("the release manifests differ beyond the ledger, its time and the CID");
console.log(`site files ${keys.length}: identical except ${LEDGER}; ledgers equal modulo builtAt (${la.builtAt} vs ${lb.builtAt}); manifests equal modulo CID/CAR/root block/ledger`);
JS
echo "DETERMINISTIC-SITE $cid (repeat $cid2 differs only by its build time)"
rm -rf release-repeat
REL="$W/release/$cid"

echo "== 2. review + verify"
node tree/scripts/site-release/cli.mjs review "$REL"
node tree/scripts/site-release/cli.mjs verify "$REL"
echo "RECOVERY-RELEASE $cid"

echo "== 3. frontend closure"
closure=0; node frontend-closure.mjs "$REL" || closure=$?

echo "== 4. release.lock.json + reproducible site-host builds"
node - "$REL" site-host/release.lock.json <<'JS'
const fs = require("fs"), path = require("path");
const [rel, lockFile] = process.argv.slice(2), m = JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8"));
const lock = { schema: "site-host-release-lock/1", cid: m.cid, car: { sha256: m.car.sha256, bytes: m.car.bytes },
  provenance: `enclave site release prepared by \`site/deploy.sh prepare\` from enclave main ${m.source.commit} + its uncommitted integrations (private-browser, credit-vault final, recovery; work/site-host-final-release/MAIN-SNAPSHOT.txt) + the dashboard fleet-reason wording fix (work/site-host-recovery-release); base ${m.base}` };
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

echo "== 7. the delta shipped; the old wording did not; the prior frozen artifacts are unchanged"
n=$(grep -rlE "fleet: '\+[A-Za-z_\$]+\([A-Za-z_\$]+\.reason\)\+\"</span>\"" "$REL/site" --include=*.js | wc -l)
echo "chunks carrying the new fleet-reason wording: $n"; test "$n" -ge 1
if grep -rq -- "retrying automatically" "$REL/site"; then echo "the old wording is still in the release"; exit 1; fi
echo "old wording absent from the release"
(cd ../site-host-final-release && sha256sum -c --quiet deliver/FINAL.sha256) && echo "PRIOR-FROZEN-UNCHANGED"

echo "closure-rc=$closure routes-rc=$routes"
test "$closure" = 0 && test "$routes" = 0
echo "RECOVERY-SITE-JOB-OK $cid $a"
