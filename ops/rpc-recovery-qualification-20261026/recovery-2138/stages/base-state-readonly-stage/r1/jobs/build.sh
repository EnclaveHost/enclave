#!/bin/bash
# base-state-readonly-stage/r1 OFFLINE build (PREPARED by Claude; NOT run by Claude). Root:
#   bash jobs/q-exit-status.sh bsro-r1-build 4096 unshare -Urn bash base-state-readonly-stage/r1/jobs/build.sh
# Uses the cached crate sources of derivation-client-stage/combined-r1 READ-ONLY (registry + git checkouts via symlinks in a fresh
# CARGO_HOME; a before/after manifest of that cache must be identical), a FRESH target dir under /tmp, --offline, no network.
# Bounds: 7200 s wall, 4 jobs. Refuses unless every package in the resolved Cargo.lock is identical (name, version, source,
# checksum) to Base v1.5.1's lock (sha f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f) => the exact reth 7134be3 crates.
set -uo pipefail
export PATH=/usr/bin:/bin:${HOME:-/root}/.cargo/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P)
DEPS=$P/derivation-client-stage/combined-r1/build/deps-43698236e9186750; BASE_LOCK=$DEPS/base/Cargo.lock; BLSHA=f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
[ "$(sha256sum < "$BASE_LOCK" | cut -c1-64)" = "$BLSHA" ] || { echo "Base Cargo.lock != $BLSHA"; exit 9; }
command -v cargo >/dev/null || { echo "cargo not found"; exit 9; }
B=/tmp/bsro-r1-build-$(date -u +%Y%m%dT%H%M%SZ)-$$
if [ -e "$B" ]; then echo "scratch $B exists"; exit 9; fi
mkdir -p "$B/tree/src" "$B/cargo-home" || exit 9
O=$S/runs/build-$(basename "$B"); mkdir -p "$O" || exit 9
cp "$S/Cargo.toml" "$B/tree/"; cp "$S/src/main.rs" "$B/tree/src/"; cp "$BASE_LOCK" "$B/tree/Cargo.lock"
ln -s "$DEPS/cargo/registry" "$B/cargo-home/registry"; ln -s "$DEPS/cargo/git" "$B/cargo-home/git"
man() { find "$DEPS/cargo" -printf '%p %s %T@\n' | LC_ALL=C sort | sha256sum | cut -c1-64; }
M0=$(man)
(cd "$B/tree" && env -i PATH=$PATH HOME="$B" CARGO_HOME="$B/cargo-home" CARGO_TARGET_DIR="$B/target" CARGO_NET_OFFLINE=true \
   timeout -k 30 7200 cargo build --release --offline -j 4 --bin base-state-readonly) > "$O/build.log" 2>&1; rc=$?
M1=$(man); [ "$M0" = "$M1" ] || { echo "cached crate store CHANGED during build"; rc=9; }
cp "$B/tree/Cargo.lock" "$O/Cargo.lock.resolved"
python3 -I -B - "$O/Cargo.lock.resolved" "$BASE_LOCK" <<'PY' > "$O/lock-check.json"; lrc=$?
import json, sys, tomllib
a, b = (tomllib.load(open(p, "rb"))["package"] for p in sys.argv[1:3])
key = lambda p: (p["name"], p["version"], p.get("source"), p.get("checksum"))
base = {key(p) for p in b}
extra = [key(p) for p in a if p.get("source") and key(p) not in base]
reth = sorted({p.get("source") for p in a if p["name"].startswith("reth-") and p.get("source")})
ok = not extra and reth == ["git+https://github.com/base/reth?tag=base-v2.5.2.8#7134be3b51cf9d9504f988bff3266a23085f0bd9"]
print(json.dumps({"pass": ok, "packages": len(a), "notInBaseLock": extra[:50], "rethSources": reth}, indent=1)); sys.exit(0 if ok else 1)
PY
[ $lrc = 0 ] || { echo "resolved lock differs from the Base lock"; rc=9; }
tail -5 "$O/build.log"; cat "$O/lock-check.json"
if [ $rc = 0 ] && [ -x "$B/target/release/base-state-readonly" ]; then
  cp "$B/target/release/base-state-readonly" "$O/base-state-readonly" && chmod 0555 "$O/base-state-readonly" && sha256sum "$O/base-state-readonly"
fi
echo "## scratch $B (remove after review)"; echo "## outputs $O"; echo "## bsro-r1-build rc=$rc"; exit $rc
