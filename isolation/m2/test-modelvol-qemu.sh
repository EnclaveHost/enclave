#!/bin/sh
# Model volumes against a REAL kernel (QEMU/KVM, the host's kernel and its own module tree): the per-app init's code
# (dominit.c + modelvol.h + mverity.h, through testdata/modelvol-qemu-init.c) loads dm-mod/dm-bufio/reed_solomon/
# dm-verity, finds the volume's disk by its serial, brings dm-verity up against the root the measured table PINS and
# mounts ext4 read-only. Volumes are built by metal/volumes.mjs and pinned through sdk/storage/model-volumes.mjs, as a
# release would. Cases:
#   honest        the volume mounts read-only; the file reads back byte-exact; a write is refused (EROFS)
#   tampered      one byte of the file's data flipped on the host: the read fails (dm-verity: I/O error)
#   wrong image   another volume's image under this volume's serial: refused at mount (its superblock fails verity)
#   no disk       nothing attached: refused, the app would not start
#
# usage: test-modelvol-qemu.sh   (needs qemu-system-x86_64, /dev/kvm, gcc, node, mkfs.ext4, veritysetup, debugfs, cpio)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
KERNEL=${MV_KERNEL:-/boot/vmlinuz-linux}
for tool in qemu-system-x86_64 gcc node mkfs.ext4 veritysetup debugfs cpio; do
  command -v "$tool" >/dev/null || { echo "FAIL $tool is required"; exit 1; }
done
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "FAIL /dev/kvm is required"; exit 1; }
# the kernel's own release string (its module tree must be this one): read from the bzImage header, as m1/domain.env does
off=$(od -An -j0x20E -N2 -tu2 < "$KERNEL" | tr -d ' ')
krel=$(dd if="$KERNEL" bs=1 skip=$((off + 0x200)) count=128 status=none | tr -d '\0' | head -c 128 | cut -d' ' -f1)
M=/lib/modules/$krel/kernel
[ -d "$M" ] || { echo "FAIL no module tree for $krel"; exit 1; }
echo "ok   kernel $krel, modules $M"

# two fixture volumes, built and pinned the release way
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
serial_a=mv$(awk '$1 == "fixture-a" { print substr($2, 1, 18) }' "$d/table")
echo "ok   two volumes built and pinned; fixture-a serial $serial_a"

# the throwaway PID 1, linked as the image's init is (musl when present)
MUSL=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
if [ -r "$MUSL/lib/musl-gcc.specs" ]; then
  env -u CPATH -u C_INCLUDE_PATH /usr/bin/gcc -specs "$MUSL/lib/musl-gcc.specs" -static -O2 -w -o "$d/init" "$here/testdata/modelvol-qemu-init.c"
else
  gcc -static -O2 -w -o "$d/init" "$here/testdata/modelvol-qemu-init.c"
fi

initrd() {  # <m1 block> -> $d/initrd.gz
  rm -rf "$d/ird"; mkdir -p "$d/ird/rt" "$d/ird/proc" "$d/ird/sys" "$d/ird/dev" "$d/ird/tmp"
  cp "$d/init" "$d/ird/init"
  printf '%b' "$1" > "$d/ird/m1"
  cp "$d/table" "$d/ird/rt/model-volumes.table"
  cp "$M/drivers/md/dm-mod.ko.zst" "$M/drivers/md/dm-bufio.ko.zst" "$M/drivers/md/dm-verity.ko.zst" "$M/lib/reed_solomon/reed_solomon.ko.zst" "$d/ird/"
  (cd "$d/ird" && find . | cpio -o -H newc --quiet | gzip -1) > "$d/initrd.gz"
}
boot() {  # <label> [<image> <serial>] -> $d/<label>.log
  set --  "$@"
  label=$1; shift
  drives=""
  if [ $# -ge 2 ]; then drives="-drive file=$1,format=raw,if=none,id=mvd,readonly=on,cache=none -device virtio-blk-pci,drive=mvd,serial=$2"; fi
  # shellcheck disable=SC2086
  timeout 180 qemu-system-x86_64 -enable-kvm -cpu host -m 512M -smp 1 -nodefaults -display none -no-reboot \
    -kernel "$KERNEL" -initrd "$d/initrd.gz" -append "console=ttyS0 rdinit=/init panic=-1 loglevel=3" \
    -serial "file:$d/$label.log" $drives || true
}
check() {  # <label> <grep -E pattern> <what>
  if grep -qE "$2" "$d/$1.log"; then echo "ok   $1: $3"
  else echo "FAIL $1: $3"; grep MVTEST "$d/$1.log" | sed 's/^/     /'; tail -5 "$d/$1.log" | sed 's/^/     /'; fails=$((fails + 1)); fi
}
fails=0
initrd 'M1\nvol=fixture-a\n'

boot honest "$d/store/fixture-a/volume.img" "$serial_a"
check honest "^MVTEST mounted fixture-a ro=1" "mounted read-only over dm-verity against the pinned root"
check honest "^MVTEST read 3145728 bytes sha256=$want" "the file reads back byte-exact ($want)"
check honest "^MVTEST write-refused=1" "a write is refused (EROFS)"

# flip one byte inside payload.bin's first data block, on a copy of the image
cp "$d/store/fixture-a/volume.img" "$d/tampered.img"
blk=$(debugfs -R "bmap /payload.bin 0" "$d/tampered.img" 2>/dev/null | tail -1)
case "$blk" in ''|*[!0-9]*) echo "FAIL could not locate payload.bin's first block ($blk)"; exit 1 ;; esac
python3 -c "import sys; f=open(sys.argv[1],'r+b'); f.seek(int(sys.argv[2])*4096+17); b=f.read(1); f.seek(int(sys.argv[2])*4096+17); f.write(bytes([b[0]^1])); f.close()" "$d/tampered.img" "$blk"
boot tampered "$d/tampered.img" "$serial_a"
check tampered "^MVTEST read-failed .*(Input/output error|I/O error)" "a flipped data byte is an I/O error, never different bytes"

boot wrongimage "$d/store/fixture-b/volume.img" "$serial_a"
check wrongimage "^MVTEST mount-refused fixture-a" "another volume's image under this serial is refused"

boot nodisk
check nodisk "^MVTEST mount-refused fixture-a: its disk is not attached" "no disk: refused"

[ $fails = 0 ] && echo "modelvol qemu: PASS" || { echo "modelvol qemu: FAIL ($fails)"; exit 1; }
