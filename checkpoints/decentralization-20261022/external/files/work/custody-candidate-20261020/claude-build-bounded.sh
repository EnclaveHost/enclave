#!/bin/bash
# ONE bounded custodian candidate build (claude, 2026-10-20), from the clean clone only.
#   claude-build-bounded.sh <out dir name under work/> <label>
# Scope: MemoryMax=2048M, MemorySwapMax=0, CARGO_BUILD_JOBS=1, GOMAXPROCS=2. Refuses to start below 18 GiB MemAvailable; a
# 1 s watchdog stops ONLY this scope below 16 GiB. Offline (CARGO_NET_OFFLINE, GOPROXY=off), git never takes the index
# lock (GIT_OPTIONAL_LOCKS=0), a fresh GOCACHE and TMPDIR on the work disk (never /tmp tmpfs). Never --allow-dirty.
set -u
W=/home/steven/Documents/Codex/2026-10-18/wo/work
SRC=$W/custody-candidate-source-20261020
OUT=$W/$1; LABEL=$2
LOGD=$W/custody-candidate-20261020; LOG=$LOGD/claude-build-$LABEL.log
SCR=$W/custody-candidate-20261020/claude-scratch-$LABEL
[ -e "$OUT" ] && { echo "refusing: $OUT exists (an image is built once)"; exit 64; }
[ -e "$SCR" ] && { echo "refusing: $SCR exists"; exit 64; }
AV=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
if [ "$AV" -lt $((18*1024*1024)) ]; then echo "refusing: MemAvailable ${AV} kB < 18 GiB; not launching"; exit 75; fi
[ -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$SRC" status --porcelain)" ] || { echo "refusing: the clean clone is not clean"; exit 65; }
mkdir -p "$SCR/gocache" "$SCR/tmp"
UNIT=claude-custodian-$LABEL-$$
{ echo "== $(date -Is) label=$LABEL MemAvailable_kB=$AV head=$(git -C "$SRC" rev-parse HEAD) out=$OUT"
  echo "== scope MemoryMax=2048M MemorySwapMax=0 CARGO_BUILD_JOBS=1 GOMAXPROCS=2 offline"; } > "$LOG"
cd "$SRC"
systemd-run --user --scope -q --unit="$UNIT" -p MemoryMax=2048M -p MemorySwapMax=0 \
  env CARGO_BUILD_JOBS=1 GOMAXPROCS=2 CARGO_NET_OFFLINE=true GOPROXY=off GOFLAGS= GIT_OPTIONAL_LOCKS=0 \
      GOCACHE="$SCR/gocache" TMPDIR="$SCR/tmp" OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd \
      SEV_SNP_MEASURE=/home/steven/.local/bin/sev-snp-measure \
  bash -c '
    timeout --signal=TERM 3600 node scripts/build-custodian-v2.mjs "$@"; rc=$?
    d=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
    echo "peak_bytes=$(cat $d/memory.peak)"; echo "events: $(grep -E "^(max|oom|oom_kill) " $d/memory.events | tr "\n" " ")"; exit $rc' _ \
  --base $W/metal-wallet-control-image --out "$OUT" \
  --vault 0x56b81b3970a8ac2c52f9874bd2758ede30758228 --host-ownership 0xf5e9e6c02449001f6e8e95e5d87413f2cb6790ea \
  --independent-admission owner-permits --transport direct \
  --shield-recipients $W/custody-candidate-20261020/shield.json --trusted-proxy 10.0.2.2 >> "$LOG" 2>&1 &
PID=$!; MINAV=$AV; STOPPED=""
while kill -0 $PID 2>/dev/null; do
  a=$(awk '/MemAvailable/{print $2}' /proc/meminfo); [ "$a" -lt "$MINAV" ] && MINAV=$a
  if [ "$a" -lt 16777216 ]; then STOPPED="host floor (MemAvailable ${a} kB)"; echo "WATCHDOG: $STOPPED; stopping own scope $UNIT" >> "$LOG"; systemctl --user stop "$UNIT.scope"; fi
  sleep 1
done
wait $PID; rc=$?
echo "exit=$rc minMemAvailable_kB=$MINAV stopped=${STOPPED:-no}" | tee -a "$LOG"
exit $rc
