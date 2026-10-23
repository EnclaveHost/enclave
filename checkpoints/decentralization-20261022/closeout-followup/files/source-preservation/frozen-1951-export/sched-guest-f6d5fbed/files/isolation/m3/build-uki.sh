#!/bin/sh
# The NucBox guest as ONE UEFI application: a Unified Kernel Image (UKI) that the standard UEFI firmware a Hyper-V
# partition boots (under OpenHCL) starts as \EFI\BOOT\BOOTX64.EFI. On the NucBox build, standard UEFI boots; two
# linux-direct images (ours and Microsoft's) failed under the settings tested (enclave-d1, 7c6bb15d). The payload is UNCHANGED: the same initrd (build-domain.sh), the same monitor,
# front, runtime and app path, the same command line. Only how it is loaded changes.
#
# A UKI is systemd's EFI stub with the kernel, the initrd and the command line as PE sections (.linux, .initrd,
# .cmdline, .osrel): the firmware loads one file and the stub hands the kernel exactly those, so nothing on the ESP
# or in NVRAM can add an argument or swap the initrd. See UEFI-BOOT.md for what is new in the boot chain and what is
# measured by whom (on this tier: nothing a client can verify; the launcher signs, T0-hv).
#
#   usage: build-uki.sh <kernel (EFI-stub bzImage)> <initrd> <out.efi> [cmdline]
#          cmdline defaults to the partition's: console=ttyS0 rdinit=/init loglevel=3 report_host=9001
#   env:   UKI_STUB (default /usr/lib/systemd/boot/efi/linuxx64.efi.stub)
# prints the UKI's sha256 and every input's, so the composition can be recomputed.
set -e
kernel=${1:?usage: build-uki.sh <kernel> <initrd> <out.efi> [cmdline]}; initrd=${2:?}; out=${3:?}
cmdline=${4:-console=ttyS0 rdinit=/init loglevel=3 report_host=9001}
stub=${UKI_STUB:-/usr/lib/systemd/boot/efi/linuxx64.efi.stub}
for f in "$kernel" "$initrd" "$stub"; do [ -r "$f" ] || { echo "build-uki.sh: cannot read $f" >&2; exit 2; }; done
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
# fixed, byte-for-byte inputs: no newline after the command line (the stub passes the section verbatim), and an os-release
# that names this image rather than the build host's
printf '%s' "$cmdline" > "$d/cmdline"
printf 'NAME="enclave NucBox guest"\nID=enclave-nucbox-guest\n' > "$d/osrel"
# section placement: after the stub's own sections, each aligned to the stub's SectionAlignment
align=$(objdump -p "$stub" | awk '$1 == "SectionAlignment" { print $2 }'); align=$((0x$align))
end=$(objdump -h "$stub" | awk 'NF == 7 && $1 ~ /^[0-9]+$/ { s = strtonum("0x" $3); o = strtonum("0x" $4); if (s + o > m) m = s + o } END { print m }')
next() { echo $(( ($1 + align - 1) / align * align )); }
osrel=$(next "$end")
cmd=$(next $((osrel + $(stat -Lc%s "$d/osrel"))))
lin=$(next $((cmd + $(stat -Lc%s "$d/cmdline"))))
ird=$(next $((lin + $(stat -Lc%s "$kernel"))))
# objcopy stamps a PE TimeDateStamp (and the header checksum follows it) from the clock unless SOURCE_DATE_EPOCH is set:
# pinned, so the same inputs give the same UKI at any time
SOURCE_DATE_EPOCH=0 objcopy \
  --add-section .osrel="$d/osrel"      --change-section-vma .osrel=$(printf 0x%x "$osrel") \
  --add-section .cmdline="$d/cmdline"  --change-section-vma .cmdline=$(printf 0x%x "$cmd") \
  --add-section .linux="$kernel"       --change-section-vma .linux=$(printf 0x%x "$lin") \
  --add-section .initrd="$initrd"      --change-section-vma .initrd=$(printf 0x%x "$ird") \
  "$stub" "$out"
sha() { sha256sum "$1" | cut -c1-64; }
echo "uki $out sha256 $(sha "$out") bytes $(stat -c %s "$out")"
echo "  stub    $(sha "$stub")  $stub"
echo "  kernel  $(sha "$kernel")  $kernel"
echo "  initrd  $(sha "$initrd")  $initrd"
echo "  cmdline $(sha "$d/cmdline")  \"$cmdline\""
echo "  osrel   $(sha "$d/osrel")  (fixed text: NAME=\"enclave NucBox guest\" ID=enclave-nucbox-guest)"
echo "  tool    $(objcopy --version | head -1)"
