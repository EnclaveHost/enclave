# Corresponding source: domain release 0181bce3

For each component that release 0181bce3 ships as a binary, this lists the source that builds those bytes, and the recipe
that built them. The files are fetched by `fetch-corresponding-source.sh` into a directory outside git: 15 files,
273 MB. Their sha256 are below and in that directory's SHA256SUMS, and are what a reviewer checks.
- **Upstream tarballs** (kernel.org, go.dev) are verified against the sha256 that Arch's PKGBUILD pins.
- **git trees** are fetched at the exact commit the recipe names, then packed with `git archive | xz -9 -T1`. The pack's
  hash depends on the git and xz versions; the commit is what identifies the source.
- Nothing here has been published.

| file | sha256 | bytes | what |
|---|---|---|---|
| linux-7.2.3.tar.xz | 8ba259e8e7b13ec6ef0941c8a39ad90b24bd4a4d6c0010ba6bafb794550ecd03 | 160060344 | kernel.org release 7.2.3 (the sha256 Arch's PKGBUILD pins) |
| linux-7.2.3.tar.sign | 6f391aba3ca6830d806cbb8e729761fb13979275810ee098be4efbca1841b8d3 | 987 | its kernel.org signature (over the uncompressed tar) |
| linux-v7.2.3-arch1.patch.zst | 8c917e7ba5cbd93491f18d11d6adbdcb1ea64fd6f8b47a0fce5d04a0ac9aa4f6 | 1007 | Arch's patch v7.2.3-arch1 (73 lines: Makefile, kernel/fork.c) |
| linux-v7.2.3-arch1.patch.zst.sig | e562159507f73a8f8ee436999e0f5e444057ead55238e49032ea5165e6a8d54c | 228 | its signature |
| arch-packaging-linux-7.2.3.arch1-2.tar.xz | 7b18136937c29cf20eed6a72c216ae24ee10dfbde63d20886f4bab2a2a0eb9fd | 70528 | the recipe: PKGBUILD and **config.x86_64** (the config the image's IKCONFIG matches) at tag 7.2.3.arch1-2 (fae9fc0d) |
| glibc-16be1518495f.tar.xz | 1cc4be60fe0dfec3ff85225df44fa43f135ad99ad8228902eba0e3b4f1c8d4bd | 21610752 | glibc at commit 16be1518495f1fa05481b0182c4e4c24927c62df (release/2.44, the PKGBUILD's `_commit`) |
| arch-packaging-glibc-2.44+r24+g16be1518495f-1.tar.xz | f1c02473e2197feba037da2923ad490436ea8269cca65858f7be3412ba65b4e2 | 25588 | the recipe at tag 2.44+r24+g16be1518495f-1 (7a444d10) |
| gcc-d564253eb6c8.tar.xz | 01070ef36693e66c357f0c28b7b5842eccbb84a5f839ba48788a97ab66b25898 | 94307756 | GCC at commit d564253eb6c859e266d3cae18e82fb4db9a88316 (libgcc, libgcc_s, crt objects) |
| arch-packaging-gcc-16.2.1+r23+gd564253eb6c8-1.tar.xz | 83c65f16d801fb35ac2faf4f4dec97580db8efacc83800ec3b0f9f850db07a81 | 31360 | the recipe and its two patches at tag 16.2.1+r23+gd564253eb6c8-1 (13b07516) |
| grub-2.14.tar.xz | 0dc27b952c0f59433b99e73009ade4c15d937067e7646f393a72149cc112a6fe | 4886848 | GRUB tag grub-2.14 (d38d6a1a9b79427848976f53d474392cd29c2a71) |
| gnulib-9f48fb99.tar.xz | 787312237dcb3bafdc36f5717fa3ecc24a0c625392b3967236cdd97d6ab522b7 | 4603700 | gnulib 9f48fb992a3d7e96610c4ce8be969cff2d61a01b: grub-2.14's bootstrap.conf GNULIB_REVISION, which its bootstrap checks out |
| arch-packaging-grub-2-2.14-1.tar.xz | 1af0f26545a55cd1e4f80c9ffc05377be093ed12e0ee1e17fef0a514d46af121 | 28248 | the recipe, its three patches and two reverts, at tag 2-2.14-1 (984cb119) |
| go1.27.0.src.tar.gz | 7002403d7cc44529ef6d26f69a44818263395ead7c16c05a5808ae047ebeb0e5 | 35080395 | Go 1.27.0 (BSD-3-Clause; the standard library in template/front) |
| arch-packaging-go-2-1.27.0-1.tar.xz | c1895eab561bca971ecac2082b4cd936b48210d41272e297c493ae0b88ef6b3f | 34968 | its recipe at tag 2-1.27.0-1 (89d6ba9a) |
| arch-packaging-wasmtime-48.0.1-1.tar.xz | e176c6f93cf58587f09e03a6e3c9de75e3eee5e91c1be24878d6b1d152108d69 | 1928 | wasmtime's recipe at tag 48.0.1-1 (72b41ee7): `cargo build --release --frozen` at tag v48.0.1 |

## The firmware (EDK2 is permissive; GRUB inside it is GPL-3.0+)
The source is in git or pinned here; no tarball is needed beyond GRUB's (above).
- **edk2:** commit 2970e5699ba6267f3384ffab20f96647578aebc8 (tag edk2-stable202608), with every submodule at the
  commit that tree records (`../edk2-submodules.txt`).
- **The patch:** `../patches/edk2-amdsev-grub-modules.patch`, sha256
  8be684fe5e00f3fde0cea4dea7ab5065ba0e846206129b4167aca59811dc1079.
- **The build tools:**
  - nasm cd37b81b320ead83ca5a6bbce5da0a6456663bc6;
  - acpica 98bbab7dbae0ff7941c4cf08d46f5d30978f809e;
  - mtools 4.0.43 (sha256 8866666fa06906ee02c709f670ae6361c5ac2008251ed825c43d321c06775718).
- **The build-time inputs:** `firmware-inputs/`.
- **The script:** `../rebuild-firmware.sh`. It reproduces firmware.fd byte for byte:
  `rebuild-firmware.sh <workdir> 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
  release-0181bce3/firmware-inputs`.
- **GRUB in the firmware:** the GRUB image in it is made by grub-mkimage from GRUB 2:2.14-1's modules. That is the
  grub source and recipe above, and edk2's `OvmfPkg/AmdSev/Grub/grub.sh` with the patch.

## Rebuilding the copyleft binaries
- **The kernel and modules:**
  - Extract the recipe, put linux-7.2.3.tar.xz and the Arch patch beside the PKGBUILD, and run `makepkg`. Arch builds
    in a clean chroot with its toolchain of the day; the image records rustc 1.98.1.
  - The config is config.x86_64. Its only difference from the image's IKCONFIG is the recorded rustc version.
  - A rebuild signs the modules with a new key. The kernel does not enforce signatures, so they load.
- **glibc and GCC:** the same way, from their recipes. The recipes name the commits above.
- **GRUB:** the same way, with gnulib at the revision above. GRUB's bootstrap checks it out.
- **template/init against a modified glibc** (LGPL-2.1 section 6):
  `gcc -static -O2 -o init isolation/m2/dominit.c`, in a checkout of commit 0181bce3, with that glibc's libc.a on the
  link path.

## Enclave's own code in the release
template/init, template/front, runtime.json and release.json are built from this repository at commit
0181bce3aac5fa03dfaf2928d834ecd04d2a4a73 (INVENTORY.md gives the commands). The repository LICENSE covers them.
