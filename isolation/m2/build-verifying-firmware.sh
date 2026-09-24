#!/bin/sh
# Build an AmdSevX64 OVMF: the firmware that actually VERIFIES the SEV kernel hash table.
#
# The BINARY is not in this repository - it is 4 MiB of build output - so this script is what makes it
# reproducible. It writes to ~/.cache/enclave-isolation/fwbuild/, which is where m1/domain.env expects to find
# it, and domain.env fails loudly if it is missing rather than silently falling back to a firmware that does not
# verify.
#
#   sh isolation/m2/build-verifying-firmware.sh          # RELEASE, the one the suites use
#   BUILD_TARGET=DEBUG sh isolation/m2/build-verifying-firmware.sh   # refusals carry the verifier's own words
#
# Measured on this host (2026-09-24): RELEASE sha256 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
#                                     DEBUG   sha256 50c063542f9886f8b3ec67ebe698ae1d617b7691bef89bb6eff4a34566930ec2
# A build on another host will differ; what matters is that verify-firmware.sh and the review lane's substitution
# fixture both pass against whatever this produces.
#
# WHY: /usr/share/edk2-ovmf/x64/OVMF.4m.fd is OvmfPkgX64, which links BlobVerifierLibNull, so it never compares
# the kernel, initrd and command line it is served against the hash table the launch digest commits to. Measured:
# that firmware boots with kernel-hashes=off, i.e. with no table at all, which a verifying build refuses. Only
# OvmfPkg/AmdSev/AmdSevX64.dsc links BlobVerifierLibSevHashes. Arch packages no AmdSev variant, and there is no
# root on this host, so nasm and iasl are built from source first.
set -e
P=$HOME/.cache/enclave-isolation/fwbuild
export PATH=$P/tools/bin:$PATH
mkdir -p $P/tools $P/src
cd $P/src

step() { echo "=== $* ==="; }

if ! command -v nasm >/dev/null; then
  step "nasm from source (edk2 assembles the reset vector with it)"
  [ -d nasm ] || git clone --depth 1 -b nasm-2.16.03 https://github.com/netwide-assembler/nasm.git
  cd nasm && ./autogen.sh >/dev/null 2>&1 && ./configure --prefix=$P/tools >/dev/null && make -j8 >/dev/null 2>&1
  make install >/dev/null 2>&1 || install -m755 nasm ndisasm $P/tools/bin/
  cd $P/src
fi
command -v nasm && nasm -v

if ! command -v iasl >/dev/null; then
  step "iasl from ACPICA (edk2 compiles ACPI tables with it)"
  [ -d acpica ] || git clone --depth 1 https://github.com/acpica/acpica.git
  cd acpica && make -j8 >/dev/null 2>&1
  mkdir -p $P/tools/bin && install -m755 generate/unix/bin*/iasl $P/tools/bin/ 2>/dev/null || install -m755 generate/unix/bin/iasl $P/tools/bin/
  cd $P/src
fi
command -v iasl && iasl -v 2>&1 | head -2

if ! command -v mcopy >/dev/null; then
  step "mtools from source (the AmdSev prebuild builds a GRUB image with mcopy)"
  cd $P/src
  [ -f mtools.tar.gz ] || curl -fsSL -o mtools.tar.gz https://ftp.gnu.org/gnu/mtools/mtools-4.0.43.tar.gz
  [ -d mtools-4.0.43 ] || tar xf mtools.tar.gz
  cd mtools-4.0.43 && ./configure --prefix=$P/tools >/dev/null && make -j8 >/dev/null 2>&1
  install -m755 mcopy mmd mformat $P/tools/bin/ 2>/dev/null || make install >/dev/null 2>&1
  cd $P/src
fi
command -v mcopy && mcopy --version 2>&1 | head -1

step "the AmdSev GRUB prebuild's module list"
# Arch's GRUB ships neither linuxefi (a Fedora patch, merged upstream into the "linux" module, which stays) nor
# sevsecret (injected-secret disk unlock). Both belong to the AmdSev encrypted-disk flow and not to the QEMU
# -kernel path this project boots, and BlobVerifierLibSevHashes is untouched by either - but it does mean the
# firmware this produces is NOT suitable for that other flow. The review lane's no-table run saw exactly that:
# the boot manager fell through to the embedded GRUB and it failed on the missing sevsecret module.
if [ -f $P/src/edk2/OvmfPkg/AmdSev/Grub/grub.sh ]; then
  sed -i '/^            linuxefi$/d; /^            sevsecret$/d' $P/src/edk2/OvmfPkg/AmdSev/Grub/grub.sh
fi

step "edk2"
[ -d edk2 ] || git clone --depth 1 -b edk2-stable202608 --recurse-submodules --shallow-submodules https://github.com/tianocore/edk2.git
cd edk2
step "BaseTools"
make -C BaseTools -j8 >/dev/null 2>&1 || make -C BaseTools
. ./edksetup.sh BaseTools >/dev/null
step "AmdSevX64 (the verifying firmware)"
T=${BUILD_TARGET:-RELEASE}
build -p OvmfPkg/AmdSev/AmdSevX64.dsc -a X64 -t GCC -b "$T" -n 8
F=$(find Build -name OVMF.fd -path "*AmdSev*" -path "*${T}*" | head -1)
echo "FIRMWARE: $F"
ls -l "$F"
sha256sum "$F"
OUT=$P/OVMF.amdsev.fd
[ "$T" = DEBUG ] && OUT=$P/OVMF.amdsev.debug.fd
cp "$F" "$OUT"
echo "COPIED to $OUT"
