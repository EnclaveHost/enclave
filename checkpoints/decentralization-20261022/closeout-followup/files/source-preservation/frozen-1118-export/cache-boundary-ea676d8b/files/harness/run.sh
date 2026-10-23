#!/bin/bash
# Host driver (run through work/claude-test-queue.py at 1536 MiB). Unprivileged: no sudo, no host loop/dm device, no host
# module load, no host mount. Boots the host's installed kernel package in a throwaway QEMU/KVM guest with NO network and
# two virtual disks backed by OWNED sparse files under this run directory, twice (phase one ends in an abrupt guest
# reboot; phase two is the next boot). Total actual allocation of this test (du of TEST_DIR) is capped at 512 MiB.
set -u
T=$(cd "$(dirname "$0")/.." && pwd); cd "$T" || exit 2
RUN=$T/run/$(date -u +%Y%m%dT%H%M%SZ); OUT=$RUN/out; mkdir -p "$OUT/render"
CAP=$((512 << 20)); KV=7.2.11-arch1-1; KERNEL=/boot/vmlinuz-linux
alloc() { du -s --block-size=1 "$T" | cut -f1; }
hostid() {   # host identity receipt: loops, dm names, block devices, mounts, qemu processes (all unprivileged reads)
  echo "{\"tag\": \"$1\", \"loops\": \"$(losetup -l -n 2>&1 | tr '\n' ';')\", \"dm\": \"$(ls /dev/mapper | tr '\n' ' ')\", \"block\": \"$(ls /sys/block | tr '\n' ' ')\", \"mountinfoLines\": $(wc -l < /proc/self/mountinfo), \"mountinfoSha256\": \"$(cut -d' ' -f5,9- /proc/self/mountinfo | sort | sha256sum | cut -c1-64)\", \"qemu\": \"$(pgrep -a qemu-system | grep -c enc-cachetest)\", \"testAllocBytes\": $(alloc)}"
}
check_cap() { a=$(alloc); echo "alloc[$1]=$a cap=$CAP"; [ "$a" -le "$CAP" ] || { echo "OVER 512 MiB TEST CAP at $1"; exit 4; }; }
hostid before | tee "$OUT/host-identity-before.json"
check_cap start
bash harness/build-initramfs.sh "$RUN/initramfs.cpio.gz" "$KV" || exit 3
python3 -I harness/render.py "$OUT/render" || exit 3
truncate -s 256M "$RUN/hdd.img"; truncate -s 160M "$RUN/nvme.img"
stat -c '{"file": "%n", "inode": %i, "apparent": %s, "allocated": %b}' "$RUN/hdd.img" "$RUN/nvme.img" | tee "$OUT/disk-identity-before.jsonl"
check_cap after-setup
boot() {
  local phase=$1
  timeout -k 10 600 qemu-system-x86_64 -name enc-cachetest-$phase -enable-kvm -cpu host -m 640 -smp 2 \
    -nodefaults -display none -no-reboot -nic none -serial file:"$OUT/console-$phase.log" \
    -kernel "$KERNEL" -initrd "$RUN/initramfs.cpio.gz" -append "console=ttyS0 panic=-1 quiet phase=$phase" \
    -device virtio-scsi-pci,id=scsi0 \
    -drive file="$RUN/hdd.img",format=raw,if=none,id=hdd,cache=writeback \
    -device scsi-hd,bus=scsi0.0,drive=hdd,rotation_rate=7200,serial=enc-hdd \
    -drive file="$RUN/nvme.img",format=raw,if=none,id=nv,cache=writeback \
    -device scsi-hd,bus=scsi0.0,drive=nv,rotation_rate=1,serial=enc-nvme \
    -virtfs local,path=/usr,mount_tag=usr,security_model=none,readonly=on \
    -virtfs local,path="$T",mount_tag=src,security_model=none,readonly=on \
    -virtfs local,path="$OUT",mount_tag=out,security_model=none
  echo "qemu phase=$phase rc=$?"
}
boot one; check_cap after-one; hostid after-one | tee "$OUT/host-identity-after-one.json"
boot two; check_cap after-two
stat -c '{"file": "%n", "inode": %i, "apparent": %s, "allocated": %b}' "$RUN/hdd.img" "$RUN/nvme.img" | tee "$OUT/disk-identity-after.jsonl"
for p in one two; do echo "== guest $p"; tail -5 "$OUT/guest-$p.log" 2>/dev/null; echo "== results $p"; cat "$OUT/results-$p.json" 2>/dev/null; done
# cleanup: the owned disk files, the fixture key and the initramfs (receipts/logs are kept)
rm -f "$RUN/hdd.img" "$RUN/nvme.img" "$OUT/fixture.key" "$RUN/initramfs.cpio.gz"
hostid after | tee "$OUT/host-identity-after.json"
echo "leftover qemu: $(pgrep -a qemu-system | grep -c enc-cachetest)"; ls -la "$RUN" "$OUT" | head -40
