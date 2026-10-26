#!/bin/bash
# derivation-client-stage/r3 (r1, r2 frozen with their failures): OFFLINE dependency resolution check, then build + unit tests.
#   jobs/q-exit-status.sh claude-derivation-client-r3-<n> 1536 unshare -rn bash derivation-client-stage/r3/jobs/build-test.sh metadata|build
# r3 changes ONLY the cache recipe: (a) the private sparse index gets the exact config.json of the source cache with the same
# index id (sha recorded); (b) build/deps-<key>/ (source, CARGO_HOME, target) is keyed by tarball + Cargo.lock + toolchain ONLY, so
# later harness or job changes reuse the compiled dependencies; a flock on the key dir refuses concurrent runs.
# r1 (stage root) is frozen; its failure (git dependency base/reth 7134be3b missing from the private CARGO_HOME) is kept in ../logs.
# carried over unchanged: (1) the private CARGO_HOME gets reflink/copies of exactly the four git databases Cargo.lock names (reth 7134be3b,
# evm2 9b037449, discv5 7663c00e, sp1-cluster e878e6d5), each commit verified present before cargo runs; registry .crate files are
# symlinked (cargo checks each against the lock checksum); originals are never written. (2) build/<key>/ is PERSISTENT and keyed by
# tarball + Cargo.lock + harness + toolchain + this job, so a retry reuses compilation; nothing is deleted on failure.
# Source is trusted ONLY by sha256 9784e20a... of the tarball. --frozen --offline -j1; Cargo.lock must stay byte-identical.
set -uo pipefail
MODE=${1:-}; case "$MODE" in metadata|build) ;; *) echo "usage: build-test.sh metadata|build"; exit 2;; esac
export PATH=/home/steven/.cargo/bin:/usr/bin:/bin           # run 2: the rustup proxies FIRST (run 1 used Arch's /usr/bin rustc 1.99.1)
W=/home/steven/Documents/Codex/2026-10-18/wo/work; R3=$W/rpc-production-final-20261025/derivation-client-stage/r3
TB=$W/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz
F=$W/rpc-production-final-20261025/finality-stage
GITSRC=($F/bytecode-v2-recovery/build/cargo-home $F/bytecode-v2-validation/build/cargo-home $F/client-integrity-next/build/cargo-home)
REGSRC=(${GITSRC[@]} /home/steven/.cargo $W/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/cargo-home-helios
        $W/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/cargo-home-listener $W/resume-after-checkpoint-20261022/witness-failover/cargo-home)
GITDBS=(reth-babcd6134566c621:7134be3b51cf9d9504f988bff3266a23085f0bd9 evm2-e7f3df04b1900f38:9b037449c846515624ff6afde739f2b764851446
        discv5-71668fb628bb9a3d:7663c00ee0837ea98547caaedede95d9d6736f4d sp1-cluster-b26fc49a9b462539:e878e6d5d03613de39ab574d6dbeef0b76f0dfab)
OUT=$R3/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## SETUP: $*" | tee -a $OUT/setup.txt; echo "## derivation-client-r3 rc=9"; exit 9; }
mkdir -p $OUT || exit 9
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd $R3 && sha256sum -c --quiet SHA256SUMS) || die "r3 != SHA256SUMS"
TS=$(sha256sum < $TB | cut -c1-64); [ "$TS" = 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 ] || die "base tarball is not the pinned 9784e20a"
TOP=$(tar -tzf $TB | head -1 | cut -d/ -f1); LS=$(tar -xzOf $TB "$TOP/Cargo.lock" | sha256sum | cut -c1-64)
[ "$LS" = f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f ] || die "Cargo.lock is not f122da76"
HS=$(sha256sum < $R3/src/examples/derivation_harness.rs | cut -c1-64); TC=$(RUSTUP_TOOLCHAIN=1.96.0 rustc -V 2>&1)
case "$TC" in 'rustc 1.96.0 '*) ;; *) die "toolchain is not rustup 1.96.0: $TC";; esac
CV=$(RUSTUP_TOOLCHAIN=1.96.0 cargo -V 2>&1); case "$CV" in 'cargo 1.96.0 '*) ;; *) die "cargo is not 1.96.0: $CV";; esac; JS=$(sha256sum < $R3/jobs/build-test.sh | cut -c1-64)
KEY=$(printf '%s\n' "$TS" "$LS" "$TC" | sha256sum | cut -c1-16); B=$R3/build/deps-$KEY            # r3: deps key = tarball+lock+toolchain
printf 'tarball %s\nlock %s\nharness %s\ntoolchain %s\njob %s\nkey %s\n' "$TS" "$LS" "$HS" "$TC" "$JS" "$KEY" > $OUT/key.txt
[ "$(df --output=avail -k $R3 | tail -1)" -ge 20971520 ] || die "< 20 GiB free for build/"
mkdir -p $B && chmod 0700 $B || die "build dir"
exec 8>$B/.lock; flock -n 8 || die "another run holds $B"
if [ ! -e $B/base/.extracted ]; then rm -rf $B/base && mkdir $B/base && tar -xzf $TB -C $B/base --strip-components=1 && touch $B/base/.extracted || die "extract"; fi
mkdir -p $B/base/crates/proof/zk/utils/examples && cp $R3/src/examples/derivation_harness.rs $B/base/crates/proof/zk/utils/examples/ || die "example"
CH=$B/cargo; IX=index.crates.io-1949cf8c6b5b557f
if [ ! -e $CH/.ready ]; then
  rm -rf $CH && mkdir -p $CH/registry/cache/$IX $CH/registry/index/$IX/.cache $CH/git/db $CH/git/checkouts || die "cargo home"
  for src in "${REGSRC[@]}"; do
    for f in $src/registry/cache/*/*.crate; do [ -e "$f" ] && [ ! -e $CH/registry/cache/$IX/$(basename $f) ] && ln -s "$f" $CH/registry/cache/$IX/; done
  done
  # run 2: per lock package, the sparse-index cache entry that LISTS its exact version (run 1's cp -n kept a stale chrono entry)
  tar -xzOf $TB "$TOP/Cargo.lock" > $B/lock.toml
  python3 -I - $B/lock.toml $CH/registry/cache/$IX $CH/registry/index/$IX/.cache "${REGSRC[@]}" > $OUT/index-merge.json <<'PY' || die "registry closure incomplete (see index-merge.json)"
import json, os, re, shutil, sys
lock, cache, idx, srcs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
pk = re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry\+https://github.com/rust-lang/crates.io-index"', open(lock).read())
def rel(n):
    n = n.lower()
    return os.path.join('1', n) if len(n) == 1 else os.path.join('2', n) if len(n) == 2 else os.path.join('3', n[0], n) if len(n) == 3 else os.path.join(n[:2], n[2:4], n)
need = {}
for n, v in pk: need.setdefault(n, set()).add(v)
miss_idx, miss_crate = [], []
for n, vs in sorted(need.items()):
    for v in vs:
        if not os.path.exists(os.path.join(cache, f'{n}-{v}.crate')): miss_crate.append(f'{n}-{v}')
    best = None
    for s in srcs:
        for d in (os.listdir(os.path.join(s, 'registry/index')) if os.path.isdir(os.path.join(s, 'registry/index')) else []):
            f = os.path.join(s, 'registry/index', d, '.cache', rel(n))
            if os.path.isfile(f):
                b = open(f, 'rb').read()
                if all(f'"vers":"{v}"'.encode() in b for v in vs): best = f; break
        if best: break
    if not best: miss_idx.append(f'{n} {sorted(vs)}'); continue
    t = os.path.join(idx, rel(n)); os.makedirs(os.path.dirname(t), exist_ok=True); shutil.copyfile(best, t)
print(json.dumps({'lockRegistryPackages': len(pk), 'missingIndex': miss_idx, 'missingCrate': miss_crate}, indent=1))
sys.exit(1 if miss_idx or miss_crate else 0)
PY
  for e in "${GITDBS[@]}"; do db=${e%%:*}; c=${e##*:}; got=""
    for src in "${GITSRC[@]}"; do
      if [ -d $src/git/db/$db ] && git --git-dir=$src/git/db/$db cat-file -e "$c^{commit}" 2>/dev/null; then
        cp -a --reflink=auto $src/git/db/$db $CH/git/db/ && { [ -d $src/git/checkouts/$db ] && cp -a --reflink=auto $src/git/checkouts/$db $CH/git/checkouts/ || true; } && got=$src; break; fi
    done
    [ -n "$got" ] || die "git commit $c ($db) not available in any local cache"
    git --git-dir=$CH/git/db/$db cat-file -e "$c^{commit}" || die "private copy of $db lacks $c"
    echo "git $db $c from $got" >> $OUT/cargo-home.txt
  done
  touch $CH/.ready
fi
# r3: the sparse index config.json of the SAME index id, from the first source cache that has it (read-only), sha recorded
if [ ! -e $CH/registry/index/$IX/config.json ]; then
  for src in "${GITSRC[@]}" /home/steven/.cargo; do [ -f $src/registry/index/$IX/config.json ] && { cp $src/registry/index/$IX/config.json $CH/registry/index/$IX/config.json; echo "config.json from $src" >> $OUT/cargo-home.txt; break; }; done
fi
[ -f $CH/registry/index/$IX/config.json ] || die "no config.json for $IX in any source cache"
echo "config.json sha256 $(sha256sum < $CH/registry/index/$IX/config.json | cut -c1-64)" >> $OUT/cargo-home.txt
echo "crates available: $(ls $CH/registry/cache/$IX | wc -l)" >> $OUT/cargo-home.txt
E=(env -i PATH=$PATH HOME=$B RUSTUP_HOME=/home/steven/.rustup RUSTUP_TOOLCHAIN=1.96.0 CARGO_HOME=$CH CARGO_TARGET_DIR=$B/target CARGO_INCREMENTAL=0
   CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true CARGO_NET_GIT_FETCH_WITH_CLI=false)
if [ "$MODE" = metadata ]; then
  (cd $B/base && "${E[@]}" timeout 900 cargo metadata --format-version 1 --frozen --offline > $B/metadata.json 2> $OUT/metadata.err); rm=$?
  [ $rm = 0 ] && python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('metadata packages', len(d['packages']), 'workspace members', len(d['workspace_members']))" $B/metadata.json > $OUT/metadata.txt
  [ "$(tar -xzOf $TB "$TOP/Cargo.lock" | cmp - $B/base/Cargo.lock >/dev/null && echo same)" = same ] && echo "Cargo.lock unchanged $LS" > $OUT/lock.txt || echo "Cargo.lock CHANGED" > $OUT/lock.txt
  echo "## derivation-client-r3 metadata key=$KEY rc=$rm"; cat $OUT/metadata.txt 2>/dev/null; tail -5 $OUT/metadata.err; exit $rm
fi
(cd $B/base && "${E[@]}" timeout 10800 cargo test -p base-proof-zk-utils --example derivation_harness --frozen --offline -j1 -- --test-threads=1) > $OUT/cargo-test.txt 2>&1; rt=$?
rb=-1; if [ $rt = 0 ]; then (cd $B/base && "${E[@]}" timeout 3600 cargo build -p base-proof-zk-utils --example derivation_harness --frozen --offline -j1) > $OUT/cargo-build.txt 2>&1; rb=$?; fi
[ "$(cd $B/base && tar -xzOf $TB "$TOP/Cargo.lock" | cmp - Cargo.lock >/dev/null && echo same)" = same ] && echo "Cargo.lock unchanged $LS" > $OUT/lock.txt || echo "Cargo.lock CHANGED" > $OUT/lock.txt
BIN=$B/target/debug/examples/derivation_harness; [ -x $BIN ] && sha256sum $BIN > $OUT/binary.sha256
grep -E '^test |^test result:|^error(\[|:)' $OUT/cargo-test.txt > $OUT/test-summary.txt 2>/dev/null
echo "## derivation-client-r3 build key=$KEY test-rc=$rt build-rc=$rb"; tail -4 $OUT/test-summary.txt
[ $rt = 0 ] && [ $rb = 0 ] && exit 0 || exit 1
