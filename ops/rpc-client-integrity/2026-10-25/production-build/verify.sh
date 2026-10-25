#!/bin/bash
# Independent READ-ONLY verification of the completed M7 RUN 1 artifact (resumed RUN 1, attempt build-1r8) and its inputs.
#   python3 work/claude-test-queue.py --mib 256 --log logs/verify.guard -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=/nonexistent \
#     unshare -rn bash verify.sh > logs/verify.out 2>&1
# Writes only logs/closure.json and logs/report.json here. Builds nothing; changes no M7/M10 input, target, profile or queue.
set -uo pipefail
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" GIT_OPTIONAL_LOCKS=0
PB=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build
ST=$PB/publication-stage; R4=$PB/recovery-4096; ABI=$PB/../../base-runtime-abi/abi.py
H=5aa7b2919870950f1dd90249d3900730184e3ce6b5a54048b3dbca2a72ef430c; B=$PB/out-1/base
. $PB/../jobs/env.sh; S=$BUILD/src; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[FAIL] $1"; rc=1; }
chk() { local w=$1; shift; "$@" && ok "$w" || bad "$w"; }
h() { sha256sum < "$1" | cut -c1-64; }
echo "== environment audit (this job)"
echo "[env] LD_* variables: $(env | grep -c '^LD_')   /etc/ld.so.preload: $([ -e /etc/ld.so.preload ] && echo PRESENT || echo absent)"
echo "[env] host $(uname -sr); glibc $(getconf GNU_LIBC_VERSION); $(openssl version 2>/dev/null)"
echo "== artifact"
chk "out-1/base sha256 == $H" [ "$(h $B)" = $H ]
chk "out-1/base size 290309776" [ "$(stat -c %s $B)" = 290309776 ]
chk "out-1/SHA256SUMS verifies (base + smoke outputs)" bash -c "cd $PB/out-1 && sha256sum -c --quiet SHA256SUMS"
chk "out-1/SHA256SUMS names base with $H" grep -q "^$H  base$" $PB/out-1/SHA256SUMS
echo "== build log and resource guard (attempt 8 = build-1r8)"
chk "build-1r8.rc == 0" [ "$(cat $R4/logs/build-1r8.rc)" = 0 ]
chk "root-resume-final.rc == 0" [ "$(cat $R4/logs/root-resume-final.rc)" = 0 ]
chk "log: cargo build rc=0" grep -q '^## cargo build rc=0 ' $R4/logs/build-1r8.out
chk "log: [artifact] $H (290309776 bytes)" grep -qF "[artifact] $H  base  (290309776 bytes)" $R4/logs/build-1r8.out
chk "log: queue cap 4096 / memory.max 4294967296" bash -c "head -1 $R4/logs/build-1r8.out | grep -q 'cap=4096MiB' && grep -q 'memory.max 4294967296' $R4/logs/build-1r8.out"
chk "guard: exit=0 peak 4072 MiB, host min 17541 MiB" grep -q 'exit=0 peakTreeRssMiB=4072 minHostAvailableMiB=17541' $R4/logs/build-1r8.guard
for i in 2 3 4 5 6 7; do echo "[attempt] build-1r$i rc=$(cat $R4/logs/build-1r$i.rc): $(tail -1 $R4/logs/build-1r$i.out)"; done
echo "== input pins re-derived now"
chk "build.sh 2ee8b8de" [ "$(h $PB/build.sh)" = 2ee8b8dec0a64331e261f0fe2fcafed5c899554322a2a0a9bd9c236202d409ec ]
chk "jobs/env.sh cd1c6b56" [ "$(h $PB/../jobs/env.sh)" = cd1c6b561bd2ff53d9d5fa9f86011478cdd1fc3f076061799c3fabd86d3fc738 ]
chk "resume-4096.sh 0321879a" [ "$(h $R4/resume-4096.sh)" = 0321879ab057d0658b6ff1cedfacccecc9bac2f17b0c9a1e6b9842820ebc6be9 ]
chk "resume-body-4096.sh 09fda204" [ "$(h $R4/resume-body-4096.sh)" = 09fda204545783b6c989ae3d6caf59f221cd6d599d033a2937fa782bae88f940 ]
chk "patch e9dfb8c6" [ "$(h $PATCH)" = e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312 ]
chk "Cargo.lock f122da76" [ "$(h $S/Cargo.lock)" = f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f ]
chk "provider 201d9b8c" [ "$(h $S/crates/consensus/providers/src/chain_provider.rs)" = 201d9b8c16b080a4f7111ca29ec5ece8f02a2b9be807bb06e24e7eb1248bb3b2 ]
chk "base repo HEAD $BASE_REV" [ "$(git -C $BASE_REPO rev-parse HEAD)" = "$BASE_REV" ]
M=$( (cd "$S" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-64)
chk "source tree manifest d8078bdf (recomputed: $M)" [ "$M" = d8078bdf5dbab667478329f8e31dac7cac4c780404982cf535d93dd109ca6efb ]
RETH=$(ls -d "$CARGO_HOME"/git/checkouts/reth-*/7134be3 | head -1)
chk "reth checkout HEAD 7134be3b" [ "$(git -C "$RETH" rev-parse HEAD)" = 7134be3b51cf9d9504f988bff3266a23085f0bd9 ]
echo "== ELF facts (read-only)"
readelf -l $B | sed -n 's/.*Requesting program interpreter: \(.*\)\]/[elf] interpreter \1/p'
echo "[elf] NEEDED: $(readelf -d $B | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
echo "[elf] RPATH/RUNPATH: $(readelf -d $B | grep -c 'R.*PATH')"
readelf -n $B | grep -i 'build id' | sed 's/^ */[elf] /'
for p in "$S" "$CARGO_HOME" "$PB/target-1"; do echo "[elf] occurrences of build path $(basename $p): $(LC_ALL=C grep -aFc "$p" $B)"; done
echo "== closure and target comparison (abi.py $(h $ABI | cut -c1-8))"
python3 -I $ABI closure $B > $ST/logs/closure.json && ok "closure derived" || bad "closure"
python3 -I $ABI report $ST/logs/closure.json --target-glibc 2.39 --target-openssl 3.0.13 > $ST/logs/report.json && cat $ST/logs/report.json
python3 -I - $ST/logs/closure.json <<'PY'
import json,sys; c=json.load(open(sys.argv[1]))
print("[closure] missing", c["missing"], "| interpreter", c["interpreter"], c["interpreterFile"]["sha256"][:16], c["interpreterFile"]["package"])
print("[closure] binaryHighest", c["binaryHighest"]); print("[closure] closureHighest", c["closureHighest"])
for n,l in sorted(c["libraries"].items()): print(f"[closure] {n:24} {l['sha256'][:16]} {l['package']}")
PY
echo "## verify rc=$rc"; exit $rc
