#!/bin/bash
# ROOT-COORDINATED ONLY: invoke through memory guard, inside unshare -Urnm.
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-23/it/work/signed-payload-execution-stage/r2
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
B=$P/derivation-lease-coverage-stage/build/deps-43698236e9186750
R=$P/derivation-client-stage/r3/build/deps-43698236e9186750
OUT=/home/steven/Documents/Codex/2026-10-23/it/work/signed-payload-capture-stage/r2/logs/release-run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$OUT"
test "$(readlink /proc/self/ns/mnt)" != "$(readlink /proc/1/ns/mnt)" || { echo 'Private mount namespace required'; exit 9; }
if ip -o route | rg -q .; then echo 'Network routes present; offline namespace required'; exit 9; fi
cd "$S"
sha256sum -c --quiet SHA256SUMS
exec 8>"$B/.lease-v3-lock"
flock -n 8 || { echo 'Existing native cache is busy'; exit 9; }
python3 -I - "$S" <<'PY'
import hashlib,json,sys
from pathlib import Path
s=Path(sys.argv[1]); p=json.loads((s/'INPUTS.json').read_text())
for name,digest in p['inputs'].items():
 assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==digest, 'input changed: '+name
print('Pinned input bytes verified')
PY
test "$(RUSTUP_TOOLCHAIN=1.96.0 rustc -V | cut -d' ' -f2)" = 1.96.0
# Reuse the canonical absolute build paths recorded in the native cache.
# Every mount is private; no frozen source file is overwritten on the host.
mount --bind "$B" "$R"
X=$R/base/crates/proof/zk/utils
mkdir "$OUT/examples"
cp -a "$X/examples/." "$OUT/examples/"
cp "$S/src/"*.rs "$OUT/examples/"
mount --bind "$OUT/examples" "$X/examples"
mount --bind "$S/src/Cargo.toml" "$X/Cargo.toml"
mount --bind "$S/src/Cargo.lock" "$R/base/Cargo.lock"
E=(env -i PATH="$PATH" HOME="$R" RUSTUP_HOME=/home/steven/.rustup RUSTUP_TOOLCHAIN=1.96.0
  CARGO_HOME="$R/cargo" CARGO_TARGET_DIR="$R/target" CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_RELEASE_DEBUG=0
  CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true)
cd "$R/base"
set +e
"${E[@]}" timeout 3600 cargo test --release -p base-proof-zk-utils --example signed_payload_candidate --frozen --offline -j1 -- --test-threads=1 > "$OUT/test.log" 2>&1
test_rc=$?
build_rc=125
if test "$test_rc" = 0; then
  "${E[@]}" timeout 3600 cargo build --release -p base-proof-zk-utils --example signed_payload_candidate --frozen --offline -j1 > "$OUT/build.log" 2>&1
  build_rc=$?
fi
set -e
printf '%s\n' "$test_rc" > "$OUT/test.rc"
printf '%s\n' "$build_rc" > "$OUT/build.rc"
if test "$test_rc" != 0 || test "$build_rc" != 0; then
  tail -35 "$OUT/test.log"
  exit 1
fi
sha256sum "$R/target/release/examples/signed_payload_candidate" > "$OUT/binary.sha256"
echo "Release candidate compiled; evaluator pin NOT updated; receipts in $OUT; positive real execution and production qualification remain pending"
