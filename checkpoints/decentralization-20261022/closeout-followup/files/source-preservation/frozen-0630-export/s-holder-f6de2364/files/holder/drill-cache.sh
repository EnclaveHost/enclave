#!/bin/bash
# ROOT-ONLY boundary drill for the holder's cache mechanism, on SMALL scratch images (it never touches holder data).
# It uses the same dm-cache table line holder-storage.sh renders: "cache META DATA ORIGIN BLOCK 1 writethrough smq 0".
# It proves, before any real activation:
#   1. bounded NVMe use: the cache files' ALLOCATED bytes do not change while 3x the cache size is written through it;
#   2. eviction: dm-cache's used blocks stay <= its total blocks;
#   3. cache loss: after the cache is removed, the HDD origin alone fscks clean and returns every byte (sha256).
# Usage: drill-cache.sh NVME_SCRATCH_DIR HDD_SCRATCH_DIR   (two NEW empty directories; both are removed at the end)
# Sizes: cache data 1 GiB + metadata 64 MiB on NVMe (far below the 250,000,000,000-byte cap); origin 8 GiB on HDD.
set -euo pipefail
umask 077
NV=${1:?nvme scratch dir}; HD=${2:?hdd scratch dir}
for d in "$NV" "$HD"; do test -d "$d" && test -z "$(ls -A "$d")" || { echo "$d must be an existing EMPTY directory" >&2; exit 2; }; done
rot() { lsblk -nso ROTA "$(findmnt -no SOURCE --target "$1")" | tail -1 | tr -d ' '; }
[ "$(rot "$NV")" = 0 ] && [ "$(rot "$HD")" = 1 ] || { echo "NVMe dir must be non-rotational and HDD dir rotational" >&2; exit 2; }
NAME=enclave-holder-drill-$$; MNT=$(mktemp -d)
CD=$NV/cache-data.img; CM=$NV/cache-meta.img; OR=$HD/origin.img
cleanup() { set +e; umount "$MNT" 2>/dev/null; dmsetup remove "$NAME" 2>/dev/null
  for f in "$CD" "$CM" "$OR"; do L=$(losetup -j "$f" -O NAME -n | head -1); [ -z "$L" ] || losetup -d "$L"; done
  rm -f "$CD" "$CM" "$OR" "$HD/sums"; rmdir "$MNT"; }
trap cleanup EXIT
alloc() { echo $(( $(stat -c %b "$1") * 512 )); }
modprobe loop; modprobe dm-cache; modprobe dm-cache-smq
fallocate -l 1G "$CD"; fallocate -l 64M "$CM"; fallocate -l 8G "$OR"
dd if=/dev/zero of="$CM" bs=1M count=8 conv=notrunc,fsync status=none
A0=$(( $(alloc "$CD") + $(alloc "$CM") ))
D=$(losetup --find --show "$CD"); M=$(losetup --find --show "$CM"); O=$(losetup --find --show "$OR")
mkfs.ext4 -q "$O"
dmsetup create "$NAME" --table "0 $(blockdev --getsz "$O") cache $M $D $O 512 1 writethrough smq 0"
mount /dev/mapper/$NAME "$MNT"
for i in 1 2 3; do head -c 1G /dev/urandom > "$MNT/f$i"; done   # 3 GiB through a 1 GiB cache
( cd "$MNT" && sha256sum f1 f2 f3 > "$HD/sums" ); sync
STATUS=$(dmsetup status "$NAME"); echo "status: $STATUS"
# cache status fields: ... <cache block size> <used cache blocks>/<total cache blocks> ...
read -r USED TOTAL < <(echo "$STATUS" | awk '{split($7,a,"/"); print a[1], a[2]}')
A1=$(( $(alloc "$CD") + $(alloc "$CM") ))
echo "nvmeAllocatedBefore=$A0 nvmeAllocatedAfter=$A1 usedBlocks=$USED totalBlocks=$TOTAL"
[ "$A1" -eq "$A0" ] || { echo "FAIL: NVMe allocation grew" >&2; exit 3; }
[ "$USED" -le "$TOTAL" ] || { echo "FAIL: cache used > total" >&2; exit 3; }
echo "$STATUS" | grep -qw writethrough || { echo "FAIL: not writethrough" >&2; exit 3; }
umount "$MNT"; dmsetup remove "$NAME"                    # cache loss: the NVMe images are now ignored
dd if=/dev/zero of="$CM" bs=1M count=8 conv=notrunc,fsync status=none   # invalidate BEFORE the origin is touched (the protocol)
e2fsck -fn "$O"
mount -o ro "$O" "$MNT"; ( cd "$MNT" && sha256sum -c "$HD/sums" ); umount "$MNT"; rm -f "$HD/sums"
echo "DRILL PASS: bounded NVMe allocation, eviction, and origin complete without the cache"
