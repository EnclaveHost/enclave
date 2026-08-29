#!/usr/bin/env bash
# shrink-vm.sh -- free space at the end of nvme0n1 for a Windows partition.
#
#   sudo ./shrink-vm.sh                 # dry run: print every computed number
#   sudo ./shrink-vm.sh --apply         # actually do it
#   sudo ./shrink-vm.sh --free-gib 128 --apply
#
# nvme0n1 is one LUKS partition holding /vm.  Three nested things have to
# shrink, innermost first: the ext4 filesystem, then the dm-crypt mapping,
# then the GPT partition.  Nothing on nvme1n1 (/, /boot, swap) is touched.
set -euo pipefail

DISK=/dev/nvme0n1
PART=/dev/nvme0n1p1
PARTNUM=1
MAPNAME=cryptvm
MAPDEV=/dev/mapper/cryptvm
MNT=/vm
FREE_GIB=250
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --free-gib) FREE_GIB="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
rule() { printf '%s\n' "----------------------------------------------------------------"; }

[ "$(id -u)" = 0 ] || die "must run as root"

# ---- verify we are looking at what we think we are looking at -------------
[ -b "$PART" ] || die "$PART is not a block device"
[ -b "$MAPDEV" ] || die "$MAPDEV is not open"
[ "$(lsblk -nro FSTYPE "$PART" | head -1)" = crypto_LUKS ] || die "$PART is not LUKS"
[ "$(cryptsetup status "$MAPNAME" | awk '/device:/{print $2}')" = "$PART" ] \
  || die "$MAPNAME is not backed by $PART -- refusing"
mountpoint -q "$MNT" || die "$MNT is not mounted; expected it mounted so we can check the filesystem"
[ "$(findmnt -nro SOURCE "$MNT")" = "$MAPDEV" ] || die "$MNT is not $MAPDEV"

# Nothing but the kernel may be holding the mount.
HOLDERS="$(fuser -m "$MNT" 2>/dev/null | tr -s ' ' || true)"
[ -z "$HOLDERS" ] || die "processes are using $MNT (pids:$HOLDERS) -- stop them first"

# ---- sector arithmetic ----------------------------------------------------
SECT=512
DISK_SECTORS=$(cat /sys/class/block/$(basename $DISK)/size)
PART_START=$(cat /sys/class/block/$(basename $PART)/start)
PART_SECTORS=$(cat /sys/class/block/$(basename $PART)/size)
CRYPT_SECTORS=$(blockdev --getsz "$MAPDEV")
LUKS_OFFSET=$((PART_SECTORS - CRYPT_SECTORS))

FREE_SECTORS=$((FREE_GIB * 1024 * 1024 * 1024 / SECT))
ALIGN=2048                                  # 1 MiB
NEW_PART_SECTORS=$(( (PART_SECTORS - FREE_SECTORS) / ALIGN * ALIGN ))
NEW_CRYPT_SECTORS=$((NEW_PART_SECTORS - LUKS_OFFSET))

BLKSZ=$(dumpe2fs -h "$MAPDEV" 2>/dev/null | awk -F': *' '/^Block size/{print $2}')
[ -n "$BLKSZ" ] || die "could not read the ext4 block size from $MAPDEV"
FS_BLOCKS=$(dumpe2fs -h "$MAPDEV" 2>/dev/null | awk -F': *' '/^Block count/{print $2}')
FS_FREE=$(dumpe2fs -h "$MAPDEV" 2>/dev/null | awk -F': *' '/^Free blocks/{print $2}')
FS_USED=$((FS_BLOCKS - FS_FREE))

# Shrink the filesystem with a 256 MiB margin, then grow it to fill afterwards.
# That way a one-sector error in the crypt/partition math cannot truncate it.
MARGIN_BLOCKS=$((256 * 1024 * 1024 / BLKSZ))
FIT_BLOCKS=$((NEW_CRYPT_SECTORS * SECT / BLKSZ))
TARGET_BLOCKS=$((FIT_BLOCKS - MARGIN_BLOCKS))

NEW_PART_END=$((PART_START + NEW_PART_SECTORS - 1))
TAIL_START=$((NEW_PART_END + 1))
TAIL_SECTORS=$((DISK_SECTORS - 34 - TAIL_START + 1))

h() { numfmt --to=iec --suffix=B "$(($1))"; }

rule
say "disk            $DISK  $(h $((DISK_SECTORS*SECT)))   ($DISK_SECTORS sectors)"
say "partition       $PART  start=$PART_START  size=$PART_SECTORS  ($(h $((PART_SECTORS*SECT))))"
say "LUKS header     $LUKS_OFFSET sectors ($(h $((LUKS_OFFSET*SECT))))"
say "mapping         $MAPDEV  $CRYPT_SECTORS sectors  ($(h $((CRYPT_SECTORS*SECT))))"
say "filesystem      ${BLKSZ}B blocks, $FS_BLOCKS total, $FS_USED used ($(h $((FS_USED*BLKSZ))))"
rule
say "requested free  ${FREE_GIB} GiB"
say ""
say "  1. resize2fs  $MAPDEV  ->  $TARGET_BLOCKS blocks   ($(h $((TARGET_BLOCKS*BLKSZ))))"
say "  2. cryptsetup resize $MAPNAME --size $NEW_CRYPT_SECTORS   ($(h $((NEW_CRYPT_SECTORS*SECT))))"
say "  3. sfdisk -N $PARTNUM  size=$NEW_PART_SECTORS            ($(h $((NEW_PART_SECTORS*SECT))))"
say "  4. resize2fs  $MAPDEV                                   (grow to fill)"
say ""
say "left unallocated at the end of $DISK:"
say "     sectors $TAIL_START .. $((DISK_SECTORS-34))   =  $(h $((TAIL_SECTORS*SECT)))"
rule

# ---- sanity gates ---------------------------------------------------------
[ "$TARGET_BLOCKS" -gt "$FS_USED" ] || die "filesystem is too full to shrink that far"
[ "$NEW_PART_SECTORS" -gt 0 ] && [ "$NEW_CRYPT_SECTORS" -gt 0 ] || die "computed a nonsense size"
[ "$TAIL_SECTORS" -gt $((64 * 1024 * 1024 * 1024 / SECT)) ] || die "tail would be under 64 GiB"
USED_PCT=$((FS_USED * 100 / TARGET_BLOCKS))
[ "$USED_PCT" -lt 90 ] || die "filesystem would end up ${USED_PCT}% full"
say "checks passed: filesystem would be ${USED_PCT}% full afterwards"

if [ "$APPLY" != 1 ]; then
  say ""
  say "DRY RUN -- nothing changed.  Re-run with --apply to execute."
  exit 0
fi

# ---- do it ----------------------------------------------------------------
say ""
say "==> unmounting $MNT"
umount "$MNT"

say "==> fsck (this is the safety net; it must pass)"
e2fsck -f -y "$MAPDEV"

say "==> shrinking filesystem to $TARGET_BLOCKS blocks"
resize2fs "$MAPDEV" "$TARGET_BLOCKS"

say "==> shrinking mapping to $NEW_CRYPT_SECTORS sectors"
cryptsetup resize "$MAPNAME" --size "$NEW_CRYPT_SECTORS"
NOW=$(blockdev --getsz "$MAPDEV")
[ "$NOW" = "$NEW_CRYPT_SECTORS" ] || die "mapping is $NOW sectors, expected $NEW_CRYPT_SECTORS"

say "==> shrinking partition $PART to $NEW_PART_SECTORS sectors"
echo "size=$NEW_PART_SECTORS" | sfdisk --no-reread --no-tell-kernel -N "$PARTNUM" "$DISK"
partx -u "$DISK" || true
sleep 1
NOWP=$(cat /sys/class/block/$(basename $PART)/size)
[ "$NOWP" = "$NEW_PART_SECTORS" ] || say "note: kernel still reports $NOWP sectors for $PART (refresh happens at reboot; harmless)"

say "==> growing filesystem to fill the mapping"
resize2fs "$MAPDEV"

say "==> remounting $MNT"
mount "$MNT"

rule
say "done."
sfdisk -l "$DISK"
say ""
df -hT "$MNT"
say ""
say "Free space now available for Windows:"
sfdisk -F "$DISK"
