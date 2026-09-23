#!/bin/sh
# M3b prerequisites, BUILT ONLY (isolation/m3/PLAN.md sections 2 and 12): the KVM-planes host kernel and
# the patched QEMU that together give a VMPL boundary.
#
# This script deliberately does NOT install a kernel, touch /boot, run depmod, regenerate an initramfs,
# change a bootloader entry, or reboot. It clones, configures, compiles and inspects. Everything lands in
# one work directory. The boot is a separate, reviewed step with a rollback plan (PLAN.md section 13),
# because warden-host carries other sessions' work.
#
# usage: build-planes-host.sh <workdir> [kernel|qemu|all]
set -e
# NOTE ON WHERE TO RUN THIS: a kernel build must NOT go in the session scratchpad. That path is a tmpfs,
# so its files are RAM, and it is under a per-user quota shared with every other session on the box. A
# first attempt there exhausted the quota, which surfaced as an internal compiler error in the middle of
# the kernel build and then "Disk quota exceeded" on the QEMU clone. Use a directory on real disk, e.g.
# ~/.cache/enclave-isolation.
W=${1:?usage: build-planes-host.sh <workdir> [kernel|qemu|all]}
WHAT=${2:-all}
mkdir -p "$W"; W=$(cd "$W" && pwd)
J=${J:-$(nproc)}
KREF=${KREF:-svsm-v7.2}
QREF=${QREF:-svsm-v7.2}
log() { printf '\n=== %s\n' "$1"; }
fails=0
step() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

if [ "$WHAT" = all ] || [ "$WHAT" = kernel ]; then
log "kernel: coconut-svsm/linux $KREF (clone + configure + build; NOT installed)"
[ -d "$W/linux/.git" ] || git clone --depth 1 --branch "$KREF" https://github.com/coconut-svsm/linux "$W/linux" > "$W/k-clone.log" 2>&1 || true
if [ ! -d "$W/linux/.git" ]; then step "K0 kernel clone" no; tail -3 "$W/k-clone.log"; exit 1; fi
kver=$(git -C "$W/linux" describe --tags --always 2>/dev/null || echo unknown)
khead=$(git -C "$W/linux" rev-parse --short HEAD)
echo "  $KREF at $khead ($kver)"

# The uAPI is the whole point: this is what our 7.2.3 host does not have.
for sym in KVM_CAP_PLANES KVM_CREATE_PLANE KVM_EXIT_PLANE_EVENT; do
  n=$(grep -rc "$sym" "$W/linux/include/uapi/linux/kvm.h" 2>/dev/null || echo 0)
  printf '  %-22s in the branch uapi header: %s\n' "$sym" "$n"
done
grep -q KVM_CAP_PLANES "$W/linux/include/uapi/linux/kvm.h" && r=ok || r=no
step "K1 the planes uAPI is present in this branch (our running 7.2.3 header has none of it)" $r

# Configure from the RUNNING host config, so what is built is a kernel this machine could actually boot
# rather than a minimal one that would strand its storage or network.
if [ ! -f "$W/linux/.config" ]; then
  zcat /proc/config.gz > "$W/linux/.config" 2>/dev/null || cp "/boot/config-$(uname -r)" "$W/linux/.config"
  ( cd "$W/linux" && make olddefconfig ) > "$W/k-config.log" 2>&1
  # keep the module set small: only what this machine has loaded, plus KVM/SEV, so the build fits the
  # disk and the time we have. A boot candidate would be rebuilt with the full config.
  ( cd "$W/linux" && yes '' | make LSMOD=/proc/modules localmodconfig ) >> "$W/k-config.log" 2>&1 || true
  for opt in CONFIG_KVM CONFIG_KVM_AMD CONFIG_KVM_AMD_SEV CONFIG_AMD_MEM_ENCRYPT CONFIG_TSM_REPORTS; do
    ( cd "$W/linux" && ./scripts/config --module-if-not-set "$opt" 2>/dev/null ) || true
  done
  ( cd "$W/linux" && ./scripts/config -e CONFIG_KVM_AMD_SEV -e CONFIG_AMD_MEM_ENCRYPT ) || true
  ( cd "$W/linux" && make olddefconfig ) >> "$W/k-config.log" 2>&1
fi
for opt in CONFIG_KVM_AMD CONFIG_KVM_AMD_SEV CONFIG_AMD_MEM_ENCRYPT; do
  printf '  %-26s %s\n' "$opt" "$(grep "^$opt=" "$W/linux/.config" || echo 'NOT SET')"
done

log "kernel: compiling (this is the long part; nothing is installed)"
( cd "$W/linux" && make -j"$J" vmlinux modules ) > "$W/k-build.log" 2>&1 && r=ok || r=no
[ -f "$W/linux/vmlinux" ] || r=no
step "K2 the planes kernel compiles on this machine" $r
[ -f "$W/linux/arch/x86/boot/bzImage" ] || ( cd "$W/linux" && make -j"$J" bzImage ) >> "$W/k-build.log" 2>&1 || true
[ -f "$W/linux/arch/x86/boot/bzImage" ] && r=ok || r=no
step "K3 a bootable image was produced (bzImage), ready for a REVIEWED boot, not installed here" $r
[ -f "$W/linux/arch/x86/kvm/kvm-amd.ko" ] && r=ok || r=no
step "K4 kvm-amd built as a module (the planes + SEV-SNP code compiled)" $r
fi

if [ "$WHAT" = all ] || [ "$WHAT" = qemu ]; then
log "qemu: coconut-svsm/qemu $QREF with --enable-igvm (built, not installed)"
[ -d "$W/qemu/.git" ] || git clone --depth 1 --branch "$QREF" https://github.com/coconut-svsm/qemu "$W/qemu" > "$W/q-clone.log" 2>&1 || true
if [ ! -d "$W/qemu/.git" ]; then step "Q0 qemu clone" no; tail -3 "$W/q-clone.log"; exit 1; fi
echo "  $QREF at $(git -C "$W/qemu" rev-parse --short HEAD)"
IGVM_PREFIX=${IGVM_PREFIX:-$W/../svsmkit/igvminst}
# A build directory configured earlier records the igvm include path it was given. If that path has
# moved since — which it did once here, when these trees were moved off tmpfs onto disk — meson keeps
# using the old one and the build fails deep in backends/igvm-cfg.c. Reconfigure instead.
if [ -d "$W/qemu/build" ] && ! grep -rqs "$IGVM_PREFIX/include" "$W/qemu/build/build.ninja"; then
  echo "  the recorded igvm include path is stale; reconfiguring from scratch"
  rm -rf "$W/qemu/build"
fi
if [ ! -f "$W/qemu/build/config-host.h" ]; then
  ( cd "$W/qemu" && PKG_CONFIG_PATH="$IGVM_PREFIX/lib/pkgconfig:$IGVM_PREFIX/lib64/pkgconfig:$PKG_CONFIG_PATH" \
      ./configure --target-list=x86_64-softmmu --enable-igvm --disable-docs --disable-werror \
      --prefix="$W/qemu-inst" ) > "$W/q-configure.log" 2>&1 && r=ok || r=no
else r=ok; fi
grep -q 'define CONFIG_IGVM' "$W/qemu/build/config-host.h" 2>/dev/null && r=ok || r=no
step "Q1 QEMU configured WITH igvm (our packaged 11.1.1 has no igvm-cfg object at all)" $r
( cd "$W/qemu" && make -j"$J" ) > "$W/q-build.log" 2>&1 && r=ok || r=no
QBIN="$W/qemu/build/qemu-system-x86_64"
[ -x "$QBIN" ] || r=no
step "Q2 QEMU builds" $r
if [ -x "$QBIN" ]; then
  echo "  version: $("$QBIN" --version | head -1)"
  "$QBIN" -object help 2>&1 | grep -i igvm | sed 's/^/  object: /' || true
  "$QBIN" -machine q35,help 2>&1 | grep -iE 'plane|igvm' | sed 's/^/  machine: /' || true
  "$QBIN" -object help 2>&1 | grep -qi 'igvm-cfg' && r=ok || r=no
  step "Q3 the built QEMU offers an igvm-cfg object" $r
  # device-plane is added to the machine object at runtime (hw/core/machine.c), so it does NOT appear in
  # the static -machine help list. Ask the binary itself instead: it must accept the option and then be
  # refused by the kernel, which is exactly the state we are proving.
  grep -rqs 'device-plane' "$W/qemu/hw/core/machine.c" && r=ok || r=no
  step "Q4 this QEMU implements the device-plane machine property" $r
  probe=$(timeout 20 "$QBIN" -machine q35,accel=kvm,device-plane=2,kernel-irqchip=split \
            -display none -nodefaults -no-user-config -S 2>&1 | head -3)
  echo "  plane probe against the RUNNING kernel: $probe"
  echo "$probe" | grep -qi 'plane .* not supported' && r=ok || r=no
  step "Q5 QEMU asks for a plane and the RUNNING kernel refuses it: the VMM side is ready and the kernel is the only missing piece" $r
fi
fi

echo
echo "--- nothing was installed; the running kernel and QEMU are untouched ---"
[ -f "$W/linux/arch/x86/boot/bzImage" ] && echo "bzImage:  $W/linux/arch/x86/boot/bzImage ($(stat -c %s "$W/linux/arch/x86/boot/bzImage") bytes)"
[ -x "$W/qemu/build/qemu-system-x86_64" ] && echo "qemu:     $W/qemu/build/qemu-system-x86_64"
du -sh "$W" 2>/dev/null
[ "$fails" -eq 0 ] && echo "PLANES-HOST BUILD: ALL PASS" || { echo "PLANES-HOST BUILD: $fails FAILED"; exit 1; }
