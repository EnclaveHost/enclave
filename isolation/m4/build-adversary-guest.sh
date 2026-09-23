#!/bin/sh
# Build the M4a adversary guest: the compromised-app model for one-guest-per-app. Native code with ROOT in
# its own SNP guest, aimed at another app's guest.
#
# The target has to be baked in, so this is built AFTER the victim launches: a vsock CID is assigned at launch
# and an adversary that had to scan 65k CIDs would be a worse test, not a better one. Its measurement is its
# own and differs from any app's, which is the point of N3: it can name another app in report_data, and a
# verifier pins the measurement.
#
# usage: build-adversary-guest.sh <out.cpio.gz> <vcpus> <target-cid> <target-port> <other-app-id-hex>
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$here/../m2
out=$1; vcpus=${2:-1}; tcid=$3; tport=$4; oid=$5
[ -n "$out" ] && [ -n "$tcid" ] && [ -n "$tport" ] && [ ${#oid} = 64 ] \
  || { echo "usage: build-adversary-guest.sh <out.cpio.gz> <vcpus> <target-cid> <target-port> <other-app-id-hex>"; exit 2; }
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
gcc -static -O2 -o "$d/init" "$here/advinit.c"
gcc -static -O2 -o "$d/advprobe" "$here/advprobe.c"
mkdir -p "$d/proc" "$d/sys" "$d/dev" "$d/tmp"
printf '%s %s %s\n' "$tcid" "$tport" "$oid" > "$d/adv.target"
. "$here/../m1/domain.env"
M=/lib/modules/$GUEST_KREL/kernel
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
   "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$d/"
find "$d" -exec touch -h -d @0 {} +
(cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible 2>/dev/null | gzip -n -9) > "$out"
echo "adversary_guest $out: target cid$tcid:$tport, $(stat -c %s "$out") bytes"
~/.local/bin/sev-snp-measure --mode snp --vcpus "$vcpus" --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 \
  --vmm-type QEMU --ovmf "$OVMF" --kernel "$KERNEL" --initrd "$out" --append "$APPEND" \
  | sed 's/^/predicted measurement: /'
