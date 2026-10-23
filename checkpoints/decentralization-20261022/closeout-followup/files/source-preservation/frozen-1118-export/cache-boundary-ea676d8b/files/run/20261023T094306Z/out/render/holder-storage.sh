#!/bin/bash
# Enclave Base holder storage (rendered by holder.py from holder-storage.sh.in; ROOT ONLY; review before use).
# Durable data: ONE new ext4 filesystem inside ONE new image file on the HDD (ORIGIN). Optional cache: dm-cache in
# WRITETHROUGH mode (smq) on two new fixed-size image files on NVMe (CDATA, CMETA). Existing filesystems, partitions and
# mappings are never formatted, changed, adopted or removed unless they are provably this holder's own.
#   create        once, with root's approval: preflight EVERYTHING, then allocate; unwinds only what it created
#   assemble      at boot: attach and map (or adopt an IDENTICAL existing mapping), mount; unwinds only what it did
#   disassemble   at stop: unmount, unmap, detach; stops at the first failure (never detaches under a live user)
#   verify-cap    the shared NVMe cache budget ledger (budget.py verify): this host's reservations charged at their
#                 declared MAXIMA within its fixed share of the 250,000,000,000-byte cap, every present file exactly
#                 bounded and owned, this reservation's files present; exit 3 otherwise
#   cache-loss    holder stopped: unmap, INVALIDATE the cache metadata first, then a read-only check of the origin. Any
#                 later assemble starts from an empty cache. A cache is never reattached after uncached origin access.
set -euo pipefail
umask 077
MECHANISM='dm-cache'
ORIGIN='/usbtest/enclave-base-holder/origin.img'
ORIGIN_BYTES='167772160'
ORIGIN_FREE_MARGIN='0'
MNT='/srv/enclave-base-holder'
DATADIR='/srv/enclave-base-holder/data'
OWNER='enclave-holder'
NAME='enclave-base-holder'
PY='/usr/bin/python3'
BUDGET_TOOL='/src/vendor/holder/budget.py'
LEDGER='/etc/enclave-rpc-cache/nvme-cache-budget.json'
RESERVATION='base-holder-dm-cache'
CDATA='/vmtest/enclave-base-holder-cache/cache-data.img'
CDATA_BYTES='67108864'
CMETA='/vmtest/enclave-base-holder-cache/cache-meta.img'
CMETA_BYTES='16777216'
BLOCK_SECTORS='512'
NVME_FREE_MARGIN='0'
log() { echo "holder-storage: $*" >&2; }
die() { log "$*"; exit 2; }
rot() { lsblk -nso ROTA "$(findmnt -no SOURCE --target "$(dirname "$1")")" | tail -1 | tr -d ' '; }
avail() { df --output=avail -B1 "$(dirname "$1")" | tail -1 | tr -d ' '; }
mm() { lsblk -dno MAJ:MIN "$1" | tr -d ' '; }
loopof() { losetup -j "$1" -O NAME -n | head -1; }          # the loop bound to exactly this backing file, if any
CREATED=(); ATTACHED=(); MAPPED=; MOUNTED=
unwind() {
  local rc=$?
  [ "$rc" -eq 0 ] && return 0
  trap - EXIT
  set +e
  # Ownership alone is not enough: a failed teardown leaves its dependencies live.
  # Preserve the remaining devices/files for recovery and the original failure code.
  if [ -n "$MOUNTED" ] && ! umount "$MNT"; then
    log "cleanup stopped: cannot unmount $MNT; mapping, loops and images kept (original rc=$rc)"
    exit "$rc"
  fi
  if [ -n "$MAPPED" ] && ! dmsetup remove "$NAME"; then
    log "cleanup stopped: cannot remove mapping $NAME; loops and images kept (original rc=$rc)"
    exit "$rc"
  fi
  for l in "${ATTACHED[@]}"; do
    if ! losetup -d "$l"; then
      log "cleanup stopped: cannot detach $l; remaining loops and images kept (original rc=$rc)"
      exit "$rc"
    fi
  done
  for f in "${CREATED[@]}"; do
    if ! rm -f -- "$f"; then
      log "cleanup stopped: cannot remove $f; remaining images kept (original rc=$rc)"
      exit "$rc"
    fi
  done
  log "failed (rc=$rc): undid only what this run created/attached/mapped/mounted"
  exit "$rc"
}
trap unwind EXIT
attach() {   # attach FILE VAR: reuse the loop already bound to FILE, else attach (and own) a new one
  local l; l=$(loopof "$1")
  if [ -z "$l" ]; then l=$(losetup --find --show -- "$1"); ATTACHED+=("$l"); fi
  printf -v "$2" '%s' "$l"
}
expected_table() { echo "0 $(blockdev --getsz "$O") cache $(mm "$M") $(mm "$D") $(mm "$O") $BLOCK_SECTORS 1 writethrough smq 0"; }
cached() { [ "$MECHANISM" = dm-cache ]; }
holder_dev() {   # the device the mount must come from; sets DEV
  if cached; then DEV=/dev/mapper/$NAME; else DEV=$O; fi
}
own_mapping() {  # 0 = absent, 1 = present AND identical to ours; anything else refuses
  dmsetup info "$NAME" >/dev/null 2>&1 || return 0
  local have want; have=$(dmsetup table "$NAME"); want=$(expected_table)
  [ "$have" = "$want" ] || die "mapping $NAME exists but is not this holder's (have: $have; want: $want); leaving it untouched"
  return 1
}

case "${1:-}" in
create)
  # 1. preflight every resource BEFORE allocating anything
  test ! -e "$ORIGIN" || die "$ORIGIN exists: refusing to overwrite or reuse"
  for f in "$ORIGIN" ${CDATA:+"$CDATA"} ${CMETA:+"$CMETA"}; do
    test -d "$(dirname "$f")" || die "$(dirname "$f") does not exist"
  done
  [ "$(rot "$ORIGIN")" = 1 ] || die "origin must be on a rotational (HDD) device"
  [ "$(avail "$ORIGIN")" -ge $(( ORIGIN_BYTES + ORIGIN_FREE_MARGIN )) ] || die "not enough free space for the origin image plus margin"
  if cached; then
    for f in "$CDATA" "$CMETA"; do [ "$(rot "$f")" = 0 ] || die "$f must be on NVMe (non-rotational)"; done
    [ "$(avail "$CDATA")" -ge $(( CDATA_BYTES + CMETA_BYTES + NVME_FREE_MARGIN )) ] || die "not enough NVMe free space for the cache plus margin"
    # the ledger reservation must exist for THIS host and name exactly these files and sizes; present cache files must
    # be this reservation's own (an interrupted earlier create is adopted, never granted twice)
    "$PY" -I "$BUDGET_TOOL" admit "$LEDGER" "$RESERVATION" "$CDATA=$CDATA_BYTES" "$CMETA=$CMETA_BYTES" \
      || die "NVMe cache budget reservation refused"
  fi
  # 2. allocate, tracking ownership for unwind
  CREATED+=("$ORIGIN"); fallocate -l "$ORIGIN_BYTES" -- "$ORIGIN"
  attach "$ORIGIN" O
  mkfs.ext4 -q -L enclave-holder -E lazy_itable_init=0,lazy_journal_init=0 "$O"   # NEW filesystem in the NEW image
  if cached; then
    ALLOC=$("$PY" -I "$BUDGET_TOOL" allocate "$LEDGER" "$RESERVATION") || die "NVMe cache budget allocation refused"
    while read -r w p; do [ "$w" = created ] && CREATED+=("$p"); done <<< "$ALLOC"
    dd if=/dev/zero of="$CMETA" bs=1M count=8 conv=notrunc,fsync status=none   # zeroed: dm-cache formats an empty cache
  fi
  losetup -d "$O"; ATTACHED=()
  CREATED=()
  log "created (not assembled)"
  ;;
assemble)
  modprobe loop
  test -f "$ORIGIN" || die "origin image missing"
  if cached; then modprobe dm-cache; modprobe dm-cache-smq; test -f "$CDATA" && test -f "$CMETA" || die "cache images missing"; fi
  attach "$ORIGIN" O
  if cached; then
    "$PY" -I "$BUDGET_TOOL" verify "$LEDGER" "$RESERVATION" >/dev/null || die "NVMe cache budget verification failed"
    attach "$CDATA" D; attach "$CMETA" M
    if own_mapping; then
      [ -z "$(lsblk -nro MOUNTPOINTS "$O" | tr -d '[:space:]')" ] || die "origin is mounted WITHOUT the cache: run cache-loss first (stale-cache hazard)"
      dmsetup create "$NAME" --table "$(expected_table)"; MAPPED=1
    fi
    dmsetup status "$NAME" | grep -qw writethrough || die "mapping $NAME is not writethrough"
  fi
  holder_dev
  mkdir -p "$MNT"
  if findmnt -n "$MNT" >/dev/null; then
    [ "$(findmnt -no MAJ:MIN "$MNT" | tr -d ' ')" = "$(mm "$DEV")" ] || die "$MNT is mounted from another device; leaving it"
  else
    mount -o noatime,nodev,nosuid "$DEV" "$MNT"; MOUNTED=1
  fi
  chown "$OWNER:$OWNER" "$MNT"; chmod 0700 "$MNT"
  for d in "$DATADIR" "$MNT/tmp"; do mkdir -p "$d"; chown "$OWNER:$OWNER" "$d"; chmod 0700 "$d"; done
  ATTACHED=(); MAPPED=; MOUNTED=
  log "assembled: $DEV on $MNT"
  ;;
disassemble)
  trap - EXIT
  # Validate the complete ownership chain BEFORE the first destructive action.
  # A configured path alone does not identify the filesystem mounted there.
  O=$(loopof "$ORIGIN")
  DEV=; REMOVE_MAPPING=
  if cached && dmsetup info "$NAME" >/dev/null 2>&1; then
    D=$(loopof "$CDATA"); M=$(loopof "$CMETA")
    [ -n "$O" ] && [ -n "$D" ] && [ -n "$M" ] || die "mapping $NAME exists but its loops are not ours: leaving it"
    [ "$(dmsetup table "$NAME")" = "$(expected_table)" ] || die "mapping $NAME is not this holder's: leaving it"
    DEV=/dev/mapper/$NAME; REMOVE_MAPPING=1
  elif ! cached; then
    DEV=$O
  fi
  if findmnt -n "$MNT" >/dev/null; then
    [ -n "$DEV" ] || die "$MNT is mounted but this holder's device is absent: leaving it"
    [ "$(findmnt -no MAJ:MIN "$MNT" | tr -d ' ')" = "$(mm "$DEV")" ] || die "$MNT is mounted from another device; leaving it"
    umount "$MNT" || die "unmount of $MNT failed: stopping (nothing detached)"
  fi
  if [ -n "$REMOVE_MAPPING" ]; then
    dmsetup remove "$NAME" || die "dmsetup remove $NAME failed: stopping (loops kept)"
  fi
  for f in ${CMETA:+"$CMETA"} ${CDATA:+"$CDATA"} "$ORIGIN"; do
    l=$(loopof "$f"); [ -z "$l" ] || losetup -d "$l" || die "detach of $l ($f) failed"
  done
  log "disassembled"
  ;;
verify-cap)
  trap - EXIT
  if cached; then exec "$PY" -I "$BUDGET_TOOL" verify "$LEDGER" "$RESERVATION"; fi
  echo '{"cache": "none", "nvmeBytes": 0}'
  ;;
cache-loss)
  cached || die "no cache configured"
  ! findmnt -n "$MNT" >/dev/null || die "$MNT is mounted: stop the holder and run disassemble first"
  O=$(loopof "$ORIGIN"); [ -n "$O" ] || attach "$ORIGIN" O
  if dmsetup info "$NAME" >/dev/null 2>&1; then
    D=$(loopof "$CDATA"); M=$(loopof "$CMETA")
    [ -n "$D" ] && [ -n "$M" ] && [ "$(dmsetup table "$NAME")" = "$(expected_table)" ] || die "mapping $NAME is not this holder's: leaving it"
    dmsetup remove "$NAME" || die "dmsetup remove failed"
  fi
  # INVALIDATE before the origin is touched: writethrough means no dirty blocks, so nothing is lost
  dd if=/dev/zero of="$CMETA" bs=1M count=8 conv=notrunc,fsync status=none
  e2fsck -fn "$O"
  ATTACHED=()
  log "cache invalidated (metadata zeroed); origin checked without it; the next assemble starts with an EMPTY cache"
  ;;
*) echo "usage: $0 create|assemble|disassemble|verify-cap|cache-loss" >&2; trap - EXIT; exit 64;;
esac
