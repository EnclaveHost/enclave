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
# The runtime SET, composed exactly as the serving plane's is (runtime-set.sh): the wasmtime ELF, its interpreter
# and shared libraries, and runtime.json. This fixture never executes the runtime, but ENCLAVE_RUNTIME_SHA256 has
# ONE meaning - the rtset digest of /rt - and a fixture admitting a different thing under the same name would be a
# second meaning. The 2026-09-24 step-2 run (15/15) predates this and staged the wasmtime ELF alone.
rmdir "$d/rt"
"$here/runtime-set.sh" compose "$d/rt"
printf '%s\n' "$mode" > "$d/admit.mode"
# The report modules are carried so the guest can PROVE it cannot use them: with every VMPCK cleared from its
# secrets page, sev-guest must refuse to probe, which is the key-absence evidence the forgeable vmpl0 tuple
# could never give (isolation/DESIGN.md section 12).
. "$here/../m1/domain.env"
M=/lib/modules/$GUEST_KREL/kernel
cp "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$d/"
mkdir -p "$d/sys/kernel/config"

# modes, ownership and times normalised, so the measurement depends on contents alone (pack-initrd.sh)
"$here/pack-initrd.sh" "$d" "$out"

# What the SVSM must have been built to expect, so a mismatch is a build error and not a mystery at runtime.
BUNDLETOOL=${BUNDLETOOL:-$here/.bundle}
[ -x "$BUNDLETOOL" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)
echo "admit guest $out ($(stat -c %s "$out") bytes), mode $mode"
echo "  bundle  app id  $("$BUNDLETOOL" id "$bundle")   <- ENCLAVE_APP_IDS entry for this plane"
set -- $("$here/runtime-set.sh" digest "$d/rt")
[ ${#2} = 64 ] || { echo "no runtime-set digest for $d/rt" >&2; exit 1; }
echo "  runtime set     $2   <- ENCLAVE_RUNTIME_SHA256 entry (rtset v1, every file in /rt: $3 $4 $5)"
