#!/bin/sh
# A guest image - and so its launch measurement - must be a function of the bundle's BYTES, not of how the bundle
# file is stored or who builds it. Local, no guest.
#
#   R1  the M4a image and its predicted measurement are identical whether the bundle file is 0644 or 0600
#       (the 2026-09-24 defect: guestd stages 0600, and the measurement moved)
#   R2  every archive entry is owned 0:0, whoever built it
#   R3  modes are exactly the normalised set: dirs 0755, files 0644, and 0755 for precisely the files something
#       executes - no mode inherited from the build host's library install
#   R4  the plane image (build-plane-guest.sh) is likewise identical for a 0644 and a 0600 bundle
#
#   usage: test-image-repro.sh <app.bundle> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: test-image-repro.sh <app.bundle> [workdir]}
W=${2:-$HOME/enclave-bench/image-repro-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
cp "$BUNDLE" "$W/open.bundle"; chmod 0644 "$W/open.bundle"
cp "$BUNDLE" "$W/closed.bundle"; chmod 0600 "$W/closed.bundle"

for m in open closed; do "$here/build-app-guest.sh" "$W/$m.bundle" "$W/app-$m.cpio.gz" 1 > "$W/app-$m.txt"; done
pred() { sed -n 's/^predicted measurement: //p' "$W/app-$1.txt"; }
echo "   0644 bundle: $(sha256sum "$W/app-open.cpio.gz" | cut -c1-16)  $(pred open | cut -c1-24)"
echo "   0600 bundle: $(sha256sum "$W/app-closed.cpio.gz" | cut -c1-16)  $(pred closed | cut -c1-24)"
cmp -s "$W/app-open.cpio.gz" "$W/app-closed.cpio.gz" && [ -n "$(pred open)" ] && [ "$(pred open)" = "$(pred closed)" ] \
  && r=ok || r=no
check "R1 the M4a image and its predicted measurement do not depend on the bundle file's mode" $r

gzip -dc "$W/app-open.cpio.gz" | cpio -itvn 2>/dev/null > "$W/app.lst"
awk '$3 != 0 || $4 != 0' "$W/app.lst" > "$W/not-root.lst"
[ -s "$W/app.lst" ] && [ ! -s "$W/not-root.lst" ] && r=ok || r=no
check "R2 every entry of the image is owned 0:0 ($(wc -l < "$W/app.lst") entries)" $r

r=ok
awk '{print $1, $NF}' "$W/app.lst" > "$W/modes.lst"
grep -v '^drwxr-xr-x \|^-rw-r--r-- \|^-rwxr-xr-x ' "$W/modes.lst" && r=no
execs=$(awk '$1 == "-rwxr-xr-x" {print $2}' "$W/modes.lst" | LC_ALL=C sort | tr '\n' ' ')
echo "   executable: $execs"
[ "$execs" = "front init rt/ld-linux-x86-64.so.2 rt/wasmtime " ] || r=no
check "R3 modes are the normalised set, executable exactly where something executes" $r

for m in open closed; do "$here/build-plane-guest.sh" "$W/$m.bundle" "$W/plane-$m.cpio.gz" > "$W/plane-$m.txt"; done
cmp -s "$W/plane-open.cpio.gz" "$W/plane-closed.cpio.gz" && r=ok || r=no
check "R4 the plane image does not depend on the bundle file's mode either" $r

echo
echo "image-repro: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")  (workdir $W)"
exit $fails
