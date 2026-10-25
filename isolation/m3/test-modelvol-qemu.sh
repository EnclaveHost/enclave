#!/bin/sh
# The Windows partition's model volumes against a REAL kernel (QEMU/KVM, the host's kernel and module tree): the m3
# monitor's own code (monitor/modelvol.go, through monitor/modelvol_kernel_test.go as PID 1) stages a domain's volume
# from its measured config, over SCSI disks (sd*, as Hyper-V's storvsc presents them; virtio-scsi here). The host
# says nothing about which disk is which: the monitor takes the disk whose hash tree hashes to the PINNED root.
# Volumes built by metal/volumes.mjs and pinned through sdk/storage/model-volumes.mjs, as a release would. Cases:
#   honest     a same-size DECOY (the volume with its top hash block altered) first, the volume second: the decoy is
#              passed over, the volume is verified, bound read-only into the domain, reads back byte-exact, and
#              writes and creates are refused (EROFS)
#   tampered   one byte of the file's data flipped: the volume still matches its root, and the read fails (dm-verity)
#   wrong      only another volume attached: refused, the domain never gets a marker
#
# usage: test-modelvol-qemu.sh   (needs qemu-system-x86_64, /dev/kvm, go, gcc, node, mkfs.ext4, veritysetup, debugfs, cpio)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
KERNEL=${MV_KERNEL:-/boot/vmlinuz-linux}
for tool in qemu-system-x86_64 go gcc node mkfs.ext4 veritysetup debugfs cpio; do
  command -v "$tool" >/dev/null || { echo "FAIL $tool is required"; exit 1; }
done
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "FAIL /dev/kvm is required"; exit 1; }
off=$(od -An -j0x20E -N2 -tu2 < "$KERNEL" | tr -d ' ')
krel=$(dd if="$KERNEL" bs=1 skip=$((off + 0x200)) count=128 status=none | tr -d '\0' | head -c 128 | cut -d' ' -f1)
M=/lib/modules/$krel/kernel
[ -d "$M" ] || { echo "FAIL no module tree for $krel"; exit 1; }
echo "ok   kernel $krel, modules $M"

mkdir -p "$d/src-a/tokenizer" "$d/src-b" "$d/store" "$d/pub"
head -c 3145728 /dev/urandom > "$d/src-a/payload.bin"
printf 'fixture vocabulary\n' > "$d/src-a/tokenizer/vocab.txt"
head -c 1048576 /dev/urandom > "$d/src-b/payload.bin"
node "$root/metal/volumes.mjs" build fixture-a --src "$d/src-a" --store "$d/store" > /dev/null
node "$root/metal/volumes.mjs" build fixture-b --src "$d/src-b" --store "$d/store" > /dev/null
node --input-type=module -e "
  import { buildDistribution, tableText } from '$root/sdk/storage/model-volumes.mjs';
  import fs from 'node:fs';
  const rows = [];
  for (const n of ['fixture-a', 'fixture-b']) rows.push(await buildDistribution('$d/store/' + n, '$d/pub', { chunkBytes: 1 << 20 }));
  fs.writeFileSync('$d/table', tableText(rows));
"
want=$(sha256sum "$d/src-a/payload.bin" | cut -c1-64)
hs=$(awk '$1 == "fixture-a" { print $7 }' "$d/table")
img=$d/store/fixture-a/volume.img
flip() {  # <file> <byte offset>
  python3 -c "import sys; f=open(sys.argv[1],'r+b'); f.seek(int(sys.argv[2])); b=f.read(1); f.seek(int(sys.argv[2])); f.write(bytes([b[0]^1])); f.close()" "$1" "$2"
}
cp "$img" "$d/decoy.img"; flip "$d/decoy.img" $((hs * 4096 + 5))        # same size, its tree no longer the pinned root
cp "$img" "$d/tampered.img"
blk=$(debugfs -R "bmap /payload.bin 0" "$d/tampered.img" 2>/dev/null | tail -1)
case "$blk" in ''|*[!0-9]*) echo "FAIL could not locate payload.bin's first block ($blk)"; exit 1 ;; esac
flip "$d/tampered.img" $((blk * 4096 + 17))
echo "ok   volumes built and pinned; a same-size decoy and a tampered copy made"

# PID 1: the monitor package's test binary (static), the measured dm-verity helper, the table, the modules
(cd "$here" && CGO_ENABLED=0 GOFLAGS="${GOFLAGS:-} -mod=readonly" go test -c -o "$d/init" ./monitor/)
gcc -static -O2 -o "$d/mverity" "$root/metal/guest/mverity.c"
rm -rf "$d/ird"; mkdir -p "$d/ird/plat/rt" "$d/ird/proc" "$d/ird/sys" "$d/ird/dev" "$d/ird/tmp" "$d/ird/models" "$d/ird/domains"
cp "$d/init" "$d/mverity" "$d/ird/"
cp "$d/table" "$d/ird/plat/rt/model-volumes.table"
cp "$M/drivers/md/dm-mod.ko.zst" "$M/drivers/md/dm-bufio.ko.zst" "$M/drivers/md/dm-verity.ko.zst" "$M/lib/reed_solomon/reed_solomon.ko.zst" "$d/ird/"
(cd "$d/ird" && find . | cpio -o -H newc --quiet | gzip -1) > "$d/initrd.gz"

boot() {  # <label> <image>... -> $d/<label>.log (SCSI disks sda, sdb, ... in order)
  label=$1; shift
  disks="-device virtio-scsi-pci,id=scsi0"; i=0
  for f in "$@"; do
    disks="$disks -drive file=$f,format=raw,if=none,id=d$i,readonly=on,cache=none -device scsi-hd,drive=d$i,bus=scsi0.0,scsi-id=$i,lun=0"
    i=$((i + 1))
  done
  # shellcheck disable=SC2086
  timeout 180 qemu-system-x86_64 -enable-kvm -cpu host -m 512M -smp 1 -nodefaults -display none -no-reboot \
    -kernel "$KERNEL" -initrd "$d/initrd.gz" \
    -append "console=ttyS0 rdinit=/init panic=-1 loglevel=3 MVQEMU=1 -- -test.run=^TestModelVolumesOnARealKernel\$ -test.v" \
    -serial "file:$d/$label.log" $disks || true
}
fails=0
check() {  # <label> <grep -E pattern> <what>
  if grep -qE "$2" "$d/$1.log"; then echo "ok   $1: $3"
  else echo "FAIL $1: $3"; grep -aE "MVTEST|MON " "$d/$1.log" | sed 's/^/     /'; tail -5 "$d/$1.log" | sed 's/^/     /'; fails=$((fails + 1)); fi
}

boot honest "$d/decoy.img" "$img"
check honest "^MON model volume fixture-a verified on sdb " "the decoy (sda, the same size) is passed over; the volume (sdb) matches its pinned root"
check honest '^MVTEST staged marker="M1\\nvol=fixture-a\\n"' "the domain's marker names exactly its config's volume"
check honest "^MVTEST bound ro=true" "bound read-only into the domain"
check honest "^MVTEST read 3145728 bytes sha256=$want" "the file reads back byte-exact through dm-verity"
check honest "^MVTEST write-refused=true" "a write is refused"
check honest "^MVTEST create-refused=true" "a create is refused (EROFS)"

boot tampered "$d/tampered.img"
check tampered "^MON model volume fixture-a verified on sda " "the tree still matches (the flip is in the data)"
check tampered "^MVTEST read-failed .*input/output error" "a flipped data byte is an I/O error, never different bytes"

boot wrong "$d/store/fixture-b/volume.img"
check wrong '^MVTEST refused: model volume "fixture-a": no attached disk holds its pinned hash tree' "another volume's disk: refused"
check wrong "^MVTEST end" "the guest ran to the end"
if grep -q "^MVTEST staged" "$d/wrong.log"; then echo "FAIL wrong: a marker was written for a refused domain"; fails=$((fails + 1)); fi

[ $fails = 0 ] && echo "m3 modelvol qemu: PASS" || { echo "m3 modelvol qemu: FAIL ($fails)"; exit 1; }
