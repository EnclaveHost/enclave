#!/usr/bin/env bash
# diagnose-loop.sh -- separate "stuck update rollback" from "hard reset".
#
#   sudo ./diagnose-loop.sh
#
# Read-only.  Two live hypotheses:
#   A. OOBE installed a zero-day patch, asked for a reboot, and the update
#      fails and rolls back every boot.  Marker: WinSxS\pending.xml.
#   B. VBS starts the Microsoft hypervisor while SEV-SNP is active in firmware
#      and the RMP is enforcing.  A hypervisor triple fault resets the machine
#      with no BSOD and no dump, which matches the total absence of minidumps.
set -uo pipefail

WINPART="${1:-/dev/nvme0n1p3}"
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

MNT=$(mktemp -d)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
mount -o ro "$WINPART" "$MNT" 2>/dev/null || mount -t ntfs3 -o ro "$WINPART" "$MNT" \
  || die "could not mount $WINPART read-only"
W="$MNT/Windows"

echo "=== A. mid-update markers (presence = update rollback loop) ==="
for f in WinSxS/pending.xml WinSxS/pending.xml.bad WinSxS/poqexec.log \
         WinSxS/reboot.xml Setup/State/State.ini; do
  if [ -e "$W/$f" ]; then
    printf '  %-32s PRESENT  %s bytes  %s\n' "$f" \
      "$(stat -c %s "$W/$f")" "$(stat -c %y "$W/$f" | cut -d. -f1)"
  else
    printf '  %-32s absent\n' "$f"
  fi
done
echo
echo "  --- CBS log tail (what the servicing stack last did) ---"
CBS=$(ls -t "$W/Logs/CBS/"CBS*.log 2>/dev/null | head -1)
[ -n "$CBS" ] && tail -25 "$CBS" | tr -d '\r' | sed 's/^/    /' || echo "    (no CBS log)"
echo
echo "  --- poqexec (primitive operation queue = the reboot-time file swaps) ---"
tail -20 "$W/WinSxS/poqexec.log" 2>/dev/null | tr -d '\r' | sed 's/^/    /' || echo "    (none)"
echo

echo "=== B. did anything bugcheck, and did Startup Repair run? ==="
echo "  --- Startup Repair verdict ---"
tail -40 "$W/System32/LogFiles/Srt/SrtTrail.txt" 2>/dev/null | tr -d '\r' | sed 's/^/    /' \
  || echo "    (Startup Repair never ran)"
echo
echo "  --- dumps / live kernel reports ---"
ls -la "$W/MEMORY.DMP" 2>/dev/null | sed 's/^/    /' || echo "    no MEMORY.DMP"
find "$W/Minidump" "$W/LiveKernelReports" -type f 2>/dev/null | sed 's/^/    /' || true
echo
echo "  --- System event log: bugcheck and dirty-shutdown records ---"
EVT="$W/System32/winevt/Logs/System.evtx"
if [ -f "$EVT" ]; then
  echo "    $EVT  $(stat -c %s "$EVT") bytes, modified $(stat -c %y "$EVT" | cut -d. -f1)"
  for m in BugCheck Kernel-Power Kernel-Boot EventLog WER-SystemErrorReporting; do
    n=$(strings -el "$EVT" 2>/dev/null | grep -c "$m" || true)
    printf '      %-28s %s occurrences\n' "$m" "$n"
  done
  echo "    --- bugcheck-adjacent strings ---"
  strings -el "$EVT" 2>/dev/null | grep -iE '0x0000|bugcheck|shut down unexpectedly' \
    | sort -u | head -15 | sed 's/^/      /'
else
  echo "    no System.evtx"
fi
echo

echo "=== how many times has it booted? ==="
strings -el "$W/System32/winevt/Logs/System.evtx" 2>/dev/null \
  | grep -c 'Microsoft-Windows-Kernel-General' | sed 's/^/  Kernel-General records: /'
echo
echo "=== user profiles (did OOBE ever make a real account?) ==="
ls -la "$MNT/Users/" 2>/dev/null | sed 's/^/  /'
