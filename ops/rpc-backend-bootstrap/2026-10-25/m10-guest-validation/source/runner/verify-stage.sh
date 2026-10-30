#!/bin/bash
# GUEST preflight (root, read-only): refuses unless the stage is byte-exact, the toolchain is the staged rust 1.96.0, every
# required native build tool is present, and memory/disk headroom exist. Usage: verify-stage.sh STAGE MANIFEST_SHA256
set -uo pipefail
S=${1:?stage}; WANT=${2:?expected MANIFEST.sha256 sha256}; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[REFUSE] $1"; rc=1; }
[ "$(sha256sum < $S/MANIFEST.sha256 | cut -c1-64)" = "$WANT" ] && ok "MANIFEST.sha256 == $WANT" || { echo "[REFUSE] MANIFEST.sha256 is not $WANT"; exit 1; }
(cd $S && sha256sum -c --quiet --strict MANIFEST.sha256) && ok "every staged file == MANIFEST ($(wc -l < $S/MANIFEST.sha256) files)" || bad "staged files differ from MANIFEST"
n=$(cd $S && find . -type f ! -name MANIFEST.sha256 ! -name MANIFEST.json | wc -l); [ "$n" = "$(wc -l < $S/MANIFEST.sha256)" ] && ok "no unlisted file in the stage" || bad "stage has $n files, MANIFEST lists $(wc -l < $S/MANIFEST.sha256)"
[ "$(cd $S && find . -type l -printf '%p -> %l\n' | LC_ALL=C sort)" = "$(cat $S/MANIFEST.symlinks)" ] && ok "symlinks == MANIFEST.symlinks ($(wc -l < $S/MANIFEST.symlinks))" || bad "symlinks differ from MANIFEST.symlinks"
TC=$S/toolchain/rust-1.96.0
[ "$($TC/bin/rustc --version 2>&1)" = "rustc 1.96.0 (ac68faa20 2026-05-25)" ] && [ "$($TC/bin/cargo --version 2>&1)" = "cargo 1.96.0 (30a34c682 2026-05-25)" ] && ok "staged rustc/cargo 1.96.0 run on this guest" || bad "staged toolchain does not run or is not 1.96.0"
for t in cc c++ gcc g++ clang make cmake pkg-config git python3 node tar; do p=$(command -v $t) && ok "$t: $p ($($t --version 2>&1 | head -1))" || bad "missing tool: $t"; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' && ok "python3 >= 3.11 (tomllib)" || bad "python3 < 3.11"
lc=$(ls /usr/lib/llvm-*/lib/libclang.so* /usr/lib/x86_64-linux-gnu/libclang*.so* 2>/dev/null | head -1); [ -n "$lc" ] && ok "libclang (bindgen): $lc" || bad "missing libclang (apt libclang-dev)"
v=$(pkg-config --modversion openssl 2>/dev/null) && ok "pkg-config openssl $v (openssl-sys links the system OpenSSL)" || bad "missing pkg-config module openssl (apt libssl-dev)"
v=$(pkg-config --modversion zlib 2>/dev/null) && echo "[info] system zlib dev $v present" || echo "[info] no system zlib dev files: libz-sys builds its vendored zlib from the checksummed crate (zlib1g-dev deliberately NOT installed: it would upgrade the running zlib)"
v=$(pkg-config --modversion libgit2 2>/dev/null) && echo "[info] system libgit2 $v (libgit2-sys 0.18.5 links a system copy only if >= 1.9; otherwise it builds its vendored copy)" || echo "[info] no system libgit2: libgit2-sys builds its vendored copy"
id m10build >/dev/null 2>&1 && ok "build user m10build exists (uid $(id -u m10build))" || bad "missing build user m10build"
runuser -u m10build -- test ! -w $S && ok "stage not writable by m10build" || bad "stage writable by m10build"
f=$(df --output=avail -m /srv/m10-guest-validation | tail -1 | tr -d ' '); [ "$f" -ge 22528 ] && ok "disk: ${f} MiB free >= 8192 floor + 14336 build estimate" || bad "disk: only ${f} MiB free (< 22528)"
a=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo); [ "$a" -ge 28672 ] && ok "memory: MemAvailable ${a} MiB >= 16384 floor + 12288 cap" || bad "memory: MemAvailable ${a} MiB < 28672"
echo "## preflight rc=$rc"; exit $rc
