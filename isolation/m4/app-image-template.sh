#!/bin/sh
# The M4a image TEMPLATE: everything in a per-app guest's measured initramfs EXCEPT the app - the init, the front,
# the runtime set (runtime-set.sh, the same composition the plane admits), the guest modules and the empty mount
# points. assemble-app-image.sh adds one app to it; build-app-guest.sh does both; domain-release.sh publishes the
# template so a verifier can reassemble the same image from pinned files instead of from this host's binaries.
#
#   usage: app-image-template.sh <dir>     (dir must not exist or be empty)
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$here/../m2
t=${1:?usage: app-image-template.sh <dir>}
if [ -e "$t" ] && [ -n "$(ls -A "$t")" ]; then echo "app-image-template.sh: $t is not empty" >&2; exit 2; fi
mkdir -p "$t"
# init links musl (MIT), never glibc (Codex, 2026-09-25): musl built by m2/build-musl.sh from a pinned, signature-checked
# source into this user's cache, compiled with the host's /usr/bin/gcc named explicitly (the image's init bytes are a
# function of both; a change in either fails the install's reproduction gate, closed). Besides musl, the link takes only
# GCC's crtbeginS.o/crtendS.o (GCC Runtime Library Exception). The predictor never rebuilds init: it reads the
# release's own template (assemble-app-image.sh copies it as it is).
MUSL=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
[ -r "$MUSL/lib/musl-gcc.specs" ] && [ -r "$MUSL/lib/libc.a" ] || {
  echo "app-image-template.sh: no musl at $MUSL (build it with: sh isolation/m2/build-musl.sh)" >&2; exit 2; }
# gcc honours CPATH/C_INCLUDE_PATH/LIBRARY_PATH/GCC_EXEC_PREFIX/COMPILER_PATH from its environment, and CPATH acts as
# -I, searched BEFORE the specs' musl headers: none of them may reach the measured init (enclave-e3's L1)
env -u CPATH -u C_INCLUDE_PATH -u LIBRARY_PATH -u GCC_EXEC_PREFIX -u COMPILER_PATH \
  /usr/bin/gcc -specs "$MUSL/lib/musl-gcc.specs" -static -O2 -o "$t/init" "$m2/dominit.c"
# ...and it IS a static musl binary: no program interpreter, no shared library, nothing of glibc
if readelf -lW "$t/init" | grep -q INTERP || readelf -dW "$t/init" | grep -q "(NEEDED)" \
   || strings -a "$t/init" | grep -qiE "glibc|GLIBC_"; then
  echo "app-image-template.sh: $t/init is not a static musl binary; refusing" >&2; exit 2
fi
# static and byte-reproducible for a given Go toolchain, so the measurement is predictable. GOFLAGS is CLEARED: a caller's
# environment must never decide what the measured front is (a lab's -tags releaselab reaching a production guestd would
# build lab fronts; enclave-99). A LAB front is asked for by name, ISOLATION_LAB_FRONT=1, and only builds with the lab
# pins present (m2/release/labpins/, written by m2/lab-release/run-lab.sh).
tags=""
if [ "${ISOLATION_LAB_FRONT:-}" = 1 ]; then
  [ -f "$m2/release/labpins/ca.pem" ] && [ -f "$m2/release/labpins/release-key.hex" ] || {
    echo "app-image-template.sh: ISOLATION_LAB_FRONT=1 without lab pins in $m2/release/labpins" >&2; exit 2; }
  tags="-tags=releaselab"
  echo "app-image-template.sh: building a LAB front (lab relay, lab CA, lab release key): not a production image" >&2
fi
if [ "${ISOLATION_DIRECT_BOOTSTRAP:-}" = 1 ]; then
  [ "${ISOLATION_LAB_FRONT:-}" != 1 ] || { echo "direct bootstrap and legacy lab pins cannot be combined" >&2; exit 2; }
  tags="-tags=bootstrapdirect"
  echo "app-image-template.sh: building owner-committed direct bootstrap front" >&2
fi
if [ "${ISOLATION_BOOTSTRAP_PORT_LAB:-}" = 1 ]; then
  [ "${ISOLATION_DIRECT_BOOTSTRAP:-}" = 1 ] || { echo "bootstrap port lab requires direct bootstrap" >&2; exit 2; }
  tags="-tags=bootstrapdirect,bootstrapportlab"
  echo "app-image-template.sh: isolated hardware test ports; production chain and trust roots retained" >&2
fi
(cd "$m2" && GOFLAGS= CGO_ENABLED=0 go build $tags -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$t/front" ./front)
mkdir -p "$t/proc" "$t/sys" "$t/dev" "$t/tmp"
"$here/runtime-set.sh" compose "$t/rt"
# Capability is part of the pinned release, checked by the predictor before
# admitting a V3 port bundle to this front. Older releases carry no marker.
printf '1\n' > "$t/rt/protected-ports.enabled"
# Encrypted volumes (isolation/m2/encvol): the engine is compiled into /front (rclone v1.67.0's crypt cipher, vendored,
# and a native S3 sync); this marker states that the init and front in this image carry the volume trailer and plane.
# guestd reports it as supports.encVolumes and the supervisor admits encVolumes configs only where it is set.
printf '1\n' > "$t/rt/encvol.enabled"
if [ "${ISOLATION_DIRECT_BOOTSTRAP:-}" = 1 ]; then printf '1\n' > "$t/rt/direct-bootstrap.enabled"; fi
if [ "${ISOLATION_BOOTSTRAP_PORT_LAB:-}" = 1 ]; then printf '19443 19445 19446\n' > "$t/rt/bootstrap-lab-ports"; fi
# The guest kernel's module tree is named after the GUEST kernel, not the host's: see ../m1/domain.env.
. "$here/../m1/domain.env"
M=/lib/modules/$GUEST_KREL/kernel
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
   "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$t/"
# Model volumes (m2/modelvol.h): the release's PINNED table (MODEL_VOLUME_TABLE, from `metal/volumes.mjs table`: name,
# dm-verity root, salt, geometry, image bytes, preload, graph, distribution pin) and the device-mapper modules init
# mounts them with. Measured with the rest of the template, so adding a model is a release decision; a deployment can
# only ever mount a name this table pins, against the root it pins. No table: no capability, nothing added.
if [ -n "${MODEL_VOLUME_TABLE:-}" ]; then
  awk 'BEGIN { ok = 1 }
       { if (NF != 11 || $0 ~ /  / || $1 !~ /^[a-z0-9][a-z0-9._-]*$/ || length($1) > 64 || length($2) != 64 || $2 !~ /^[0-9a-f]+$/ ||
             $3 !~ /^[0-9a-f]+$/ || length($3) % 2 || length($3) > 256 || $4 != 4096 || $5 != 4096 || $6 !~ /^[1-9][0-9]*$/ ||
             $7 !~ /^[1-9][0-9]*$/ || $7 + 0 <= $6 + 0 || $8 !~ /^[1-9][0-9]*$/ || $8 % 4096 != 0 || $8 + 0 <= ($7 + 0) * 4096 ||
             $9 !~ /^(ggml|sd|none)$/ || (($9 == "none") != ($10 == "-")) || length($11) != 64 || $11 !~ /^[0-9a-f]+$/ || seen[$1]++) ok = 0 }
       END { exit !ok }' "$MODEL_VOLUME_TABLE" || { echo "app-image-template.sh: MODEL_VOLUME_TABLE is not a model-volume table" >&2; exit 2; }
  [ "$(tail -c1 "$MODEL_VOLUME_TABLE" | od -An -c | tr -d ' ')" = '\n' ] || { echo "app-image-template.sh: the table must end in a newline" >&2; exit 2; }
  cp "$MODEL_VOLUME_TABLE" "$t/rt/model-volumes.table"
  chmod 0444 "$t/rt/model-volumes.table"
  cp "$M/drivers/md/dm-mod.ko.zst" "$M/drivers/md/dm-bufio.ko.zst" "$M/drivers/md/dm-verity.ko.zst" \
     "$M/lib/reed_solomon/reed_solomon.ko.zst" "$t/"
fi
