#!/usr/bin/env python3
"""sources-table.py -- the file table of SOURCES.md, generated from the fetched directory itself (SHA256SUMS and the
files' sizes), so a document never states a hash or a size by hand.

    sources-table.py <sources dir>      prints the Markdown table (every file SHA256SUMS lists, in its order)
"""
import os, sys

WHAT = {
    "linux-7.2.3.tar.xz": "kernel.org release 7.2.3 (the sha256 Arch's PKGBUILD pins)",
    "linux-7.2.3.tar.sign": "its kernel.org signature (over the uncompressed tar)",
    "linux-v7.2.3-arch1.patch.zst": "Arch's patch v7.2.3-arch1 (73 lines: Makefile, kernel/fork.c)",
    "linux-v7.2.3-arch1.patch.zst.sig": "its signature",
    "arch-packaging-linux-7.2.3.arch1-2.tar.xz": "the recipe: PKGBUILD and **config.x86_64** (the config the image's IKCONFIG matches) at tag 7.2.3.arch1-2 (fae9fc0d)",
    "rust-src-1.98.1.tar.xz": "Rust 1.98.1's library source (static.rust-lang.org; tag 1.98.1 = 48a229ce): the kernel's CONFIG_RUST builds core from it",
    "glibc-16be1518495f.tar.xz": "glibc at commit 16be1518495f1fa05481b0182c4e4c24927c62df (release/2.44, the PKGBUILD's `_commit`)",
    "arch-packaging-glibc-2.44+r24+g16be1518495f-1.tar.xz": "the recipe at tag 2.44+r24+g16be1518495f-1 (7a444d10)",
    "gcc-d564253eb6c8.tar.xz": "GCC at commit d564253eb6c859e266d3cae18e82fb4db9a88316 (libgcc, libgcc_s, crt objects)",
    "arch-packaging-gcc-16.2.1+r23+gd564253eb6c8-1.tar.xz": "the recipe and its two patches at tag 16.2.1+r23+gd564253eb6c8-1 (13b07516)",
    "musl-1.2.6.tar.gz": "musl 1.2.6 (musl.libc.org), no patches: template/init's libc from image commit aa6c985c on",
    "musl-1.2.6.tar.gz.asc": "its signature, by musl's release key 836489290BB6B70F99FFDA0556BCDB593020450F",
    "grub-2.14.tar.xz": "GRUB tag grub-2.14 (d38d6a1a9b79427848976f53d474392cd29c2a71)",
    "gnulib-9f48fb99.tar.xz": "gnulib 9f48fb992a3d7e96610c4ce8be969cff2d61a01b: grub-2.14's bootstrap.conf GNULIB_REVISION, which its bootstrap checks out",
    "unifont-17.0.03.bdf.gz": "the font source Arch's GRUB build has (b2sum b824e469... as the PKGBUILD pins); GRUB generates widthspec.h from it, compiled into the normal module",
    "unifont-17.0.03.bdf.gz.sig": "its signature",
    "arch-grub-2.14-1-reverts.patch": "the two commits Arch's prepare() reverts (1a5417f3, ac042f3f), as their result on grub-2.14: a history-less tree cannot replay `git revert`",
    "arch-packaging-grub-2-2.14-1.tar.xz": "the recipe and its three patches at tag 2-2.14-1 (984cb119)",
    "edk2-2970e569-AmdSev-Grub-grub.sh": "the GRUB image's build script (edk2 OvmfPkg/AmdSev/Grub at the firmware's commit; runs grub-mkimage)",
    "edk2-2970e569-AmdSev-Grub-grub.cfg": "the grub.cfg in the image's memdisk",
    "edk2-2970e569-AmdSev-Grub-Grub.inf": "how the image goes into the firmware volume",
    "edk2-amdsev-grub-modules.patch": "the module-list change the firmware was built with",
    "firmware-build.env": "the firmware's recorded build-time inputs: the memdisk's volume ID and time (TZ=UTC0), and the edk2 path length",
    "go1.27.0.src.tar.gz": "Go 1.27.0 (BSD-3-Clause; the standard library in template/front)",
    "arch-packaging-go-2-1.27.0-1.tar.xz": "its recipe at tag 2-1.27.0-1 (89d6ba9a)",
    "arch-packaging-wasmtime-48.0.1-1.tar.xz": "wasmtime's recipe at tag 48.0.1-1 (72b41ee7): `cargo build --release --frozen` at tag v48.0.1",
    "rust-1.98.0-COPYRIGHT": "the Rust 1.98.0 standard library's notice (rust-lang/rust 88d9e12a; wasmtime's std)",
    "rust-1.98.0-LICENSE-APACHE": "its Apache-2.0 text",
    "rust-1.98.0-LICENSE-MIT": "its MIT text",
}
d = sys.argv[1]
rows = [l.split() for l in open(os.path.join(d, "SHA256SUMS")) if l.strip()]
missing = [f for _, f in rows if f not in WHAT]
if missing: sys.exit(f"sources-table.py: no description for {missing}")
print("| file | sha256 | bytes | what |\n|---|---|---|---|")
for h, f in rows:
    print(f"| {f} | {h} | {os.path.getsize(os.path.join(d, f))} | {WHAT[f]} |")
