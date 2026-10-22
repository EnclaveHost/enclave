#!/usr/bin/env bash
# job.sh: ONE queued job at 1024 MiB (it builds Rust), for ROOT to run after approving it. Offline: every cargo/rustc runs
# inside a loopback-only network namespace with the PRIVATE cargo home (cargo-home/, copied per build), the pinned
# toolchain (rust-toolchain.toml, RUSTUP_AUTO_INSTALL=0) and CARGO_NET_OFFLINE. The site release is NOT rebuilt or
# re-prepared: the immutable release dir is only read.
#   1. build A: site-host/ (the stage) from the release's CAR alone (scripts/build.sh --car)
#   2. build B: a copy at another path from the release DIRECTORY (scripts/build.sh --release): identical wasm and
#      SOURCE.sha256 (paths remapped); PACKAGE.json: the locked release, 20 source files, the frozen package's toolchain
#      and EXACTLY its import list (no outgoing-handler, no sockets; build.sh also refuses those)
#   3. e2e of THAT wasm (test/e2e.mjs, loopback-only netns): fleet engine 49.0.0 with the wasm manager's flags, and the
#      deployed Windows/m3 guest runtime 48.0.1 with its domexec flags (the minipc tier)
#   4. named routes under the fleet engine (tools/route-check.mjs; asset list from the accepted release check)
#   5. deliver/: wasm, PACKAGE.json, SOURCE.sha256, component.wit, RELEASE.json (+ the kubo-identical upload CID),
#      FINAL.sha256; the release tree, the frozen recovery package and enclave-apps/site-host are byte-unchanged
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
CID=bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake; REL=$W/claude-resumed-20261022/site-release-stage/release/$CID
FLEET=$W/site-host-package/engines/fleet-49.0.0-manager.sh; DOMEXEC=$W/site-host-package/engines/domexec.sh
GUEST=/home/steven/Documents/Codex/2026-10-01/i-x20/work/cid-runtime-root/plat/rt/wasmtime
FROZEN_PKG=$W/site-host-recovery-release/deliver/package/PACKAGE.json
for d in "$P/site-host/target" "$P/site-host/dist" "$P/site-host/release" "$P/repro" "$P/deliver" "$P/build-home"; do
  [ -e "$d" ] && { echo "$d exists: one build per stage"; exit 1; }; done
test -s "$P/precheck/inputs-after.txt" || { echo "run tools/precheck.sh first"; exit 1; }
mkdir -p "$P/build-home/tmp"; export TMPDIR="$P/build-home/tmp" CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=4 RUSTUP_AUTO_INSTALL=0 npm_config_offline=true
tree() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64); }
fp() { echo "release $(tree "$REL")"; (cd $W/site-host-recovery-release && sha256sum -c --quiet deliver/FINAL.sha256 && echo "recovery FINAL ok");
       echo "enclave-apps/site-host $(cd $W/enclave-apps/site-host && find . -path ./target -prune -o -path ./dist -prune -o -path ./release -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)"; }
fp > "$P/build-home/inputs-before.txt"; cmp "$P/precheck/inputs-after.txt" "$P/build-home/inputs-before.txt"
offline_build() {   # $1 = source dir, $2 = cargo home name, rest = build.sh args
  local src="$1" home="$P/build-home/$2"; shift 2
  cp -a "$P/cargo-home" "$home"
  (cd "$src" && unshare -rn env CARGO_HOME="$home" scripts/build.sh "$@")
}

echo "== 1. build A: the stage, CAR-only input"
offline_build "$P/site-host" cargo-a --car "$REL/site.car"
echo "== 2. build B: a copy at another path, release-dir input"
mkdir -p "$P/repro"; rsync -a --exclude target --exclude dist --exclude release "$P/site-host/" "$P/repro/site-host/"
offline_build "$P/repro/site-host" cargo-b --release "$REL"
a=$(sha256sum "$P/site-host/dist/site_host.wasm" | cut -c1-64); b=$(sha256sum "$P/repro/site-host/dist/site_host.wasm" | cut -c1-64)
echo "wasm A $a"; echo "wasm B $b"; test "$a" = "$b"
cmp "$P/site-host/dist/SOURCE.sha256" "$P/repro/site-host/dist/SOURCE.sha256"
node - "$P/site-host/dist/PACKAGE.json" "$FROZEN_PKG" "$P/site-host/release.lock.json" <<'JS'
const fs = require("fs"), [pkg, frozen, lock] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const fail = [];
if (pkg.release.cid !== lock.cid || pkg.release.car.sha256 !== lock.car.sha256 || pkg.release.car.bytes !== lock.car.bytes) fail.push("PACKAGE.json release is not the lock");
if (pkg.source.files !== 20) fail.push(`source files ${pkg.source.files}`);
if (pkg.toolchain.rustc !== frozen.toolchain.rustc || pkg.toolchain.cargo !== frozen.toolchain.cargo) fail.push("toolchain differs from the frozen package");
if (JSON.stringify(pkg.imports) !== JSON.stringify(frozen.imports)) fail.push("the import/export list differs from the frozen 4044ea81 package");
if (pkg.imports.some((l) => /outgoing-handler|wasi:sockets/.test(l))) fail.push("an egress import");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`PACKAGE-OK release ${pkg.release.cid}, ${pkg.imports.length} imports/exports == frozen, ${pkg.toolchain.rustc}`);
JS
echo "REPRODUCIBLE $a"

echo "== 3. e2e of $a"
cd "$P/site-host"
echo "-- 3a. fleet engine 49.0.0 (wasm manager flags)"
WASMTIME="$FLEET" scripts/test.sh "$REL"
echo "-- 3b. deployed Windows/m3 guest runtime 48.0.1 (2026-10-01 domexec flags; the minipc tier)"
DOMEXEC_BIN="$GUEST" DOMEXEC_FEATURES= WASMTIME="$DOMEXEC" scripts/test.sh "$REL"
cd "$P"

echo "== 4. named routes (fleet engine)"
WASMTIME="$FLEET" node tools/route-check.mjs site-host/dist/site_host.wasm "$REL" inputs/asset-paths.txt

echo "== 5. deliver"
mkdir -p deliver/package
cp site-host/dist/site_host.wasm site-host/dist/PACKAGE.json site-host/dist/SOURCE.sha256 deliver/package/
cp site-host/target/component.wit deliver/package/component.wit
node --input-type=module - "$W/claude-resumed-20261022/site-release-stage/src/scripts/site-release/unixfs.mjs" "$REL" <<'JS'
import fs from "node:fs";
import { createHash } from "node:crypto";
const [unixfs, rel] = process.argv.slice(2), { importFile, cidString } = await import(unixfs);
const bytes = fs.readFileSync("deliver/package/site_host.wasm"), sha = createHash("sha256").update(bytes).digest("hex");
const pkg = JSON.parse(fs.readFileSync("deliver/package/PACKAGE.json", "utf8")), m = JSON.parse(fs.readFileSync(rel + "/release.json", "utf8"));
if (pkg.wasm.sha256 !== sha || pkg.wasm.bytes !== bytes.length || pkg.release.cid !== m.cid) throw Error("PACKAGE.json does not describe the wasm/release");
const upload = cidString(importFile(bytes).cid);
const out = { schema: "site-host-release/1", status: "BUILT LOCALLY - NOT UPLOADED, NOT PUBLISHED, NOT SIGNED",
  wasm: { sha256: sha, bytes: bytes.length, uploadCid: upload }, release: { cid: m.cid, car: m.car, createdAt: m.createdAt, source: m.source, base: m.base },
  config: JSON.stringify({ release: m.cid, wasi: "0.2" }) };
fs.writeFileSync("deliver/RELEASE.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1)); console.log("EXPECTED-UPLOAD-CID " + upload);
JS
fp > build-home/inputs-after.txt; cmp build-home/inputs-before.txt build-home/inputs-after.txt; echo "INPUTS-UNCHANGED"
{ find deliver/package inventory tools inputs -maxdepth 1 -type f -print0; printf '%s\0' deliver/RELEASE.json site-host/release.lock.json; } | sort -z | xargs -0 sha256sum > deliver/FINAL.sha256
cat deliver/FINAL.sha256
rm -rf build-home/cargo-a build-home/cargo-b build-home/tmp
echo "SITE-HOST-RELEASE-JOB-OK $CID $a"
