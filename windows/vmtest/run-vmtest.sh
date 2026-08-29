#!/usr/bin/env bash
# run-vmtest.sh -- unattended Windows 11 VBS dry run for the Enclave probe.
#
# Builds an answer ISO (autounattend.xml + stage2.ps1 + the probe), creates a
# disk, and boots a Windows 11 installer ISO with no interaction. The guest
# installs Windows, enables Hyper-V, reboots, runs
#
#     Test-EnclaveHost.ps1 -Attempt -IsolationType VBS
#
# and streams the transcript out COM1, which lands in $OUT/serial.log. Then it
# powers off.
#
# WHAT THIS PROVES: whether vmms accepts a custom IGVM (FirmwareFile +
# GuestFeatureSet) on a VM created with an isolation type. That is the same
# ModifySystemSettings acceptance path SNP uses.
#
# WHAT IT DOES NOT PROVE: anything about security. VBS leaves guest DRAM in
# plaintext; it is a harness, not a configuration. And it does not prove SNP
# will be accepted -- vmms could gate FirmwareFile per isolation type.
#
# NESTING CAVEAT: this runs Hyper-V inside KVM (L0 KVM, L1 Windows, L2 the
# isolated VM). Nested virt is exposed via -cpu host, but a FAILURE here is
# ambiguous: it may be the nesting rather than the mechanism. A PASS is
# unambiguous and is the point. Bare-metal Windows is better if available.
#
# Usage:
#   ./run-vmtest.sh --iso /path/to/Win11_24H2_English_x64.iso [--ram 8 --cpus 4]
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/../probe/Test-EnclaveHost.ps1"
OUT="${OUT:-$HERE/run}"
ISO=""
RAM_GB=8
CPUS=4
DISK_GB=64

while [ $# -gt 0 ]; do
  case "$1" in
    --iso)   ISO="$2"; shift 2 ;;
    --ram)   RAM_GB="$2"; shift 2 ;;
    --cpus)  CPUS="$2"; shift 2 ;;
    --disk)  DISK_GB="$2"; shift 2 ;;
    --out)   OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

[ -n "$ISO" ] || die "--iso is required (Windows 11 24H2 x64 installer ISO; see README.md)"
[ -f "$ISO" ] || die "ISO not found: $ISO"
[ -f "$PROBE" ] || die "probe not found: $PROBE"
[ -e /dev/kvm ] || die "/dev/kvm missing"
command -v qemu-system-x86_64 >/dev/null || die "qemu-system-x86_64 not found"
command -v xorriso >/dev/null || die "xorriso not found (needed to build the answer ISO)"
command -v 7z >/dev/null || die "7z not found (needed to repack the installer ISO without the boot prompt)"

# Nested virtualisation must be on, or Hyper-V will not start in the guest.
NESTED="$(cat /sys/module/kvm_amd/parameters/nested 2>/dev/null || cat /sys/module/kvm_intel/parameters/nested 2>/dev/null || echo 0)"
case "$NESTED" in
  1|Y|y) ;;
  *) die "nested virtualisation is off (kvm_*.nested=$NESTED). Hyper-V cannot run in the guest. Enable it and reload the kvm module." ;;
esac

OVMF_CODE=""
OVMF_VARS=""
for c in /usr/share/edk2/x64/OVMF_CODE.4m.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/edk2-ovmf/x64/OVMF_CODE.fd; do
  [ -f "$c" ] && { OVMF_CODE="$c"; break; }
done
for v in /usr/share/edk2/x64/OVMF_VARS.4m.fd /usr/share/OVMF/OVMF_VARS.fd /usr/share/edk2-ovmf/x64/OVMF_VARS.fd; do
  [ -f "$v" ] && { OVMF_VARS="$v"; break; }
done
[ -n "$OVMF_CODE" ] || die "no OVMF_CODE firmware found (UEFI is required for Windows 11)"
[ -n "$OVMF_VARS" ] || die "no OVMF_VARS template found"

mkdir -p "$OUT"

DISK="$OUT/win11.qcow2"
VARS="$OUT/OVMF_VARS.fd"
ANSWER="$OUT/answer.iso"
SERIAL="$OUT/serial.log"

# ---------------------------------------------------------------------------
# Windows install media stops at "Press any key to boot from CD or DVD" and
# times out headless -- BdsDxe then reports
#   failed to start Boot0002 "UEFI QEMU DVD-ROM": Time out
# and gives up. The prompt lives in cdboot.efi, which is what efisys.bin (the
# El Torito UEFI boot image) embeds. Microsoft ships efisys_noprompt.bin beside
# it for exactly this case, so repack the ISO with that as the boot image.
#
# Cached: this costs one extract + one repack per source ISO, then never again.
# ---------------------------------------------------------------------------
NOPROMPT="$OUT/$(basename "${ISO%.iso}")-noprompt.iso"
if [ ! -f "$NOPROMPT" ]; then
  echo "== repacking installer ISO without the press-any-key prompt =="
  SRC="$OUT/.isosrc"
  rm -rf "$SRC"; mkdir -p "$SRC"
  echo "   extracting $(basename "$ISO") ..."
  7z x -y -o"$SRC" "$ISO" >/dev/null || die "7z extraction failed"
  [ -f "$SRC/efi/microsoft/boot/efisys_noprompt.bin" ] \
    || die "efisys_noprompt.bin not in this ISO; cannot build a headless-bootable image"
  echo "   repacking ..."
  xorriso -as mkisofs \
    -iso-level 4 -J -joliet-long -D -N -relaxed-filenames \
    -V ENCWIN \
    -e efi/microsoft/boot/efisys_noprompt.bin -no-emul-boot \
    -o "$NOPROMPT" "$SRC" >/dev/null 2>&1 || die "xorriso repack failed"
  rm -rf "$SRC"
  echo "   $NOPROMPT ($(du -h "$NOPROMPT" | cut -f1))"
else
  echo "== reusing repacked ISO $NOPROMPT =="
fi
ISO="$NOPROMPT"

echo "== building answer ISO =="
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$HERE/autounattend.xml" "$STAGE/autounattend.xml"
cp "$HERE/stage2.ps1"       "$STAGE/stage2.ps1"
cp "$PROBE"                 "$STAGE/Test-EnclaveHost.ps1"
# Windows Setup looks for autounattend.xml in the root of any attached volume.
xorriso -as mkisofs -J -r -V ENCANSWER -o "$ANSWER" "$STAGE" >/dev/null 2>&1
echo "   $ANSWER ($(du -h "$ANSWER" | cut -f1))"

if [ ! -f "$DISK" ]; then
  echo "== creating $DISK_GB GB disk =="
  qemu-img create -f qcow2 "$DISK" "${DISK_GB}G" >/dev/null
else
  echo "== reusing existing $DISK (delete it to start clean) =="
fi
cp -f "$OVMF_VARS" "$VARS"
: > "$SERIAL"

echo "== booting (headless, unattended) =="
echo "   serial transcript -> $SERIAL"
echo "   this takes a while: Windows install, a reboot, then the probe."
echo "   watch with:  tail -f $SERIAL"
echo

# -cpu host exposes SVM/VMX to the guest so Hyper-V can start -- that is the
# part that matters. The hv_* set is deliberately the classic four, which have
# no unmet dependencies: hv_tlbflush requires hv_vpindex and QEMU refuses the
# pair outright, and richer enlightenments risk confusing a guest that is about
# to run its OWN Hyper-V. These are a performance nicety, not a requirement.
qemu-system-x86_64 \
  -name enclave-vbs-dryrun \
  -machine q35,accel=kvm,smm=on \
  -cpu host,+topoext,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time \
  -smp "$CPUS" \
  -m "${RAM_GB}G" \
  -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
  -drive if=pflash,format=raw,file="$VARS" \
  -device ahci,id=sata \
  -drive id=hdd,file="$DISK",format=qcow2,if=none,cache=writeback \
  -device ide-hd,bus=sata.0,drive=hdd,bootindex=1 \
  -drive id=win,file="$ISO",format=raw,if=none,media=cdrom,readonly=on \
  -device ide-cd,bus=sata.1,drive=win,bootindex=2 \
  -drive id=ans,file="$ANSWER",format=raw,if=none,media=cdrom,readonly=on \
  -device ide-cd,bus=sata.2,drive=ans \
  -netdev user,id=net0 \
  -device e1000e,netdev=net0 \
  -serial "file:$SERIAL" \
  -display none \
  -vga std \
  -rtc base=localtime \
  -boot order=dc

echo
echo "== VM exited =="
if grep -q "ENCLAVE-PROBE-BEGIN" "$SERIAL" 2>/dev/null; then
  echo "-- probe transcript --"
  sed -n '/===ENCLAVE-PROBE-BEGIN===/,/===ENCLAVE-PROBE-END===/p' "$SERIAL"
else
  echo "No probe transcript on the serial log. Either the install did not finish,"
  echo "or stage 2 never ran. Inspect $SERIAL, and re-run with -display gtk (edit"
  echo "this script) to watch the install interactively."
fi
