#!/usr/bin/env bash
# diagnose-oobe.sh -- why does the fresh install loop before finishing OOBE?
#
#   sudo ./diagnose-oobe.sh
#
# Read-only.  'defaultuser0' with no real profile means Setup got to OOBE and
# never completed it, which is a specialize/OOBE restart loop rather than a
# kernel bugcheck.  The evidence lives in Panther\UnattendGC and in the Setup
# key of the SYSTEM hive.
set -uo pipefail

WINPART="${1:-/dev/nvme0n1p3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HP="$HERE/../vmtest/hivepatch.py"
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

MNT=$(mktemp -d)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
mount -o ro "$WINPART" "$MNT" 2>/dev/null || mount -t ntfs3 -o ro "$WINPART" "$MNT" \
  || die "could not mount $WINPART read-only"
echo "mounted $WINPART read-only"; echo

echo "=== Panther directory (which run wrote what) ==="
ls -la --time-style=+'%m-%d %H:%M' "$MNT/Windows/Panther/" 2>/dev/null | sed 's/^/  /'
echo
ls -la --time-style=+'%m-%d %H:%M' "$MNT/Windows/Panther/UnattendGC/" 2>/dev/null | sed 's/^/  /' \
  || echo "  (no UnattendGC directory)"
echo

echo "=== OOBE log: Panther\\UnattendGC\\setupact.log (last 60) ==="
tail -60 "$MNT/Windows/Panther/UnattendGC/setupact.log" 2>/dev/null | tr -d '\r' | sed 's/^/  /' \
  || echo "  (not present)"
echo
echo "=== OOBE errors: Panther\\UnattendGC\\setuperr.log ==="
tail -30 "$MNT/Windows/Panther/UnattendGC/setuperr.log" 2>/dev/null | tr -d '\r' | sed 's/^/  /' \
  || echo "  (not present)"
echo

echo "=== every distinct error line in Panther\\setupact.log ==="
grep -ah 'Error' "$MNT/Windows/Panther/setupact.log" 2>/dev/null \
  | tr -d '\r' | sed 's/[0-9]\{4\}-[0-9-]* [0-9:]*, //' | sort -u | head -40 | sed 's/^/  /'
echo

echo "=== SYSTEM hive: the Setup key ==="
HIVE=$(find "$MNT/Windows/System32/config" -maxdepth 1 -iname 'SYSTEM' -type f 2>/dev/null | head -1)
if [ -z "$HIVE" ]; then
  echo "  SYSTEM hive not found under $MNT/Windows/System32/config"
  ls -la "$MNT/Windows/System32/config/" 2>/dev/null | sed 's/^/    /'
else
  echo "  hive: $HIVE ($(stat -c %s "$HIVE") bytes)"
  cp "$HIVE" /var/tmp/SYSTEM.ro || die "could not copy the hive"
  for k in 'Setup' 'Setup\Status' 'Setup\Status\ChildCompletion' 'Setup\Status\SysprepStatus'; do
    python3 "$HP" /var/tmp/SYSTEM.ro dump "$k" 2>&1 | sed 's/^/  /'
    echo
  done
  echo "  --- control set / VBS ---"
  SEL=$(python3 "$HP" /var/tmp/SYSTEM.ro get 'Select' 'Current' 2>/dev/null | grep -o '[0-9]*$')
  CS=$(printf 'ControlSet%03d' "${SEL:-1}")
  echo "  using $CS"
  for kv in \
    "$CS\\Control\\DeviceGuard" \
    "$CS\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" \
    "$CS\\Control\\Hypervisor" ; do
    python3 "$HP" /var/tmp/SYSTEM.ro dump "$kv" 2>&1 | sed 's/^/  /'
  done
  rm -f /var/tmp/SYSTEM.ro
fi
