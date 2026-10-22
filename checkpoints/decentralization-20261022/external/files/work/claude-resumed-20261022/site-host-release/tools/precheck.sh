#!/usr/bin/env bash
# precheck.sh: STATIC / input checks for the site-host build of release bafybeifkfgxsjz6… (queue 512; node + cargo
# resolution only: no compile, no wasm run, no network). Writes only under precheck/.
#   1. embed-release.mjs (the component's own input gate) accepts the immutable release BOTH ways (--car / --release) into
#      scratch dirs, with byte-identical site.car; it refuses the frozen recovery CAR/dir (lock mismatch) and a truncated CAR.
#   2. no-egress source invariant: world.wit exports only wasi:http/incoming-handler and imports nothing; build.sh still
#      refuses an outgoing-handler/sockets import; Cargo.toml has exactly 3 dependencies (wit-bindgen-rt, serde_json, sha2).
#   3. offline dependency closure: inside a loopback-only network namespace, `cargo fetch --locked --offline` with the
#      PRIVATE cargo home resolves every crate (pinned toolchain, RUSTUP_AUTO_INSTALL=0); ~/.cargo is not used.
#   4. tools: the pinned toolchain's rustc/cargo versions equal the frozen package's; wasm-tools, the fleet engine 49.0.0 and
#      the deployed guest runtime 48.0.1 answer --version; scripts parse (bash -n, node --check).
#   5. the stage is intact (inventory/source-after.json) and the release tree, the frozen recovery package and
#      enclave-apps/site-host are unchanged.
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
CID=bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake; REL=$W/claude-resumed-20261022/site-release-stage/release/$CID
OLDREL=$W/site-host-recovery-release/release/bafybeic7sud3ozsx7fbyo5iwwzqxs3pun54kppahf5eaocupahxmwikjzq
FLEET=$W/site-host-package/engines/fleet-49.0.0-manager.sh; GUEST=/home/steven/Documents/Codex/2026-10-01/i-x20/work/cid-runtime-root/plat/rt/wasmtime
O=$P/precheck; [ -e "$O" ] && { echo "$O exists"; exit 1; }; mkdir -p "$O/tmp"; export TMPDIR="$O/tmp"
E=$P/site-host/scripts/embed-release.mjs; L=$P/site-host/release.lock.json
tree() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64); }
fp() { echo "release $(tree "$REL")"; (cd $W/site-host-recovery-release && sha256sum -c --quiet deliver/FINAL.sha256 && echo "recovery FINAL ok");
       echo "enclave-apps/site-host $(cd $W/enclave-apps/site-host && find . -path ./target -prune -o -path ./dist -prune -o -path ./release -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)"; }
fp > "$O/inputs-before.txt"

echo "== 1. the input gate"
node "$E" --car "$REL/site.car" --lock "$L" --out "$O/embed-car"
node "$E" --release "$REL" --lock "$L" --out "$O/embed-dir"
cmp "$O/embed-car/site.car" "$O/embed-dir/site.car"; cmp "$O/embed-car/site.car" "$REL/site.car"
node -e 'const [a,b]=process.argv.slice(1).map(f=>JSON.parse(require("fs").readFileSync(f)));if(a.cid!==b.cid||JSON.stringify(a.car)!==JSON.stringify(b.car))throw Error("embeds disagree");console.log("embed cid",a.cid,"blocks",a.car.blocks)' "$O/embed-car/release.json" "$O/embed-dir/release.json"
neg() { local what="$1"; shift; if node "$E" "$@" --lock "$L" --out "$O/neg" > "$O/neg.log" 2>&1; then echo "ACCEPTED $what"; exit 1; fi; echo "refused $what: $(grep -m1 -o 'Error: .*' "$O/neg.log")"; }
neg "the frozen recovery CAR" --car "$OLDREL/site.car"
neg "the frozen recovery release dir" --release "$OLDREL"
head -c 1000000 "$REL/site.car" > "$O/tmp/truncated.car"; neg "a truncated CAR" --car "$O/tmp/truncated.car"; rm -f "$O/tmp/truncated.car"
test ! -e "$O/neg/site.car"
echo "INPUT-GATE-OK"

echo "== 2. no-egress source invariant"
grep -v '^ *//' "$P/site-host/wit/world.wit" | grep -E '^\s*(import|export) ' > "$O/world-items.txt"
[ "$(cat "$O/world-items.txt" | tr -d ' ')" = "exportwasi:http/incoming-handler@0.2.6;" ] || { echo "world.wit items: $(cat "$O/world-items.txt")"; exit 1; }
grep -q 'import wasi:http/outgoing-handler|import wasi:sockets/' "$P/site-host/scripts/build.sh"
[ "$(sed -n '/^\[dependencies\]/,/^\[/p' "$P/site-host/Cargo.toml" | grep -cE '^[a-z]')" = 3 ]
echo "NO-EGRESS-SOURCE-OK"

echo "== 3. offline dependency closure (loopback-only netns, private cargo home)"
cp -a "$P/cargo-home" "$O/cargo-home"            # cargo writes its lock/state files there; the stage copy stays pristine
(cd "$P/site-host" && unshare -rn env CARGO_HOME="$O/cargo-home" CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 \
   cargo fetch --locked --offline --target wasm32-wasip2)
cmp "$W/site-host-recovery-release/site-host/Cargo.lock" "$P/site-host/Cargo.lock"; echo "Cargo.lock unchanged"
echo "OFFLINE-DEPS-OK"

echo "== 4. tools"
(cd "$P/site-host" && RUSTUP_AUTO_INSTALL=0 rustc -V && RUSTUP_AUTO_INSTALL=0 cargo -V) | tee "$O/toolchain.txt"
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));const t=require("fs").readFileSync(process.argv[2],"utf8").trim().split("\n");if(t[0]!==p.toolchain.rustc||t[1]!==p.toolchain.cargo)throw Error("toolchain differs from the frozen package: "+t);console.log("toolchain == frozen 4044ea81 package")' \
  "$W/site-host-recovery-release/deliver/package/PACKAGE.json" "$O/toolchain.txt"
wasm-tools --version; "$FLEET" --version; "$GUEST" --version
for f in "$P"/tools/*.sh "$P"/site-host/scripts/*.sh; do bash -n "$f"; done
for f in "$P"/tools/*.mjs "$P"/site-host/scripts/*.mjs "$P"/site-host/test/*.mjs; do node --check "$f"; done
echo "TOOLS-OK"

echo "== 5. stage intact, inputs unchanged"
node -e 'const fs=require("fs"),c=require("crypto"),inv=JSON.parse(fs.readFileSync(process.argv[1]));for(const[p,v]of Object.entries(inv)){const h=c.createHash("sha256").update(fs.readFileSync(process.argv[2]+"/"+p)).digest("hex");if(h!==v.sha256)throw Error(p+" changed")}console.log("stage source == inventory/source-after.json ("+Object.keys(inv).length+" files)")' \
  "$P/inventory/source-after.json" "$P/site-host"
test -z "$(find "$P/site-host" -mindepth 1 -maxdepth 1 \( -name target -o -name dist -o -name release \))"; echo "no build outputs in the stage"
fp > "$O/inputs-after.txt"; cmp "$O/inputs-before.txt" "$O/inputs-after.txt"; cat "$O/inputs-after.txt"
rm -rf "$O/tmp" "$O/neg" "$O/embed-dir" "$O/cargo-home" "$O/embed-car/site.car"
echo "PRECHECK-OK"
