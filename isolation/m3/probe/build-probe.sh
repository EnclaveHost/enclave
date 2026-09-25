#!/bin/sh
# A PROBE initrd: the production guest image (build-domain.sh) plus /probe.ko, appended as a second newc archive
# (initramfs unpacks concatenated archives in order). dominit loads /probe.ko once, after its guards, and says so.
# Its hash is never a production image's. Build the module first against the kernel that will boot it:
#   make -C <that kernel's prepared tree> M=isolation/m3/probe KBUILD_MODPOST_WARN=1 modules
#   usage: build-probe.sh <module.ko> <out.cpio.gz> [vcpus=1]
set -e
here=$(cd "$(dirname "$0")" && pwd)
ko=${1:?usage: build-probe.sh <module.ko> <out.cpio.gz> [vcpus]}; out=${2:?}; vcpus=${3:-1}
sh "$here/../build-domain.sh" "$out.base" "$vcpus" > "$out.build.log"
d=$(mktemp -d); trap 'rm -rf "$d" "$out.base"' EXIT
cp "$ko" "$d/probe.ko"
find "$d" -exec touch -h -d @0 {} +
(cat "$out.base"; cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible 2>/dev/null | gzip -n -9) > "$out"
echo "probe initrd $out sha256 $(sha256sum "$out" | cut -c1-64) (NOT a production medium)"
echo "  base   $(sha256sum "$out.base" | cut -c1-64)"
echo "  module $(sha256sum "$ko" | cut -c1-64) $(basename "$ko")"
