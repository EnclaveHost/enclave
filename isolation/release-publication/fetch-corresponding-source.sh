#!/bin/sh
# Fetch the CORRESPONDING SOURCE of the copyleft components in domain release 0181bce3 (and the recipes that built the
# binaries it carries), into a directory of the caller's choosing, and write SHA256SUMS for what it fetched. Nothing
# here is published by this script; the files are large and stay outside git, with their hashes in
# release-0181bce3/SOURCES.md.
#
#   usage: fetch-corresponding-source.sh <outdir>
#
# Every pin below is read from the release's own bytes or from the recipe of the package that produced them (the
# Arch Linux packaging repository at the tag of the INSTALLED package version, release-0181bce3/INVENTORY.md):
#   - linux 7.2.3.arch1-2 (kernel + the five guest modules): kernel.org tarball + Arch's patch, sha256 as in the
#     PKGBUILD; the config is config.x86_64 in the packaging tarball (and the image's own IKCONFIG, see the inventory);
#   - glibc 2.44+r24+g16be1518495f-1 (libc.so.6, libm.so.6, ld-linux-x86-64.so.2; libc.a in the static init): the
#     commit the PKGBUILD names;
#   - gcc 16.2.1+r23+gd564253eb6c8-1 (libgcc_s.so.1; libgcc and crt objects in the static init): the commit the
#     PKGBUILD names, and its patches (in the packaging tarball);
#   - grub 2:2.14-1 (the GRUB image in the firmware volume): tag grub-2.14, gnulib at the GNULIB_REVISION that tag's
#     bootstrap.conf checks out, and Arch's patches (in the packaging tarball);
#   - the packaging repositories themselves (PKGBUILD, patches, config) for those four and for wasmtime and go.
# git trees are packed with `git archive | xz -9 -T1`; the SHA256SUMS line is what a reviewer checks, not the process.
set -e
out=${1:?usage: fetch-corresponding-source.sh <outdir>}
here=$(cd "$(dirname "$0")" && pwd)
[ ! -e "$out" ] || [ -z "$(ls -A "$out")" ] || { echo "fetch-corresponding-source.sh: $out is not empty (SHA256SUMS lists every file in it)" >&2; exit 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd); cd "$out"
w=$(mktemp -d -p "$out" .work.XXXX); trap 'rm -rf "$w"' EXIT
get() { # url sha256|- file
  curl -fsSL -o "$3" "$1"
  [ "$2" = - ] || echo "$2  $3" | sha256sum -c --quiet
}
pack() { # url commit name
  git init -q "$w/$3"
  git -C "$w/$3" fetch -q --depth 1 "$1" "$2"
  [ "$(git -C "$w/$3" rev-parse FETCH_HEAD)" = "$2" ] || { echo "fetch: $3 is not at $2" >&2; exit 1; }
  git -C "$w/$3" archive --format=tar --prefix="$3/" FETCH_HEAD | xz -9 -T1 > "$3.tar.xz"
  rm -rf "$w/$3"
}
ARCH=https://gitlab.archlinux.org/archlinux/packaging/packages

echo "== linux 7.2.3.arch1-2"
get https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-7.2.3.tar.xz 8ba259e8e7b13ec6ef0941c8a39ad90b24bd4a4d6c0010ba6bafb794550ecd03 linux-7.2.3.tar.xz
get https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-7.2.3.tar.sign - linux-7.2.3.tar.sign
get https://github.com/archlinux/linux/releases/download/v7.2.3-arch1/linux-v7.2.3-arch1.patch.zst 8c917e7ba5cbd93491f18d11d6adbdcb1ea64fd6f8b47a0fce5d04a0ac9aa4f6 linux-v7.2.3-arch1.patch.zst
get https://github.com/archlinux/linux/releases/download/v7.2.3-arch1/linux-v7.2.3-arch1.patch.zst.sig - linux-v7.2.3-arch1.patch.zst.sig
pack $ARCH/linux.git fae9fc0d8c9531fe1875b9032fff999e714e6527 arch-packaging-linux-7.2.3.arch1-2

echo "== glibc 2.44+r24+g16be1518495f-1"
pack https://forge.sourceware.org/glibc/glibc-mirror 16be1518495f1fa05481b0182c4e4c24927c62df glibc-16be1518495f
pack $ARCH/glibc.git 7a444d10dd6b85918b891bf386f03c68c548de3b arch-packaging-glibc-2.44+r24+g16be1518495f-1

echo "== gcc 16.2.1+r23+gd564253eb6c8-1 (libgcc)"
pack https://forge.sourceware.org/gcc/gcc d564253eb6c859e266d3cae18e82fb4db9a88316 gcc-d564253eb6c8
pack $ARCH/gcc.git 13b07516f792b0b11ef818300f9d7a9341f31b5b arch-packaging-gcc-16.2.1+r23+gd564253eb6c8-1

echo "== grub 2:2.14-1"
pack https://git.savannah.gnu.org/git/grub.git d38d6a1a9b79427848976f53d474392cd29c2a71 grub-2.14
pack https://git.savannah.gnu.org/git/gnulib.git 9f48fb992a3d7e96610c4ce8be969cff2d61a01b gnulib-9f48fb99
pack $ARCH/grub.git 984cb119d9ecb39d692d4a4aa1741291278b5db0 arch-packaging-grub-2-2.14-1

echo "== the GRUB image's own recipe inside the firmware (GPL-3.0 corresponding source includes the build scripts)"
# edk2's OvmfPkg/AmdSev/Grub at the firmware's commit: grub.sh runs grub-mkimage with GRUB 2:2.14-1's modules and a
# memdisk holding grub.cfg; Grub.inf puts the image into the firmware volume. The patch is the module-list change the
# firmware was built with (rebuild-firmware.sh applies it); the memdisk's pinned volume ID and time are build.env.
E=https://raw.githubusercontent.com/tianocore/edk2/2970e5699ba6267f3384ffab20f96647578aebc8/OvmfPkg/AmdSev/Grub
get $E/grub.sh 95125420326d201e70822bf0ea5c3f8acc45f59a0e47f3bcf145a3e789772ecf edk2-2970e569-AmdSev-Grub-grub.sh
get $E/grub.cfg 203a130207d7b65b6653a944cdc1f794a86bd5603bb665613f7690dfaf3c496f edk2-2970e569-AmdSev-Grub-grub.cfg
get $E/Grub.inf 081ddb87524da56c402c5b4de74546fbf5b44b141cb4eb87a081ede21a259ee2 edk2-2970e569-AmdSev-Grub-Grub.inf
cp "$here/patches/edk2-amdsev-grub-modules.patch" edk2-amdsev-grub-modules.patch
cp "$here/release-0181bce3/firmware-inputs/build.env" firmware-build.env

echo "== go 1.27.0 (permissive; its LICENSE and PATENTS are read from here)"
get https://go.dev/dl/go1.27.0.src.tar.gz 7002403d7cc44529ef6d26f69a44818263395ead7c16c05a5808ae047ebeb0e5 go1.27.0.src.tar.gz

echo "== the Rust standard library's notices (core, alloc and std are compiled into wasmtime; rustc 1.98.0 = 88d9e12a)"
R=https://raw.githubusercontent.com/rust-lang/rust/88d9e12ae178fab0fb5cc050a94da85685d449ea
get $R/COPYRIGHT 172020dbfd5b53a226dfde77616190a48dcff519b0bc0e6deb91a8450782c4af rust-1.98.0-COPYRIGHT
get $R/LICENSE-APACHE 62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a rust-1.98.0-LICENSE-APACHE
get $R/LICENSE-MIT b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1 rust-1.98.0-LICENSE-MIT

echo "== recipes of the permissive components (wasmtime, go)"
pack $ARCH/wasmtime.git 72b41ee7146e59804c48252d1ff1fed9cb1ba6f7 arch-packaging-wasmtime-48.0.1-1
pack $ARCH/go.git 89d6ba9a28c195e249320031457a0dfb6694b6f6 arch-packaging-go-2-1.27.0-1

rm -rf "$w"; trap - EXIT
sha256sum $(ls | grep -v '^SHA256SUMS$' | sort) > SHA256SUMS
cat SHA256SUMS
