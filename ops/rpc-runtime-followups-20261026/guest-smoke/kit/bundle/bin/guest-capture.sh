#!/bin/bash
# guest-capture.sh: runs ON THE RPC GUEST as root, started ONLY by the host runner jobs/root-guest-capture-runner.sh (which owns host
# admission: shared 4096 MiB queue reservation, physical-host 16 GiB floor watchdog, timeout, independent remote cleanup). PREPARED.
#   guest-capture.sh --run-id ID         exact-N capture (below)
#   guest-capture.sh --cleanup ID        stop + reset-failed exactly enclave-hcap-ID-* units, then list any that remain (none = clean)
# Capture: read-only preconditions -> `origin` (exact N from the pinned A1 receipt, never the snapshot head) -> `plan` to L1 finalized read
# now -> every `run-segment` in order -> `aggregate` (12 h current-time freshness). Stops at the first refusal; evidence is kept.
# Mounts: NOTHING is mounted in the guest's own mount namespace. Each step is a transient systemd unit with its OWN private mount
# namespace (PrivateMounts=yes, ProtectSystem=strict); the origin unit additionally gets BindReadOnlyPaths=<datadir>, so the datadir is
# a read-only mount only inside that unit and disappears with it. Every unit: User=rpcbase, MemoryMax, MemorySwapMax=0, RuntimeMaxSec.
# MEMORY: MemoryMax / the guest MemAvailable check bound the GUEST only; they do NOT establish the physical host's 16 GiB floor (that is
# the host runner's admission + watchdog). Signals: steps run in the background and are waited on, so INT/TERM/HUP run the trap at once;
# the trap stops exactly this run's units. Never writes the datadir, chain.json or coverageVerified; starts/restarts no service.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
B=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd -P); HC=$B/bin/historical-capture
R=""; RUNAS=rpcbase; MEMINFO=/proc/meminfo
if [ -n "${HCAP_TEST_ROOT:-}" ]; then                    # OFFLINE TESTS ONLY: every override must live under the test's tmp
  for v in "$HCAP_TEST_ROOT" "${HCAP_TEST_BIN:?}"; do [[ $v == /tmp/* || $v == "${TMPDIR:-/nonexistent}"/* ]] || { echo "test override outside tmp" >&2; exit 2; }; done
  R=$HCAP_TEST_ROOT; PATH=$HCAP_TEST_BIN:$PATH; RUNAS=${HCAP_TEST_RUNAS:?}; MEMINFO=$R/proc/meminfo
fi
DATA=$R/srv/enclave-base-holder/data; MOUNTROOT=$R/srv/enclave-base-holder; MARKER=$R/srv/enclave-base-holder/snapshot-complete
BASE_BIN=$R/opt/enclave-rpc/bin/base; BASE_SHA=9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f
KZG=$B/vendor/coverage/kzgcheck; KZG_SHA=00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb
EL=http://127.0.0.1:18645; BEACON=http://127.0.0.1:15052; NODE=/usr/bin/node; MEM=4G; MIN_AVAIL_MIB=8192
EVROOT=$R/var/lib/enclave-rpc/historical-capture
ID_RE='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'

cleanup_units() {  # exact names of one run only; output = units still present after the stop (empty = clean)
  systemctl stop "enclave-hcap-$1-*" 2>/dev/null || true; systemctl reset-failed "enclave-hcap-$1-*" 2>/dev/null || true
  systemctl list-units --all --plain --no-legend "enclave-hcap-$1-*" 2>/dev/null | grep . || true; }
case "${1:-}" in
  --cleanup) [[ ${2:-} =~ $ID_RE ]] || { echo "bad run id" >&2; exit 2; }; left=$(cleanup_units "$2"); [ -z "$left" ] && { echo "clean $2"; exit 0; }
             echo "LEFT: $left"; exit 21 ;;
  --run-id) [[ ${2:-} =~ $ID_RE ]] || { echo "bad run id" >&2; exit 2; }; RUN=$2 ;;
  *) echo "usage: guest-capture.sh --run-id ID | --cleanup ID" >&2; exit 2 ;;
esac
EV=$EVROOT/$RUN; CHILD=""; DONE=0
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$EV/run.log"; }
die() { log "REFUSED: $*"; exit 2; }
on_exit() { local rc=$?; [ $DONE = 1 ] && return; DONE=1
  [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null; left=$(cleanup_units "$RUN")
  [ -n "$left" ] && { log "UNITS LEFT AFTER STOP: $left"; [ $rc = 0 ] && rc=21; }
  log "exit rc=$rc (own units stopped)"; exit $rc; }
trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
step() {  # name net(no|loopback) runtime-max-sec -- historical-capture args
  local n=$1 net=$2 max=$3; shift 4
  local p=(-p "User=$RUNAS" -p "MemoryMax=$MEM" -p MemorySwapMax=0 -p "RuntimeMaxSec=$max" -p NoNewPrivileges=yes -p PrivateMounts=yes
           -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p "ReadWritePaths=$EV" -p "WorkingDirectory=$EV" -p UMask=0077)
  case $net in no) p+=(-p PrivateNetwork=yes);; loopback) p+=(-p IPAddressDeny=any -p IPAddressAllow=localhost);; esac
  [ "$n" = origin ] && p+=(-p "BindReadOnlyPaths=$DATA")
  systemd-run --quiet --wait --pipe --collect --unit "enclave-hcap-$RUN-$n" "${p[@]}" -- "$HC" "$@" >> "$EV/$n.out" 2>&1 & CHILD=$!
  local rc=0; wait "$CHILD" || rc=$?; CHILD=""; cat "$EV/$n.out" >> "$EV/run.log"; tail -c 400 "$EV/$n.out"; return $rc; }

[ "$(id -u)" = 0 ] || { echo "run as root (starts transient rpcbase units)" >&2; exit 2; }
install -d -m 0755 "$EVROOT" && install -d -m 0700 -o "$RUNAS" -g "$RUNAS" "$EV" || exit 2
# ---- preconditions (read-only) ----
"$HC" verify > "$EV/bundle-verify.json" || die "bundle does not verify"
log "run $RUN bundle $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundleId"])' "$EV/bundle-verify.json") at $B"
[ "$(systemctl show -p ActiveState --value enclave-rpc-base-snapshot.service)" = inactive ] \
  && [ "$(systemctl show -p Result --value enclave-rpc-base-snapshot.service)" = success ] || die "snapshot unit is not terminal+success"
[ -e "$MARKER" ] || die "snapshot-complete marker absent"
pgrep -f 'snapshot download' > /dev/null && die "a snapshot download process is running"
for u in enclave-base-holder.service enclave-base-holder.path; do [ "$(systemctl is-active $u || true)" = active ] && die "$u is active"; done
fuser -sm "$MOUNTROOT" && die "a process holds files on $MOUNTROOT (no concurrent reader/writer allowed)"
[ -d "$DATA/db" ] || die "$DATA/db absent"
avail=$(awk '/^MemAvailable:/{print int($2/1024)}' "$MEMINFO"); [ "${avail:-0}" -ge $MIN_AVAIL_MIB ] || die "guest MemAvailable ${avail:-?} MiB < $MIN_AVAIL_MIB (guest-only check)"
nv=$($NODE --version) || die "node absent"; [ "$(echo "${nv#v}" | cut -d. -f1)" -ge 18 ] || die "node $nv < 18"
log "node $nv sha256 $(sha256sum < $NODE | cut -c1-64); python $(python3 --version 2>&1); base pinned $BASE_SHA; kzgcheck $KZG_SHA"
# ---- 1 exact-N origin: datadir read-only ONLY inside the unit's private mount namespace; no network ----
install -d -m 0700 -o "$RUNAS" -g "$RUNAS" "$EV/scratch"
step origin no 3600 -- origin --base-bin "$BASE_BIN" --base-sha256 "$BASE_SHA" --datadir "$DATA" --scratch "$EV/scratch" \
  --receipt "$B/receipt/a1-evidence.json" --node "$NODE" --out "$EV/anchored-origin.json" || die "origin refused (origin.out)"
rm -rf --one-file-system -- "$EV/scratch"
# ---- 2 plan to L1 finalized now ----
fin=$(curl -sS -m 20 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["finalized",false]}' $EL \
      | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["number"],16))') || die "cannot read L1 finalized from $EL"
log "plan: toBlock = L1 finalized $fin"
step plan no 600 -- plan --anchored "$EV/anchored-origin.json" --receipt "$B/receipt/a1-evidence.json" --node "$NODE" --to-block "$fin" \
  --segment-blocks 30000 --out "$EV/plan.json" || die "plan refused (plan.out)"
k=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["segments"]))' "$EV/plan.json")
# ---- 3 segments in order (loopback EL/beacon only) ----
segs=()
for i in $(seq 0 $((k - 1))); do
  log "segment $i/$k"
  step "seg$i" loopback 14400 -- run-segment --plan "$EV/plan.json" --index "$i" --out-dir "$EV/segment-$i" --el $EL --beacon $BEACON \
    --kzg "$KZG" --kzg-sha256 $KZG_SHA --blob-scope batcher || die "segment $i not COVERED (evidence kept in segment-$i)"
  segs+=(--segment "$EV/segment-$i")
done
# ---- 4 aggregate (current-time freshness, re-binds header N) ----
step aggregate no 1800 -- aggregate --plan "$EV/plan.json" --anchored "$EV/anchored-origin.json" --receipt "$B/receipt/a1-evidence.json" \
  --node "$NODE" "${segs[@]}" --out "$EV/aggregate.json" || die "aggregate REFUSED (aggregate.json kept)"
(cd "$EV" && sha256sum anchored-origin.json plan.json aggregate.json segment-*/segment.json segment-*/gate-report.json > EVIDENCE.sha256)
log "COVERED_ALL_SEGMENTS: evidence $EV (root review required; nothing activated, chain.json untouched)"
