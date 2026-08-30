#!/usr/bin/env bash
# nvidia-driver-toggle.sh -- stop/start the NVIDIA display driver offline.
#
#   sudo ./nvidia-driver-toggle.sh                    # show state, change nothing
#   sudo ./nvidia-driver-toggle.sh --disable [--fix-dirty]
#   sudo ./nvidia-driver-toggle.sh --enable
#
# The display dies when the NVIDIA driver initialises, which leaves Windows
# unusable rather than merely ugly.  Setting the kernel display driver's
# service to Start=4 (disabled) makes Windows fall back to Microsoft Basic
# Display: low resolution, but stable and enough to work in.
#
# Start values: 0 boot, 1 system, 2 auto, 3 demand, 4 disabled.  The original
# is recorded next to the hive backup so --enable restores the exact value
# rather than guessing.
set -uo pipefail

WINPART=/dev/nvme0n1p3
SERVICE=nvlddmkm
STATEFILE=/var/tmp/nvidia-start-value
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HP="$HERE/../vmtest/hivepatch.py"
. "$HERE/_ntfs.sh"

ACTION=show; FIXDIRTY=0
for a in "$@"; do
  case "$a" in
    --disable) ACTION=disable ;;
    --enable)  ACTION=enable ;;
    --fix-dirty) FIXDIRTY=1 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

MNT=$(mktemp -d)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
MODE=ro; [ "$ACTION" != show ] && MODE=rw
ntfs_mount "$WINPART" "$MNT" "$MODE" "$FIXDIRTY" || exit 1

HIVE="$MNT/Windows/System32/config/SYSTEM"
[ -f "$HIVE" ] || HIVE=$(find "$MNT/Windows/System32/config" -maxdepth 1 -iname SYSTEM -type f | head -1)
[ -f "$HIVE" ] || die "SYSTEM hive not found"
python3 "$HP" "$HIVE" check

SEL=$(python3 "$HP" "$HIVE" get 'Select' 'Current' 2>/dev/null | grep -oE '[0-9]+$')
CS=$(printf 'ControlSet%03d' "${SEL:-1}")
echo "  control set: $CS"
echo

echo "=== NVIDIA-related services present in the hive ==="
python3 - "$HP" "$HIVE" "$CS" <<'PY'
import sys, importlib.util
spec = importlib.util.spec_from_file_location("hp", sys.argv[1])
hp = importlib.util.module_from_spec(spec); spec.loader.exec_module(hp)
h = hp.Hive(sys.argv[2]); cs = sys.argv[3]
svc = h.find_key(f'{cs}\\Services')
if not svc:
    print('  Services key not found'); raise SystemExit
found = 0
for off in h.subkey_offsets(svc):
    nk, _ = h.cell(off)
    name = h.nk_name(nk)
    if not name.lower().startswith('nv'):
        continue
    vk = h.find_value(nk, 'Start')
    start = h.read_value(vk)[1] if vk else '-'
    img = h.find_value(nk, 'ImagePath')
    ip = h.read_value(img)[1] if img else ''
    print(f'  {name:<34} Start={start}  {ip}')
    found += 1
if not found:
    print('  no nv* services -- the driver never finished installing')
PY
echo

echo "=== driver files on disk ==="
ls -la "$MNT/Windows/System32/drivers/nvlddmkm.sys" 2>/dev/null | sed 's/^/  /' \
  || echo "  nvlddmkm.sys absent"
echo "  DriverStore nv* packages: $(find "$MNT/Windows/System32/DriverStore/FileRepository" -maxdepth 1 -iname 'nv*' 2>/dev/null | wc -l)"
echo

echo "=== recent crash dumps (is it bugchecking now?) ==="
find "$MNT/Windows/Minidump" -iname '*.dmp' 2>/dev/null | sed 's/^/  /' || true
[ -f "$MNT/Windows/MEMORY.DMP" ] && ls -la "$MNT/Windows/MEMORY.DMP" | sed 's/^/  /'
find "$MNT/Windows/Minidump" -iname '*.dmp' 2>/dev/null | grep -q . || echo "  none"
echo

[ "$ACTION" = show ] && { echo "Nothing changed.  Use --disable or --enable."; exit 0; }

SYS="$MNT/Windows/System32/drivers/nvlddmkm.sys"
BK="/var/tmp/winhive-nv-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"; cp "$HIVE" "$BK/SYSTEM"
echo "  hive backed up to $BK"
CUR=$(python3 "$HP" "$HIVE" get "$CS\\Services\\$SERVICE" Start 2>&1 | grep -oE '[0-9]+$')

if [ "$ACTION" = disable ]; then
  # Two independent levers. The registry edit is the clean one, but a hive
  # Windows never flushed can replay its logs and revert it. Renaming the
  # binary cannot be undone by log replay, so do both.
  if [ -n "$CUR" ]; then
    echo "$CUR" > "$STATEFILE"
    echo "  recorded original Start=$CUR in $STATEFILE"
    python3 "$HP" "$HIVE" set "$CS\\Services\\$SERVICE" Start 4
  else
    echo "  no $SERVICE service in the hive -- the install never registered one"
  fi
  if [ -f "$SYS" ]; then
    mv -v "$SYS" "$SYS.disabled" | sed 's/^/  /'
    echo "  nvlddmkm.sys renamed; Windows falls back to Microsoft Basic Display"
  else
    echo "  nvlddmkm.sys not present -- nothing to rename"
  fi
  echo
  echo "A display miniport that fails to load is not fatal: only BOOT_START"
  echo "drivers bugcheck when missing, and this is not one. Expect low"
  echo "resolution and a stable desktop."
else
  WANT=$(cat "$STATEFILE" 2>/dev/null || echo 1)
  [ -n "$CUR" ] && python3 "$HP" "$HIVE" set "$CS\\Services\\$SERVICE" Start "$WANT"
  [ -f "$SYS.disabled" ] && mv -v "$SYS.disabled" "$SYS" | sed 's/^/  /'
  echo
  echo "Restored (Start=$WANT, driver binary back in place)."
fi
sync
