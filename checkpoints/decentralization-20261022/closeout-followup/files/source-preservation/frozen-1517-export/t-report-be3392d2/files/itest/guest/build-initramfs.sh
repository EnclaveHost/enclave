#!/bin/bash
# Guest initramfs: bash, insmod, mount and friends with their libraries, plus the GUEST kernel package's 9p and virtio-net
# modules (decompressed). Adapted from the transport repo's test/guest/build-initramfs.sh (a9f0155c). Output: $1.
set -euo pipefail
OUT=$1; KV=$2; HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT INT TERM HUP
mkdir -p $W/{bin,usr/bin,lib64,usr/lib,mod,proc,sys,dev,newroot}
for b in bash insmod mount umount mkdir ln chroot sed tee sync sleep echo printf chmod cp; do
  p=$(command -v $b) || continue; [ "$p" = "$b" ] && continue
  cp -L "$p" $W/usr/bin/; for l in $(ldd "$p" | grep -oE '/[^ ]+\.so[^ ]*'); do cp -Ln "$l" $W/usr/lib/ 2>/dev/null || true; done
done
ln -s ../usr/bin/bash $W/bin/sh; ln -s ../usr/bin/bash $W/bin/bash
cp -L /lib64/ld-linux-x86-64.so.2 $W/lib64/
for m in netfs 9pnet 9pnet_virtio 9p failover net_failover virtio_net; do
  f=$(find /usr/lib/modules/$KV -name "$m.ko.zst" | head -1); [ -n "$f" ] || { echo "module $m missing" >&2; exit 3; }
  zstd -q -d -c "$f" > $W/mod/$m.ko
done
cp "$HERE/init" $W/init; chmod 755 $W/init
(cd $W && find . -print0 | cpio --null -o -H newc --quiet) | gzip -1 > "$OUT"
