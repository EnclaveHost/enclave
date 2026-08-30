#!/usr/bin/env bash
# fix-boot-loop.sh -- offline repair of the looping Windows install.
#
#   sudo ./fix-boot-loop.sh                     # dry run, changes nothing
#   sudo ./fix-boot-loop.sh --apply
#   sudo ./fix-boot-loop.sh --apply --revert-pending    # also clear a stuck update
#   sudo ./fix-boot-loop.sh --restore <backup-dir>      # put everything back
#
# Three in-place DWORD edits to the offline SYSTEM hive:
#
#   CrashControl\AutoReboot                 1 -> 0   purely diagnostic: if this
#       is a bugcheck, the BSOD now STAYS on screen with its stop code instead
#       of resetting instantly. It has no effect on whether Windows boots, so
#       it cannot confuse the result of the other two.
#
#   DeviceGuard\EnableVirtualizationBasedSecurity            1 -> 0
#   DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity\Enabled  1 -> 0
#       Stops the Microsoft hypervisor launching at boot. SEV-SNP is active in
#       firmware and Control\Hypervisor does not exist, so the hypervisor comes
#       up with no SNP-host path while the RMP is enforcing. If that is the
#       fault, Windows boots with these off and SNP still enabled -- which is a
#       far more useful result than toggling RMP off in firmware, because it
#       keeps the thing we actually want to test switched on.
#
# Every edit is inline (data <= 4 bytes lives inside the vk record), so nothing
# is reallocated and the hive's structure is untouched.
set -uo pipefail

WINPART="${1:-}"; [ -n "$WINPART" ] && [ -b "$WINPART" ] || WINPART=/dev/nvme0n1p3
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HP="$HERE/../vmtest/hivepatch.py"
APPLY=0; PENDING=0; RESTORE=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --revert-pending) PENDING=1 ;;
    --restore) RESTORE=PENDING_ARG ;;
    /dev/*) ;;
    *) [ "$RESTORE" = PENDING_ARG ] && RESTORE="$a" ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
[ -f "$HP" ] || die "hivepatch.py not found at $HP"

MNT=$(mktemp -d)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
MODE=ro
[ "$APPLY" = 1 ] && MODE=rw
[ -n "$RESTORE" ] && [ "$RESTORE" != PENDING_ARG ] && MODE=rw
mount -t ntfs3 -o "$MODE" "$WINPART" "$MNT" 2>/dev/null \
  || mount -o "$MODE" "$WINPART" "$MNT" 2>/dev/null \
  || die "could not mount $WINPART $MODE (if it says dirty, boot Windows once or use ntfsfix)"
echo "mounted $WINPART $MODE"

HIVE="$MNT/Windows/System32/config/SYSTEM"
[ -f "$HIVE" ] || HIVE=$(find "$MNT/Windows/System32/config" -maxdepth 1 -iname SYSTEM -type f | head -1)
[ -f "$HIVE" ] || die "SYSTEM hive not found"

if [ -n "$RESTORE" ] && [ "$RESTORE" != PENDING_ARG ]; then
  [ -d "$RESTORE" ] || die "no such backup directory: $RESTORE"
  echo "==> restoring from $RESTORE"
  cp -v "$RESTORE/SYSTEM" "$HIVE" || die "restore failed"
  for l in SYSTEM.LOG1 SYSTEM.LOG2; do
    [ -f "$RESTORE/$l" ] && cp -v "$RESTORE/$l" "$(dirname "$HIVE")/$l"
  done
  sync; echo "restored."; exit 0
fi

echo "==> hive consistency"
python3 "$HP" "$HIVE" check; CLEAN=$?
if [ "$CLEAN" = 3 ]; then
  cat <<'WARN'
    The hive is dirty: Windows was reset before flushing, so SYSTEM.LOG1/LOG2
    hold pages it will replay at next load. This cannot corrupt an in-place
    edit -- replay writes back whole pages of the ORIGINAL data -- but it can
    silently revert one. If a value reads back unchanged after a boot attempt,
    that is why, and the edit simply needs repeating.
WARN
fi

SEL=$(python3 "$HP" "$HIVE" get 'Select' 'Current' 2>/dev/null | grep -oE '[0-9]+$')
CS=$(printf 'ControlSet%03d' "${SEL:-1}")
echo "==> control set in use: $CS"
echo

echo "=== current values ==="
python3 "$HP" "$HIVE" get "$CS\\Control\\CrashControl" AutoReboot
python3 "$HP" "$HIVE" get "$CS\\Control\\DeviceGuard" EnableVirtualizationBasedSecurity
python3 "$HP" "$HIVE" get "$CS\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" Enabled
echo
echo "=== stuck-update marker ==="
if [ -e "$MNT/Windows/WinSxS/pending.xml" ]; then
  echo "  WinSxS\\pending.xml PRESENT ($(stat -c %s "$MNT/Windows/WinSxS/pending.xml") bytes)"
  echo "  -> an update is staged and retrying every boot. Pass --revert-pending to clear it."
else
  echo "  WinSxS\\pending.xml absent -- not an update rollback loop"
fi
echo

if [ "$APPLY" != 1 ]; then
  echo "DRY RUN -- nothing changed.  Re-run with --apply."
  exit 0
fi

BK="/var/tmp/winhive-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp "$HIVE" "$BK/SYSTEM"
for l in SYSTEM.LOG1 SYSTEM.LOG2; do
  [ -f "$(dirname "$HIVE")/$l" ] && cp "$(dirname "$HIVE")/$l" "$BK/$l"
done
echo "==> backed up to $BK  (restore with: sudo $0 --restore $BK)"
echo

echo "==> applying"
python3 "$HP" "$HIVE" set "$CS\\Control\\CrashControl" AutoReboot 0
python3 "$HP" "$HIVE" set "$CS\\Control\\DeviceGuard" EnableVirtualizationBasedSecurity 0
python3 "$HP" "$HIVE" set "$CS\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" Enabled 0

if [ "$PENDING" = 1 ] && [ -e "$MNT/Windows/WinSxS/pending.xml" ]; then
  mv -v "$MNT/Windows/WinSxS/pending.xml" "$BK/pending.xml"
  echo "  moved pending.xml aside (copy kept in $BK)"
fi

echo
echo "=== values now ==="
python3 "$HP" "$HIVE" get "$CS\\Control\\CrashControl" AutoReboot
python3 "$HP" "$HIVE" get "$CS\\Control\\DeviceGuard" EnableVirtualizationBasedSecurity
python3 "$HP" "$HIVE" get "$CS\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" Enabled
sync
echo
cat <<MSG

Done. Reboot and choose Windows Boot Manager.

  boots            -> VBS against the enforcing RMP was the fault. SNP is still
                      enabled in firmware, so the next step is the real test:
                      create Control\\Hypervisor, set EnableHardwareIsolation=1,
                      reboot, and read Get-VMHost SnpStatus.
  BSOD, stays up   -> write down the stop code; AutoReboot=0 is what kept it
                      on screen. That names the fault outright.
  still loops      -> not VBS. Re-run this script; if the values read back as 1
                      the log replay reverted them, which is itself the answer.

Undo everything:  sudo $0 --restore $BK
MSG
