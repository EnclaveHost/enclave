#!/bin/sh
# The node acceptance run (hvlab-accept.mjs) on THIS Linux KVM host: the same guest image a NucBox partition boots, two
# pre-booted guests, the launcher stand-in's signer (hvlab.py), and the Windows owner's manager as its own process
# (hvlab-manager.mjs: Manager + judgeRunning + the data plane, a KVM launch backend in place of the NucBox's). Plain
# KVM, NOT Hyper-V: on the box the same harness drives the real manager (see UEFI-BOOT.md, "The box acceptance run").
#
#   usage: NODE_TREE=<node tree> test-hv-accept.sh <workdir> [judge-hv.mjs]
#          BOOT=uefi boots the guests from a UKI on an ESP (as a UEFI partition does); default: -kernel/-initrd
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:?usage: NODE_TREE=<tree> test-hv-accept.sh <workdir> [judge-hv.mjs]}; : "${NODE_TREE:?NODE_TREE is required}"
JUDGE=${2:-$NODE_TREE/windows/vbslike/verify/judge-hv.mjs}
mkdir -p "$W/state"; W=$(cd "$W" && pwd); S=$W/state
CIDE=${CIDE:-70005}; CIDF=${CIDF:-70006}
OVMF_PLAIN=${OVMF_PLAIN:-/usr/share/edk2/x64/OVMF.4m.fd}; KERNEL=${KERNEL:-/boot/vmlinuz-linux}; BOOT=${BOOT:-direct}
units="hvacc-signer hvacc-gE hvacc-gF"
launch_guest() {
  if [ "$BOOT" = uefi ]; then
    systemd-run --user --unit="hvacc-g$1" --collect -q -p MemoryMax=1792M qemu-system-x86_64 -machine q35,accel=kvm \
      -cpu host -smp 1 -m 1024M -bios "$OVMF_PLAIN" -drive "if=virtio,format=raw,readonly=on,file=fat:$W/esp" \
      -device "vhost-vsock-pci,guest-cid=$2" -nodefaults -display none -serial "file:$W/g$1.serial" -no-reboot
  else
    systemd-run --user --unit="hvacc-g$1" --collect -q -p MemoryMax=1792M qemu-system-x86_64 -machine q35,accel=kvm \
      -cpu host -smp 1 -m 1024M -bios "$OVMF_PLAIN" -kernel "$KERNEL" -initrd "$W/mon.cpio.gz" \
      -append "console=ttyS0 rdinit=/init loglevel=3 report_host=9001" -device "vhost-vsock-pci,guest-cid=$2" \
      -nodefaults -display none -serial "file:$W/g$1.serial" -no-reboot
  fi
}
mgr=""
cleanup() { [ -n "$mgr" ] && kill "$mgr" 2>/dev/null; sleep 1; systemctl --user stop $units 2>/dev/null || true; }
trap cleanup EXIT
cleanup
rm -f "$S/loaded.json" "$W"/g?.serial

sh "$here/build-domain.sh" "$W/mon.cpio.gz" 1 > "$W/build.log"
echo "image $(sha256sum "$W/mon.cpio.gz" | cut -c1-64)"
if [ "$BOOT" = uefi ]; then
  mkdir -p "$W/esp/EFI/BOOT"
  sh "$here/build-uki.sh" "$KERNEL" "$W/mon.cpio.gz" "$W/esp/EFI/BOOT/BOOTX64.EFI" | tee "$W/uki.txt"
fi
echo "boot $BOOT (QEMU/KVM, NOT Hyper-V)"
(cd "$W" && rm -rf ex && mkdir ex && cd ex && zcat ../mon.cpio.gz | cpio -id --quiet plat/rt/runtime.json)
systemd-run --user --unit=hvacc-signer --collect -q -E HVLAB_IMAGE="$W/mon.cpio.gz" -E HVLAB_KERNEL="$KERNEL" \
  python3 -u "$here/hvlab.py" signer "$S"
launch_guest E "$CIDE"; launch_guest F "$CIDF"
t=0; until [ "$(grep -l "MON ready" "$W/gE.serial" "$W/gF.serial" 2>/dev/null | wc -l)" = 2 ]; do
  t=$((t + 1)); [ $t -lt 60 ] || { echo "the guests' monitors never came up"; exit 1; }; sleep 2; done
grep -h "MON ready" "$W/gE.serial" "$W/gF.serial" | tr -d '\r'

HVLAB_NODE_TREE="$NODE_TREE" node "$here/hvlab-manager.mjs" "$S" "$W/mon.cpio.gz" "$W/ex/plat/rt/runtime.json" "$CIDE" "$CIDF" \
  > "$W/manager.log" 2>&1 &
mgr=$!
t=0; until head -1 "$W/manager.log" 2>/dev/null | grep -q '^{"manager"'; do
  t=$((t + 1)); [ $t -lt 60 ] || { cat "$W/manager.log"; echo "the manager never came up"; exit 1; }; sleep 1; done
head -1 "$W/manager.log"
j() { head -1 "$W/manager.log" | python3 -c "import json,sys;print(json.load(sys.stdin)['$1'])"; }
rc=0
HVACC_NODE_TREE="$NODE_TREE" HVACC_MANAGER="$(j manager)" HVACC_DATA="$(j data)" HVACC_LAUNCHER_KEY="$(j launcherKey)" \
  HVACC_EXPECT_HV_ISOLATION="${HVACC_EXPECT_HV_ISOLATION-n/a}" HVACC_JUDGE="$JUDGE" HVACC_RUNTIME="$W/ex/plat/rt/runtime.json" node "$here/hvlab-accept.mjs" > "$W/accept.txt" 2>&1 || rc=$?
cat "$W/accept.txt"
kill "$mgr" 2>/dev/null; wait "$mgr" 2>/dev/null || true; mgr=""
tail -1 "$W/manager.log"
[ "$rc" = 0 ] && [ "$(tail -1 "$W/accept.txt")" = "HVLAB-ACCEPT ALL PASS" ] || { echo "TEST-HV-ACCEPT FAILED (rc=$rc)"; exit 1; }
echo "TEST-HV-ACCEPT PASS (QEMU/KVM, NOT Hyper-V)"
