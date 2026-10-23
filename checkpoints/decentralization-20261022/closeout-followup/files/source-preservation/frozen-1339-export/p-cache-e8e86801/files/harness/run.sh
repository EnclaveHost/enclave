#!/bin/bash
# Host driver (through work/claude-test-queue.py at 1536 MiB). Unprivileged: no sudo, no host loop/dm/mount, no host
# module load. One boot of the installed kernel package in a networkless throwaway QEMU/KVM guest with two virtual disks
# backed by OWNED sparse files (256 + 208 MiB apparent; with the initramfs < 512 MiB even if fully written).
set -u
T=$(cd "$(dirname "$0")/.." && pwd); cd "$T" || exit 2
RUN=$T/run/$(date -u +%Y%m%dT%H%M%SZ); OUT=$RUN/out; mkdir -p "$OUT/render"
CAP=$((512 << 20)); KV=7.2.11-arch1-1; KERNEL=/boot/vmlinuz-linux
alloc() { du -s --block-size=1 "$T" | cut -f1; }
hostid() {
  echo "{\"tag\": \"$1\", \"loops\": \"$(losetup -l -n 2>&1 | tr '\n' ';')\", \"dm\": \"$(ls /dev/mapper | tr '\n' ' ')\", \"block\": \"$(ls /sys/block | tr '\n' ' ')\", \"mountinfoSha256\": \"$(cut -d' ' -f5,9- /proc/self/mountinfo | sort | sha256sum | cut -c1-64)\", \"qemu\": \"$(pgrep -a qemu-system | grep -c enc-cachedelta)\", \"testAllocBytes\": $(alloc)}"
}
check_cap() { a=$(alloc); echo "alloc[$1]=$a cap=$CAP"; [ "$a" -le "$CAP" ] || { echo "OVER 512 MiB TEST CAP at $1"; exit 4; }; }
hostid before | tee "$OUT/host-identity-before.json"; check_cap start
sha256sum vendor/s/holder-storage.sh.in vendor/p/vendor/holder/holder-storage.sh.in vendor/s-old/holder-storage.sh.in harness/guest.py harness/render.py | tee "$OUT/source-pins.txt"
bash harness/build-initramfs.sh "$RUN/initramfs.cpio.gz" "$KV" || exit 3
python3 -I harness/render.py "$OUT/render" > "$OUT/render.log" || { cat "$OUT/render.log"; exit 3; }
truncate -s 256M "$RUN/hdd.img"; truncate -s 208M "$RUN/nvme.img"
stat -c '{"file": "%n", "inode": %i, "apparent": %s, "allocated512": %b}' "$RUN/hdd.img" "$RUN/nvme.img" | tee "$OUT/disk-identity-before.jsonl"
check_cap after-setup
timeout -k 10 900 qemu-system-x86_64 -name enc-cachedelta -enable-kvm -cpu host -m 640 -smp 2 \
  -nodefaults -display none -no-reboot -nic none -serial file:"$OUT/console.log" \
  -kernel "$KERNEL" -initrd "$RUN/initramfs.cpio.gz" -append "console=ttyS0 panic=-1 quiet phase=delta" \
  -device virtio-scsi-pci,id=scsi0 \
  -drive file="$RUN/hdd.img",format=raw,if=none,id=hdd,cache=writeback -device scsi-hd,bus=scsi0.0,drive=hdd,rotation_rate=7200,serial=enc-hdd \
  -drive file="$RUN/nvme.img",format=raw,if=none,id=nv,cache=writeback -device scsi-hd,bus=scsi0.0,drive=nv,rotation_rate=1,serial=enc-nvme \
  -virtfs local,path=/usr,mount_tag=usr,security_model=none,readonly=on \
  -virtfs local,path="$T",mount_tag=src,security_model=none,readonly=on \
  -virtfs local,path="$OUT",mount_tag=out,security_model=none
echo "qemu rc=$?"; check_cap after-boot
stat -c '{"file": "%n", "inode": %i, "apparent": %s, "allocated512": %b}' "$RUN/hdd.img" "$RUN/nvme.img" | tee "$OUT/disk-identity-after.jsonl"
tail -3 "$OUT/guest-delta.log" 2>/dev/null
rm -f "$RUN/hdd.img" "$RUN/nvme.img" "$OUT/fixture.key" "$RUN/initramfs.cpio.gz"
hostid after | tee "$OUT/host-identity-after.json"
echo "leftover qemu: $(pgrep -a qemu-system | grep -c enc-cachedelta)"
