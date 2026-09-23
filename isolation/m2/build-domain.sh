#!/bin/sh
# Build one M2 app domain: M1's reproducible initramfs, now serving. It holds PID 1 (dominit.c), the
# front (TLS and attestation on the domain's one vsock port), the runtime and its shared libraries,
# exactly ONE app (a wasi:http component) and that app's sha256. Same inputs -> same bytes, so the
# SNP launch digest can be predicted (and is, below). Measured launch inputs come from ../m1/domain.env.
#
# usage: build-domain.sh <app.wasm> <out.cpio.gz> [vcpus=1]
set -e
here=$(cd "$(dirname "$0")" && pwd)
app=$1; out=$2; vcpus=${3:-1}
[ -f "$app" ] && [ -n "$out" ] || { echo "usage: build-domain.sh <app.wasm> <out.cpio.gz> [vcpus]"; exit 2; }
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
gcc -static -O2 -o "$d/init" "$here/dominit.c"
# static, and byte-reproducible for a given Go toolchain
(cd "$here" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$d/front" ./front)
mkdir -p "$d/rt" "$d/proc" "$d/sys" "$d/dev" "$d/tmp"
W=$(command -v wasmtime)
cp -L "$W" "$d/rt/wasmtime"
ldd "$W" | awk '/=>/ {print $3}' | while read -r lib; do cp -L "$lib" "$d/rt/"; done
cp "$app" "$d/app.wasm"
sha256sum "$app" | cut -c1-64 > "$d/app.sha256"
M=/lib/modules/$(uname -r)/kernel
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
   "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$d/"
find "$d" -exec touch -h -d @0 {} +
(cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible 2>/dev/null | gzip -n -9) > "$out"
echo "domain $out: app sha256 $(cat "$d/app.sha256"), $(stat -c %s "$out") bytes"
echo "front sha256 $(sha256sum "$d/front" | cut -c1-64) ($(go version | cut -d' ' -f3))"

# The launch digest this domain will have as an SNP guest (run-domain.sh uses the same kernel,
# command line, firmware and vCPU signature). vCPU count is part of the identity; devices are not.
. "$here/../m1/domain.env"
~/.local/bin/sev-snp-measure --mode snp --vcpus "$vcpus" --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 \
  --vmm-type QEMU --ovmf "$OVMF" --kernel "$KERNEL" --initrd "$out" --append "$APPEND" \
  | sed 's/^/predicted measurement: /'
