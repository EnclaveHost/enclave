#!/bin/bash
# host-state-fetch-r3.sh (resumable-state-recovery-stage/r3; PREPARED, never run by Claude). ROOT runs it on the HOST, foreground, through
# the qualified queue in a 256 MiB lane (the queue's memory guard enforces the 16 GiB host floor continuously):
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   jobs/q-exit-status.sh root-host-state-fetch-r3-<n> 256 bash resumable-state-recovery-stage/r3/jobs/host-state-fetch-r3.sh probe --max-hours=1
#   ... after ROOT REVIEWS <work>/probe.json:
#   jobs/q-exit-status.sh root-host-state-fetch-r3-<n> 256 bash resumable-state-recovery-stage/r3/jobs/host-state-fetch-r3.sh fetch \
#       --max-hours=<n> --expect-etag='<reviewed strong ETag incl. quotes>' --expect-last-modified='<reviewed value>' [--reserve-bytes=<>=5e11>]
# Durable: every stop (deadline, INT/TERM/HUP forwarded, queue/memory-guard kill, crash) keeps every committed chunk; rerun continues.
# Only the pinned manifest copy in this stage (sha 1f0c4e6c...) and the pinned URL/total are used; nothing else is downloaded.
# Output: user data ONLY in the private work dir; this job logs the tool's JSON events (offsets, codes) under the stage logs dir.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
WORK=/mnt/usb/enclave-rpc-production/state-recovery-r3
MAN=$S/manifest/base-1792886410-manifest.json MAN_SHA=1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2
URL=https://mainnet-v2-snapshots.base.org/1792886410/state.tar.zst TOTAL=761228785915 OWNER_UID=1000 CURL=/usr/bin/curl
RESERVE=500000000000 FLOOR_MIB=16384 LANE_MIB=256
CMD=${1:-}; shift || true
MAXH= ETAG= LM= LM_SET=0
for a in "$@"; do case "$a" in
  --max-hours=?*) MAXH=${a#*=} ;; --expect-etag=?*) ETAG=${a#*=} ;; --expect-last-modified=*) LM=${a#*=}; LM_SET=1 ;;
  --reserve-bytes=?*) RESERVE=${a#*=} ;; *) echo "usage: $0 probe|fetch --max-hours=<n> [--expect-etag=.. --expect-last-modified=..]"; exit 2;; esac; done
case "$CMD" in probe|fetch) ;; *) echo "REFUSED: probe|fetch required"; exit 2;; esac
[[ "$MAXH" =~ ^[0-9]{1,3}$ ]] && [ "$MAXH" -ge 1 ] || { echo "REFUSED: --max-hours=<1..999> required"; exit 2; }
[[ "$RESERVE" =~ ^[0-9]+$ ]] && [ "$RESERVE" -ge 500000000000 ] || { echo "REFUSED: --reserve-bytes must be >= 500000000000"; exit 2; }
if [ "$CMD" = fetch ]; then [ -n "$ETAG" ] && [ "$LM_SET" = 1 ] || { echo "REFUSED: fetch needs the reviewed --expect-etag and --expect-last-modified"; exit 2; }; fi
OUT=$S/logs/host-$CMD-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$OUT" || exit 9
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$OUT/job.log"; }
die() { log "REFUSED: $*"; exit 9; }
[ "$(id -u)" = "$OWNER_UID" ] || die "run as uid $OWNER_UID (owner of /mnt/usb/enclave-rpc-production); not $(id -u)"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ "$(sha256sum < "$MAN" | cut -c1-64)" = "$MAN_SHA" ] || die "manifest copy is not $MAN_SHA"
[ "$(findmnt -no FSTYPE /mnt/usb 2>/dev/null)" = ntfs3 ] || die "/mnt/usb is not the reviewed ntfs3 mount"
[ "$(stat -c %u /mnt/usb/enclave-rpc-production)" = "$OWNER_UID" ] || die "/mnt/usb/enclave-rpc-production is not owned by $OWNER_UID"
[ -x "$CURL" ] || die "$CURL missing"
a=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo); [ -n "$a" ] && [ "$a" -ge $((FLOOR_MIB + LANE_MIB)) ] || die "host MemAvailable ${a:-?} MiB < floor $FLOOR_MIB + lane $LANE_MIB"
{ "$CURL" -V | head -1; python3 --version; findmnt -no SOURCE,FSTYPE,OPTIONS /mnt/usb; sha256sum < "$S/SHA256SUMS"; echo "MemAvailable_MiB=$a"; } > "$OUT/env.txt" 2>&1
ARGS=(--manifest "$MAN" --manifest-sha256 "$MAN_SHA" --expect-url "$URL" --expect-total "$TOTAL" --work-dir "$WORK" --curl "$CURL"
      --owner-uid "$OWNER_UID" --reserve-bytes "$RESERVE")
[ "$CMD" = fetch ] && ARGS+=(--chunk-bytes 67108864 --expect-etag "$ETAG" --expect-last-modified "$LM")
CHILD=
stop_child() { [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null; }
trap 'log "signal: TERM forwarded (committed chunks are kept)"; stop_child' INT TERM HUP
log "start $CMD max_hours=$MAXH reserve=$RESERVE work=$WORK"
timeout --signal=TERM --kill-after=300 "${MAXH}h" python3 -I "$S/srr3_fetch.py" "$CMD" "${ARGS[@]}" >> "$OUT/events.jsonl" 2>> "$OUT/stderr.txt" < /dev/null &
CHILD=$!
rc=0; while :; do wait "$CHILD"; rc=$?; kill -0 "$CHILD" 2>/dev/null || break; done
CHILD=; tail -3 "$OUT/events.jsonl" | tee -a "$OUT/job.log"
case $rc in 0) log "OK $CMD (a transfer step only; not integrity, not readiness)";; 124|143) log "stopped (deadline/signal): committed progress kept, rerun continues";;
  *) log "tool rc=$rc: see events.jsonl (2 input, 3 ownership, 4 capacity, 5 local state, 6 response refused -> root review, 7 retries)";; esac
log "outputs $OUT"; exit $rc
