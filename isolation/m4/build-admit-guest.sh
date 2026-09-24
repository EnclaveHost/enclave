#!/bin/sh
# Build the M4b admission guest: the smallest image that exercises the measured SVSM's authority over a
# plane's actual artifacts.
#
# It boots at VMPL2 under COCONUT-SVSM (the m3b IGVM path, see isolation/m3/run-domain.sh), and its PID 1 is
# admitinit, which asks the SVSM to admit this plane's bundle and runtime image and prints every result. The
# image carries the artifacts themselves, so what is admitted is what the image holds - and because the
# expected digests are compiled into the SVSM, a verifier pinning the IGVM digest pins which bundle and which
# runtime this plane may admit.
#
# usage: build-admit-guest.sh <app.bundle> <out.cpio.gz> [good|tampered]
#   good      admit the bundle as it is; the SVSM must accept it and then speak for the plane
#   tampered  flip one byte first; the SVSM must REFUSE and the plane must stay unnamed and unreportable
set -e
here=$(cd "$(dirname "$0")" && pwd)
bundle=$1; out=$2; mode=${3:-good}
[ -f "$bundle" ] && [ -n "$out" ] || { echo "usage: build-admit-guest.sh <app.bundle> <out.cpio.gz> [good|tampered]"; exit 2; }
case "$mode" in good|tampered) ;; *) echo "mode must be good or tampered"; exit 2 ;; esac
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

gcc -static -O2 -o "$d/init" "$here/guest/admitinit.c"
# the module is built against the GUEST kernel, not the host's: a module for the wrong release will not load
(cd "$here/guest" && make >/dev/null)
cp "$here/guest/appidmod.ko" "$d/appidmod.ko"
mkdir -p "$d/rt" "$d/proc" "$d/sys"
cp "$bundle" "$d/app.bundle"
# The wasmtime ELF only. It is dynamically linked, so ld-linux, libc, libgcc_s and libm are NOT admitted and
# the bytes that actually run include unadmitted code: this admits "the runtime image", not "the runtime".
W=$(command -v wasmtime)
cp -L "$W" "$d/rt/wasmtime"
printf '%s\n' "$mode" > "$d/admit.mode"

find "$d" -exec touch -h -d @0 {} +
(cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible 2>/dev/null | gzip -n -9) > "$out"

# What the SVSM must have been built to expect, so a mismatch is a build error and not a mystery at runtime.
BUNDLETOOL=${BUNDLETOOL:-$here/.bundle}
[ -x "$BUNDLETOOL" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)
echo "admit guest $out ($(stat -c %s "$out") bytes), mode $mode"
echo "  bundle  app id  $("$BUNDLETOOL" id "$bundle")   <- ENCLAVE_APP_IDS entry for this plane"
echo "  runtime sha256  $(sha256sum "$d/rt/wasmtime" | cut -c1-64)   <- ENCLAVE_RUNTIME_SHA256 entry"
echo "  NOTE: the wasmtime ELF only; its shared libraries are not admitted (see svsm/README.md)"
