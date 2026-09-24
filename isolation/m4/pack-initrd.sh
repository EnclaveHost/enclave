#!/bin/sh
# Pack a guest's initramfs so that its bytes - and so the launch measurement - depend ONLY on the files' contents
# and names, never on who built it or how its inputs happened to be stored.
#
# WHY. The measured image used to carry three things a verifier cannot know:
#   - the BUILDER's uid and gid, which cpio records for every entry;
#   - the input bundle's file MODE, which `cp` carries into the image;
#   - the build host's modes for its shared libraries (libc 0755 here, libgcc_s 0644).
# Measured 2026-09-24 (test-guestd.sh G3): guestd stages bundles at 0600, the same bundle at 0644 gave a
# DIFFERENT image and a different launch measurement, and a verifier recomputing the measurement from the bundle
# alone could not have matched it. So every mode is set here, explicitly; ownership is 0:0; times are 0.
#
# Executable: exactly the files something executes - /init (the kernel), /front (init), the ELF interpreter
# (init, directly) and the runtime. Everything else is 0644: a shared library is mapped by the loader, and mmap
# does not consult the execute bit.
#
#   usage: pack-initrd.sh <dir> <out.cpio.gz>
set -e
d=${1:?usage: pack-initrd.sh <dir> <out.cpio.gz>}; out=${2:?usage: pack-initrd.sh <dir> <out.cpio.gz>}
find "$d" -type d -exec chmod 0755 {} +
find "$d" -type f -exec chmod 0644 {} +
for x in init front rt/ld-linux-x86-64.so.2 rt/wasmtime; do
  [ -f "$d/$x" ] && chmod 0755 "$d/$x"
done
find "$d" -exec touch -h -d @0 {} +
(cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible --owner=0:0 2>/dev/null | gzip -n -9) > "$out"
