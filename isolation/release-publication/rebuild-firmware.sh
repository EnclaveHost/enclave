#!/bin/sh
# Rebuild the VERIFYING firmware (OVMF AmdSevX64, RELEASE) of a domain release from PINNED sources, in a directory of
# the caller's choosing, and compare it with an expected sha256. isolation/m2/build-verifying-firmware.sh made the
# firmware of release 0181bce3 (and writes into ~/.cache/enclave-isolation/fwbuild, which m1/domain.env reads); this
# script pins everything that one left to a tag or a branch head, and never writes outside <workdir>.
#
#   usage: rebuild-firmware.sh <workdir> [expected-sha256 [build-inputs dir]]
#   e.g.   rebuild-firmware.sh ~/enclave-bench/pub/fw 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 \
#            isolation/release-publication/release-0181bce3/firmware-inputs
#
# BUILD-TIME INPUTS that no source pins, found by rebuilding 0181bce3's firmware (the first rebuild differed in exactly
# these two, and in nothing else):
#   - the AmdSev GRUB image's memdisk: grub.sh makes a FAT image with mkfs.msdos (volume ID from the clock) and copies
#     grub.cfg into it with mcopy (directory-entry times from the clock, in LOCAL time). Pinned here by a volume ID, a
#     SOURCE_DATE_EPOCH and a TZ (build.env).
#   - the LENGTH of the edk2 tree's absolute path: GenFw zeroes each module's CodeView entry but keeps its size, which
#     follows the .dll path, so a module whose section ends near an alignment boundary grows or shrinks by 64 bytes
#     with it (StatusCodeHandlerPei did, between a 52- and a 54-character path). The tree is cloned at a padded name
#     so its path has EDK2_PATH_LEN characters (build.env); the directory NAME itself does not reach the bytes.
# NOT an input, though EDK2 draws it at random per build: StackCookieValues{32,64}.json. AmdSevX64 links StackCheckLibNull
# into every module, so no cookie value is read or reaches the firmware (enclave-e3; checked: none of the 200 values
# occurs in any module or in OVMF.fd, and a rebuild without the original files matches).
# With a build-inputs dir, the build uses its build.env; without one, it pins a fresh volume ID and time (below) and
# saves them to <workdir>/build-inputs, so the firmware it makes can be rebuilt exactly later.
#
# What is pinned here, and why each matters to the bytes:
#   - edk2 at a COMMIT (the edk2-stable202608 tag's), and every submodule at the commit that tree records
#     (edk2-submodules.txt, checked after the clone; the line marked "-" is a submodule that tree leaves uninitialized);
#   - the one change to that tree: patches/edk2-amdsev-grub-modules.patch (the AmdSev GRUB image's module list: Arch's
#     GRUB ships no linuxefi.mod or sevsecret.mod; see the patch's own comment);
#   - nasm and acpica (iasl) at commits, mtools as a tarball with its sha256: build tools, built from source because
#     the build host has no root.
# What is NOT pinned here, and is recorded instead (versions.txt): the host's gcc, binutils, python3 and make, and the
# host's GRUB (grub-mkimage and /usr/lib/grub/x86_64-efi), whose modules the AmdSev prebuild puts into the firmware
# volume. A different host toolchain or GRUB gives different bytes; the expected sha256 then fails, by design.
set -e
out=${1:?usage: rebuild-firmware.sh <workdir> [expected-sha256]}
want=${2:-}
inputs=${3:-}
here=$(cd "$(dirname "$0")" && pwd)
[ -z "$inputs" ] || inputs=$(cd "$inputs" && pwd)
EDK2_COMMIT=2970e5699ba6267f3384ffab20f96647578aebc8   # tag edk2-stable202608
NASM_COMMIT=cd37b81b320ead83ca5a6bbce5da0a6456663bc6   # tag nasm-2.16.03
ACPICA_COMMIT=98bbab7dbae0ff7941c4cf08d46f5d30978f809e # iasl 20260408 (build-verifying-firmware.sh took the branch head)
MTOOLS_URL=https://ftp.gnu.org/gnu/mtools/mtools-4.0.43.tar.gz
MTOOLS_SHA256=8866666fa06906ee02c709f670ae6361c5ac2008251ed825c43d321c06775718
[ ! -e "$out" ] || [ -z "$(ls -A "$out")" ] || { echo "rebuild-firmware.sh: $out is not empty" >&2; exit 2; }
mkdir -p "$out/src" "$out/tools/bin"
out=$(cd "$out" && pwd)
export PATH=$out/tools/bin:$PATH
cd "$out/src"
step() { echo "=== $* ==="; }
at() { [ "$(git -C "$1" rev-parse HEAD)" = "$2" ] || { echo "rebuild-firmware.sh: $1 is not at $2" >&2; exit 1; }; }

step "nasm $NASM_COMMIT"
git clone -q --depth 1 -b nasm-2.16.03 https://github.com/netwide-assembler/nasm.git && at nasm $NASM_COMMIT
(cd nasm && ./autogen.sh >/dev/null 2>&1 && ./configure --prefix="$out/tools" >/dev/null && make -j8 >/dev/null 2>&1 &&
 install -m755 nasm ndisasm "$out/tools/bin/")

step "acpica (iasl) $ACPICA_COMMIT"
git init -q acpica && git -C acpica fetch -q --depth 1 https://github.com/acpica/acpica.git $ACPICA_COMMIT &&
  git -C acpica checkout -q FETCH_HEAD && at acpica $ACPICA_COMMIT
(cd acpica && make -j8 iasl >/dev/null 2>&1 && install -m755 generate/unix/bin/iasl "$out/tools/bin/")

step "mtools 4.0.43"
curl -fsSL -o mtools.tar.gz $MTOOLS_URL
echo "$MTOOLS_SHA256  mtools.tar.gz" | sha256sum -c --quiet
tar xf mtools.tar.gz && (cd mtools-4.0.43 && ./configure --prefix="$out/tools" >/dev/null && make -j8 >/dev/null 2>&1 &&
 install -m755 mcopy mmd mformat "$out/tools/bin/")

# the edk2 tree's directory: "edk2", padded with "_" to the recorded path length (see BUILD-TIME INPUTS)
want_len=$( [ -n "$inputs" ] && . "$inputs/build.env" && echo "$EDK2_PATH_LEN" || printf %s "$out/src/edk2" | wc -c)
E=edk2; while [ $(printf %s "$out/src/$E" | wc -c) -lt "$want_len" ]; do E=${E}_; done
[ $(printf %s "$out/src/$E" | wc -c) -eq "$want_len" ] ||
  { echo "rebuild-firmware.sh: $out/src/edk2 is longer than the recorded $want_len characters: use a shorter workdir" >&2; exit 2; }
echo "edk2 tree: $out/src/$E ($want_len characters)"

step "edk2 $EDK2_COMMIT and its submodules"
git clone -q --depth 1 -b edk2-stable202608 --recurse-submodules --shallow-submodules https://github.com/tianocore/edk2.git "$E"
at "$E" $EDK2_COMMIT
git -C "$E" submodule status --recursive | awk '{print $1, $2}' > submodules.txt
diff "$here/edk2-submodules.txt" submodules.txt || { echo "rebuild-firmware.sh: edk2's submodules differ from the pins" >&2; exit 1; }
git -C "$E" apply "$here/patches/edk2-amdsev-grub-modules.patch"

step "versions (the host tools the bytes also depend on)"
{ echo "edk2 $EDK2_COMMIT"; echo "nasm $(nasm -v | sed 's/ compiled on .*//')";   # no build date: versions.txt goes into the manifest echo "iasl $(iasl -v 2>&1 | grep -o 'version [0-9]*')"
  echo "mtools $(mcopy --version | head -1)"; echo "gcc $(gcc --version | head -1)"; echo "ld $(ld --version | head -1)"
  echo "python3 $(python3 --version)"; echo "make $(make --version | head -1)"
  echo "grub-mkimage $(grub-mkimage --version)"; echo "grub modules $(pacman -Qo /usr/lib/grub/x86_64-efi/linux.mod 2>/dev/null | sed 's/.* is owned by //')"
} | tee "$out/versions.txt"

step "build-time inputs"
mkdir -p "$out/build-inputs"
if [ -n "$inputs" ]; then
  cp "$inputs/build.env" "$out/build-inputs/"
else
  now=$(date +%s)
  printf 'FAT_VOLID=%08X\nSOURCE_DATE_EPOCH=%s\nTZ=UTC0\nEDK2_PATH_LEN=%s\n' $((now & 0xFFFFFFFF)) $now $(printf %s "$out/src/edk2" | wc -c) > "$out/build-inputs/build.env"
fi
. "$out/build-inputs/build.env"; export SOURCE_DATE_EPOCH TZ
# mkfs.msdos takes the volume ID from the clock unless given one: a wrapper ahead of it on PATH passes -i
real=$(command -v mkfs.msdos)
printf '#!/bin/sh\nexec %s -i %s "$@"\n' "$real" "$FAT_VOLID" > "$out/tools/bin/mkfs.msdos"; chmod +x "$out/tools/bin/mkfs.msdos"
echo "memdisk: volume ID $FAT_VOLID, SOURCE_DATE_EPOCH $SOURCE_DATE_EPOCH, TZ $TZ; mkfs.msdos $(pacman -Qo "$real" 2>/dev/null | sed 's/.* is owned by //')" | tee -a "$out/versions.txt"

step "BaseTools"
cd "$E"
make -C BaseTools -j8 >/dev/null 2>&1 || make -C BaseTools
. ./edksetup.sh BaseTools >/dev/null
step "AmdSevX64 RELEASE (with a build report: the libraries each module links)"
build -p OvmfPkg/AmdSev/AmdSevX64.dsc -a X64 -t GCC -b RELEASE -n 8 -y "$out/build-report.txt" -Y LIBRARY -Y FLASH > "$out/build.log" 2>&1 ||
  { tail -30 "$out/build.log"; exit 1; }
cp Build/AmdSev/RELEASE_GCC/FV/OVMF.fd "$out/OVMF.amdsev.fd"
got=$(sha256sum "$out/OVMF.amdsev.fd" | cut -c1-64)
echo "FIRMWARE $got $out/OVMF.amdsev.fd"
if [ -n "$want" ]; then
  [ "$got" = "$want" ] && echo "MATCH: the rebuilt firmware is byte-identical to $want" ||
    { echo "MISMATCH: expected $want" >&2; exit 1; }
fi
