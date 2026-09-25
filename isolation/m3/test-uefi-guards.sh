#!/bin/sh
# The partition guest's command-line and /.extra guards (dominit.c), exercised through the SAME channels a host has
# under UEFI with Secure Boot off (isolation/m3/UEFI-BOOT.md): QEMU + OVMF on this host, NOT Hyper-V.
#   clean      the ESP holds only the UKI                                   -> MON ready
#   smbios     SMBIOS type 11 io.systemd.stub.kernel-cmdline-extra=...     -> refused: the command line is not the pinned one
#   addon      a credential beside the UKI (BOOTX64.EFI.extra.d/x.cred)    -> refused: the stub added files under /.extra
#   loadopts   no BOOTX64.EFI; the UKI at \EFI\enclave\uki.efi run by the EFI shell's startup.nsh with one extra
#              argument (an invocation command line: what a boot entry's LoadOptions deliver)
#                                                                          -> refused: the command line is not the pinned one
#   loadpinned the same, with exactly the pinned line as the arguments       -> MON ready (the guard compares content)
#   direct     QEMU -kernel/-append with one extra argument: NOT a UKI boot, so the line is the loader's and is not
#              pinned (documented scope)                                   -> MON ready
#   usage: test-uefi-guards.sh <workdir> [kernel]     (builds the initrd and the UKI from this checkout)
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:?usage: test-uefi-guards.sh <workdir> [kernel]}; K=${2:-/boot/vmlinuz-linux}
mkdir -p "$W"; W=$(cd "$W" && pwd)
OVMF=${OVMF_PLAIN:-/usr/share/edk2/x64/OVMF.4m.fd}
sh "$here/build-domain.sh" "$W/mon.cpio.gz" 1 > "$W/build.log"
mkdir -p "$W/clean/EFI/BOOT" "$W/addon/EFI/BOOT/BOOTX64.EFI.extra.d"
sh "$here/build-uki.sh" "$K" "$W/mon.cpio.gz" "$W/clean/EFI/BOOT/BOOTX64.EFI" | tee "$W/uki.txt"
cp "$W/clean/EFI/BOOT/BOOTX64.EFI" "$W/addon/EFI/BOOT/BOOTX64.EFI"
printf 'injected-by-the-host' > "$W/addon/EFI/BOOT/BOOTX64.EFI.extra.d/x.cred"
# the invocation-line cases boot the edk2 UEFI Shell as BOOTX64.EFI (this OVMF has no built-in shell entry); it runs
# \startup.nsh, which starts the UKI with arguments. SHELL_EFI: a Shell.efi (edk2 ShellPkg); absent -> those two SKIP.
SHELL_EFI=${SHELL_EFI:-$HOME/.cache/enclave-isolation/fwbuild/src/edk2/Build/Shell/RELEASE_GCC/X64/ShellPkg/Application/Shell/Shell/OUTPUT/Shell.efi}
for v in loadopts loadpinned; do
  mkdir -p "$W/$v/EFI/enclave" "$W/$v/EFI/BOOT"; cp "$W/clean/EFI/BOOT/BOOTX64.EFI" "$W/$v/EFI/enclave/uki.efi"
  [ -r "$SHELL_EFI" ] && cp "$SHELL_EFI" "$W/$v/EFI/BOOT/BOOTX64.EFI"
done
printf '%s\r\n' 'fs0:\EFI\enclave\uki.efi console=ttyS0 rdinit=/init loglevel=3 report_host=9001 injected=1' > "$W/loadopts/startup.nsh"
printf '%s\r\n' 'fs0:\EFI\enclave\uki.efi console=ttyS0 rdinit=/init loglevel=3 report_host=9001' > "$W/loadpinned/startup.nsh"
failed=0
boot() {   # boot <name> <expect-regex> <qemu args...>
  name=$1; want=$2; shift 2
  rm -f "$W/$name.serial"
  systemd-run --user --unit="hvlab-guard-$name" --collect -q -p MemoryMax=1792M qemu-system-x86_64 -machine q35,accel=kvm \
    -cpu host -smp 1 -m 1024M -bios "$OVMF" "$@" -nodefaults -display none -serial "file:$W/$name.serial" -no-reboot
  t=0; until tr -d '\r' < "$W/$name.serial" 2>/dev/null | grep -a -q -E "MON ready|MON ERROR refusing"; do
    t=$((t + 1)); [ $t -lt 60 ] || break; sleep 1; done
  systemctl --user stop "hvlab-guard-$name" 2>/dev/null || true
  got=$(tr -d '\r' < "$W/$name.serial" 2>/dev/null | grep -a -E "MON ready|MON ERROR refusing" | head -1)
  if printf '%s' "$got" | grep -q -E "$want"; then echo "PASS $name: $got"; else echo "FAIL $name: wanted /$want/, got: ${got:-nothing}"; failed=$((failed + 1)); fi
}
boot clean  "MON ready"                          -drive "if=virtio,format=raw,readonly=on,file=fat:$W/clean"
boot smbios "not the pinned one"                 -drive "if=virtio,format=raw,readonly=on,file=fat:$W/clean" \
                                                 -smbios "type=11,value=io.systemd.stub.kernel-cmdline-extra=injected=1"
boot addon  "under /.extra"                      -drive "if=virtio,format=raw,readonly=on,file=fat:$W/addon"
if [ -r "$SHELL_EFI" ]; then
  echo "shell $(sha256sum "$SHELL_EFI" | cut -c1-64) $SHELL_EFI"
  boot loadopts   "not the pinned one"           -drive "if=virtio,format=raw,readonly=on,file=fat:$W/loadopts"
  boot loadpinned "MON ready"                    -drive "if=virtio,format=raw,readonly=on,file=fat:$W/loadpinned"
else
  echo "SKIP loadopts, loadpinned: no UEFI Shell binary (SHELL_EFI) to run startup.nsh - not counted as passed"
fi
boot direct "MON ready"                          -kernel "$K" -initrd "$W/mon.cpio.gz" \
                                                 -append "console=ttyS0 rdinit=/init loglevel=3 report_host=9001 injected=1"
[ "$failed" = 0 ] && echo "UEFI-GUARDS ALL PASS" || { echo "UEFI-GUARDS $failed FAILED"; exit 1; }
