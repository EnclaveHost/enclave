#!/bin/bash
# GUEST preflight for run 2 (root, read-only). Refuses unless: the repair stage == its MANIFEST and the given sha; the OLD
# stage is still exactly MANIFEST dd9df0ab (toolchain, base tar, crate archives); run 1 has ENDED (receipt rc present, unit
# inactive) and its caches exist and belong to m10build; tools, libclang, openssl are present; memory/disk headroom exist.
# Usage: verify-stage-2.sh REPAIR_STAGE REPAIR_MANIFEST_SHA256
set -uo pipefail
S=${1:?stage}; WANT=${2:?repair MANIFEST.sha256 sha256}; BASE=/srv/m10-guest-validation; OLD=$BASE/stage; CACHE=$BASE/runs/run-1/build; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[REFUSE] $1"; rc=1; }
[ "$(sha256sum < $S/MANIFEST.sha256 | cut -c1-64)" = "$WANT" ] && ok "repair MANIFEST.sha256 == $WANT" || { echo "[REFUSE] repair MANIFEST.sha256 is not $WANT"; exit 1; }
(cd $S && sha256sum -c --quiet --strict MANIFEST.sha256) && ok "every repair-stage file == MANIFEST ($(wc -l < $S/MANIFEST.sha256) files)" || bad "repair stage differs from MANIFEST"
n=$(cd $S && find . -type f ! -name MANIFEST.sha256 | wc -l); [ "$n" = "$(wc -l < $S/MANIFEST.sha256)" ] && [ -z "$(cd $S && find . -type l)" ] && ok "no unlisted file or symlink in the repair stage" || bad "repair stage has unlisted files or symlinks"
[ "$(sha256sum < $S/m10-bootstrap-anchor.patch | cut -c1-64)" = d97c31b591d41fa5d18ca628ea06eb8efdbccf196122b8e05b1d06c69bf2e0a3 ] && ok "fixed M10 patch d97c31b5" || bad "M10 patch is not the fixed d97c31b5"
[ "$(sha256sum < $OLD/MANIFEST.sha256 | cut -c1-64)" = dd9df0ab82e9f8b53a90063808bdd2199b873eafcf037fb6313d4406d4fb49ee ] && (cd $OLD && sha256sum -c --quiet --strict MANIFEST.sha256) && ok "OLD stage == MANIFEST dd9df0ab (toolchain, base tar, caches as staged)" || bad "OLD stage changed"
TC=$OLD/toolchain/rust-1.96.0
[ "$($TC/bin/rustc --version 2>&1)" = "rustc 1.96.0 (ac68faa20 2026-05-25)" ] && [ "$($TC/bin/cargo --version 2>&1)" = "cargo 1.96.0 (30a34c682 2026-05-25)" ] && ok "staged rustc/cargo 1.96.0" || bad "staged toolchain does not run or is not 1.96.0"
[ -s $BASE/receipts/run-1.rc ] && [ "$(cat $BASE/receipts/run-1.rc)" = 1 ] && ! systemctl is-active --quiet m10-guest-validation-1.service && ok "run 1 ENDED (receipt rc 1, unit inactive)" || bad "run 1 not ended or its receipt differs"
for d in $CACHE/cargo-home/registry $CACHE/target/debug; do [ -d $d ] && [ "$(stat -c %U $d)" = m10build ] && ok "reused cache $d (owner m10build)" || bad "cache $d missing or not owned by m10build"; done
[ ! -e $BASE/runs/run-2 ] && ok "run-2 directory is new" || bad "runs/run-2 exists"
for t in cc c++ gcc g++ clang make cmake pkg-config git python3 node tar; do p=$(command -v $t) && ok "$t: $p ($($t --version 2>&1 | head -1))" || bad "missing tool: $t"; done
lc=$(ls /usr/lib/llvm-*/lib/libclang.so* /usr/lib/x86_64-linux-gnu/libclang*.so* 2>/dev/null | head -1); [ -n "$lc" ] && ok "libclang: $lc" || bad "missing libclang"
v=$(pkg-config --modversion openssl 2>/dev/null) && ok "pkg-config openssl $v" || bad "missing pkg-config openssl"
id m10build >/dev/null 2>&1 && ok "build user m10build (uid $(id -u m10build))" || bad "missing build user m10build"
runuser -u m10build -- test ! -w $S && runuser -u m10build -- test ! -w $OLD && ok "stages not writable by m10build" || bad "a stage is writable by m10build"
f=$(df --output=avail -m $BASE | tail -1 | tr -d ' '); [ "$f" -ge 16384 ] && ok "disk: ${f} MiB free >= 8192 floor + 8192 run-2 estimate" || bad "disk: only ${f} MiB free (< 16384)"
a=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo); [ "$a" -ge 28672 ] && ok "memory: MemAvailable ${a} MiB >= 16384 floor + 12288 cap" || bad "memory: MemAvailable ${a} MiB < 28672"
echo "## preflight-2 rc=$rc"; exit $rc
