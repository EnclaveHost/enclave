# base-state-readonly-stage/r6 shared build environment (sourced by build.sh and preflight.sh; PREPARED by Claude, NOT run by Claude).
# r4 (root 1724): the r3 build ran `env -i HOME=$B` with NO RUSTUP_HOME/RUSTUP_TOOLCHAIN, so the rustup shim looked in an empty
# $B/.rustup and could never build. Exactly as the qualified derivation-client-stage/combined-r1/jobs/build-test.sh:
# RUSTUP_HOME=/home/steven/.rustup RUSTUP_TOOLCHAIN=1.96.0 and `rustc -V` must report 1.96.0; RUSTUP_AUTO_INSTALL=0 (never install
# or fetch a toolchain). The toolchain dir is only read; a before/after manifest of the rustup home proves it is unchanged.
export PATH=/home/steven/.cargo/bin:/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P)
DEPS=$P/derivation-client-stage/combined-r1/build/deps-43698236e9186750; BASE_LOCK=$DEPS/base/Cargo.lock
BLSHA=f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f
RH=/home/steven/.rustup; TCV=1.96.0
die() { echo "## REFUSED: $*"; exit 9; }
man() { find "$1" -printf '%p %s %T@\n' 2>/dev/null | LC_ALL=C sort | sha256sum | cut -c1-64; }
rman() { { ls -la "$RH" "$RH/toolchains"; cat "$RH/settings.toml" 2>/dev/null; } | sha256sum | cut -c1-64; }
# prepare B (scratch), O (run dir): guards, isolated CARGO_HOME over the cached store (symlinks), seeded Base lock, E=(env ...)
prepare() { # name
  ip -4 route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
  (cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
  [ "$(sha256sum < "$BASE_LOCK" | cut -c1-64)" = "$BLSHA" ] || die "Base Cargo.lock != $BLSHA"
  [ -d "$RH/toolchains/$TCV-x86_64-unknown-linux-gnu" ] || die "toolchain $TCV not installed (never installed by this job)"
  command -v cargo >/dev/null || die "cargo (rustup shim) not found"
  # r5: the BUILD scratch is the disk-guard run dir on /vm (BSRO_RUN_DIR, created 0700 by jobs/disk_guard.py); preflight keeps
  # its tiny /tmp scratch (metadata only, removed at its end)
  if [ -n "${BSRO_RUN_DIR:-}" ]; then B=$BSRO_RUN_DIR/scratch; else B=/tmp/bsro-r6-$1-$(date -u +%Y%m%dT%H%M%SZ)-$$; fi
  [ -e "$B" ] && die "scratch $B exists"
  mkdir -p "$B/tree/src/bin" "$B/cargo-home" || die "scratch"
  O=$S/runs/$1-$(basename "${BSRO_RUN_DIR:-$B}"); mkdir -p "$O" || die "run dir"
  cp "$S/Cargo.toml" "$B/tree/"; cp "$S/src/main.rs" "$B/tree/src/"; cp "$S/src/bin/mk_fixture.rs" "$B/tree/src/bin/"; cp "$BASE_LOCK" "$B/tree/Cargo.lock"
  ln -s "$DEPS/cargo/registry" "$B/cargo-home/registry"; ln -s "$DEPS/cargo/git" "$B/cargo-home/git"
  E=(env -i PATH=$PATH HOME="$B" RUSTUP_HOME=$RH RUSTUP_TOOLCHAIN=$TCV RUSTUP_AUTO_INSTALL=0 CARGO_HOME="$B/cargo-home"
     CARGO_TARGET_DIR="$B/target" CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0)
  TC=$("${E[@]}" rustc -V 2>&1); case "$TC" in "rustc $TCV "*) ;; *) die "toolchain is not $TCV: $TC";; esac
  { echo "$TC"; "${E[@]}" cargo -V 2>&1; } > "$O/toolchain.txt"
  M0=$(man "$DEPS/cargo"); R0=$(rman)
}
# the resolved lock must contain ONLY Base-lock packages and only the 7134be3 reth source
lock_check() {
  cp "$B/tree/Cargo.lock" "$O/Cargo.lock.resolved"
  python3 -I -B - "$O/Cargo.lock.resolved" "$BASE_LOCK" <<'PY' > "$O/lock-check.json"
import json, sys, tomllib
a, b = (tomllib.load(open(p, "rb"))["package"] for p in sys.argv[1:3])
key = lambda p: (p["name"], p["version"], p.get("source"), p.get("checksum"))
base = {key(p) for p in b}
extra = [key(p) for p in a if p.get("source") and key(p) not in base]
reth = sorted({p.get("source") for p in a if p["name"].startswith("reth-") and p.get("source", "").startswith("git+")})
ok = not extra and reth == ["git+https://github.com/base/reth?tag=base-v2.5.2.8#7134be3b51cf9d9504f988bff3266a23085f0bd9"]
print(json.dumps({"pass": ok, "packages": len(a), "notInBaseLock": extra[:50], "rethGitSources": reth}, indent=1)); sys.exit(0 if ok else 1)
PY
}
unchanged() { [ "$(man "$DEPS/cargo")" = "$M0" ] || { echo "## cached crate store CHANGED"; return 1; }; [ "$(rman)" = "$R0" ] || { echo "## rustup home CHANGED"; return 1; }; }
