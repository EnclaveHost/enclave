#!/bin/bash
# Build the guest initramfs: bash + insmod + mount/mkdir/ln/chroot/sed/... with their shared libraries, and the 9p modules
# of the GUEST kernel package (decompressed). Output: $1 (cpio.gz). Nothing is installed on the host.
set -euo pipefail
OUT=$1; KV=$2
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p $W/{bin,usr/bin,lib64,usr/lib,mod,proc,sys,dev,newroot}
for b in bash insmod mount mkdir ln chroot sed tee sync sleep echo printf chmod; do
  p=$(command -v $b) || continue; [ "$p" = "$b" ] && continue      # shell builtins
  cp -L "$p" $W/usr/bin/; for l in $(ldd "$p" | grep -oE '/[^ ]+\.so[^ ]*'); do cp -Ln "$l" $W/usr/lib/ 2>/dev/null || true; done
done
ln -s ../usr/bin/bash $W/bin/sh; ln -s ../usr/bin/bash $W/bin/bash
cp -L /lib64/ld-linux-x86-64.so.2 $W/lib64/
for m in netfs 9pnet 9pnet_virtio 9p; do f=$(find /usr/lib/modules/$KV -name "$m.ko.zst" | head -1); zstd -q -d -c "$f" > $W/mod/$m.ko; done
cp "$(dirname "$0")/init" $W/init; chmod 755 $W/init
(cd $W && find . -print0 | cpio --null -o -H newc --quiet) | gzip -1 > "$OUT"
ls -l "$OUT"
