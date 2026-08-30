#!/usr/bin/env bash
# diagnose-windows.sh -- read-only look at why the new Windows install loops.
#
#   sudo ./diagnose-windows.sh
#
# Mounts the Windows partition read-only, decodes any kernel minidump into a
# bugcheck code, and tails the Setup logs.  Writes nothing.
set -uo pipefail

WINPART="${1:-/dev/nvme0n1p3}"
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
[ -b "$WINPART" ] || die "$WINPART is not a block device"

MNT=$(mktemp -d)
cleanup() { umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT

if ! mount -o ro "$WINPART" "$MNT" 2>/dev/null; then
  mount -t ntfs3 -o ro "$WINPART" "$MNT" 2>/dev/null \
    || mount -o ro,remove_hiberfile "$WINPART" "$MNT" \
    || die "could not mount $WINPART read-only"
fi
echo "mounted $WINPART read-only"
echo

echo "=== did the install actually finish? ==="
for d in Windows Windows/System32 Windows/System32/config Users ProgramData; do
  printf '  %-28s %s\n' "$d" "$([ -d "$MNT/$d" ] && echo present || echo MISSING)"
done
echo "  user profiles:"
ls -1 "$MNT/Users" 2>/dev/null | sed 's/^/    /'
echo "  leftover Setup staging (means Setup never completed):"
ls -d "$MNT"/\$WINDOWS.~BT "$MNT"/\$WINDOWS.~WS 2>/dev/null | sed 's/^/    /' || echo "    none -- Setup completed"
echo

echo "=== crash dumps ==="
DUMPS=$(find "$MNT/Windows/Minidump" -iname '*.dmp' 2>/dev/null; ls "$MNT/Windows/MEMORY.DMP" 2>/dev/null)
if [ -z "$DUMPS" ]; then
  echo "  none."
  echo "  No dump means the bugcheck happened before the crash-dump stack was up"
  echo "  (very early boot), or the machine reset without bugchecking at all."
else
  printf '%s\n' "$DUMPS" | sed 's/^/  /'
  printf '%s\n' "$DUMPS" | while read -r f; do
    [ -f "$f" ] || continue
    python3 - "$f" <<'PY'
import struct, sys
BUGCHECKS = {
 0x0000007B: "INACCESSIBLE_BOOT_DEVICE",
 0x0000005C: "HAL_INITIALIZATION_FAILED",
 0x0000005D: "UNSUPPORTED_PROCESSOR",
 0x0000003B: "SYSTEM_SERVICE_EXCEPTION",
 0x0000001E: "KMODE_EXCEPTION_NOT_HANDLED",
 0x0000000A: "IRQL_NOT_LESS_OR_EQUAL",
 0x00000050: "PAGE_FAULT_IN_NONPAGED_AREA",
 0x0000007E: "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED",
 0x000000EF: "CRITICAL_PROCESS_DIED",
 0x00000139: "KERNEL_SECURITY_CHECK_FAILURE",
 0x0000015C: "PDC_WATCHDOG_TIMEOUT",
 0x00000133: "DPC_WATCHDOG_VIOLATION",
 0x000001AA: "HYPERVISOR_ERROR",
 0x00020001: "HYPERVISOR_ERROR",
 0x000000C4: "DRIVER_VERIFIER_DETECTED_VIOLATION",
 0x00000109: "CRITICAL_STRUCTURE_CORRUPTION",
 0x0000018B: "SECURE_KERNEL_ERROR",
 0x000001C8: "SECURE_PCI_CONFIG_SPACE_ACCESS_VIOLATION",
}
p = sys.argv[1]
d = open(p, "rb").read(0x100)
sig = d[:8]
if sig[:8] not in (b"PAGEDU64", b"PAGEDUMP"):
    print(f"    {p}: unrecognized dump signature {sig!r}")
    sys.exit()
code, = struct.unpack_from("<I", d, 0x38)
a, b, c, e = struct.unpack_from("<QQQQ", d, 0x40)
name = BUGCHECKS.get(code, "")
print(f"    bugcheck 0x{code:08X}  {name}")
print(f"      params: 0x{a:X} 0x{b:X} 0x{c:X} 0x{e:X}")
PY
  done
fi
echo

echo "=== Setup errors (setuperr.log, last 40) ==="
tail -40 "$MNT/Windows/Panther/setuperr.log" 2>/dev/null | tr -d '\r' | sed 's/^/  /' || echo "  (none)"
echo
echo "=== Setup actions (setupact.log, last 30) ==="
tail -30 "$MNT/Windows/Panther/setupact.log" 2>/dev/null | tr -d '\r' | sed 's/^/  /' || echo "  (none)"
echo
echo "=== VBS / HVCI policy baked in by Setup ==="
for k in "Windows/System32/config/SYSTEM"; do
  [ -f "$MNT/$k" ] && echo "  SYSTEM hive present ($(stat -c %s "$MNT/$k") bytes)"
done
HP="$(dirname "$0")/../vmtest/hivepatch.py"
if [ -f "$HP" ] && [ -f "$MNT/Windows/System32/config/SYSTEM" ]; then
  cp "$MNT/Windows/System32/config/SYSTEM" /var/tmp/SYSTEM.ro 2>/dev/null && {
    for kv in \
      'ControlSet001\Control\DeviceGuard EnableVirtualizationBasedSecurity' \
      'ControlSet001\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity Enabled' \
      'ControlSet001\Control\Hypervisor EnableHardwareIsolation' ; do
      set -- $kv
      printf '  %-70s ' "$1 $2"
      python3 "$HP" /var/tmp/SYSTEM.ro get "$1" "$2" 2>&1 | tail -1
    done
    rm -f /var/tmp/SYSTEM.ro
  }
fi
