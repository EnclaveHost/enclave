#!/usr/bin/env bash
# diagnose-usb-boot.sh -- read-only look at why the USB Windows failed to boot.
# Mounts the Windows partition READ-ONLY, reports crash dumps and the storage
# driver configuration, unmounts. Changes nothing.
set -euo pipefail
DEV="${1:-/dev/sda3}"
MNT=$(mktemp -d)
cleanup() { mountpoint -q "$MNT" && umount "$MNT"; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
modprobe ntfs3 2>/dev/null || true
mount -t ntfs3 -o ro "$DEV" "$MNT" || { echo "could not mount $DEV read-only"; exit 1; }
echo "mounted $DEV read-only at $MNT"
echo

echo "=== did Windows finish setup? ==="
for f in Windows/Panther/setupact.log Windows/Setup/State/State.ini; do
  [ -f "$MNT/$f" ] && echo "  $f present ($(stat -c%s "$MNT/$f") bytes)"
done
[ -d "$MNT/enclave" ] && echo "  C:\\enclave present: $(ls "$MNT/enclave" | tr '\n' ' ')"

echo
echo "=== crash dumps ==="
shopt -s nullglob
DUMPS=("$MNT"/Windows/Minidump/*.dmp "$MNT"/Windows/MEMORY.DMP)
if [ ${#DUMPS[@]} -eq 0 ]; then
  echo "  none -- the crash happened before Windows could write one,"
  echo "  which points at a boot-critical driver failure (INACCESSIBLE_BOOT_DEVICE)"
else
  for d in "${DUMPS[@]}"; do
    echo "  $(basename "$d")  $(stat -c%s "$d") bytes  $(stat -c%y "$d" | cut -d. -f1)"
    # The bugcheck code lives near the start of a minidump header.
    code=$(xxd -s 56 -l 4 -e -g4 "$d" 2>/dev/null | awk '{print $2}')
    [ -n "$code" ] && echo "      bugcheck (offset 0x38): 0x$code"
  done
fi

echo
echo "=== USB storage services: Start value (0 = boot-critical, 3 = demand) ==="
HIVE="$MNT/Windows/System32/config/SYSTEM"
if [ -f "$HIVE" ]; then
  echo "  SYSTEM hive present ($(stat -c%s "$HIVE") bytes)"
  echo "  (parsing needs chntpw/hivex; not installed. The dump above is the better signal.)"
else
  echo "  SYSTEM hive missing -- the image did not transfer correctly"
fi
echo
echo "done; unmounting"
