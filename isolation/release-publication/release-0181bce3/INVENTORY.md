# Inventory: domain release 0181bce3 (release id 5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2)

The release is every input of a per-app guest's launch measurement except the app. It was built on 2026-09-24 by
`isolation/m4/domain-release.sh` at commit 0181bce3aac5fa03dfaf2928d834ecd04d2a4a73, and it is the release deployed
today, and the production release's rollback.

Each row says what the file is, and how that was established from the BYTES and the build scripts, not from memory.
The packages named are the build host's installed Arch Linux packages. The toolchain is unchanged since the release was
built: pacman.log shows no upgrade of any of them after 2026-09-04.

## The files (16; `release.json` lists the other 15)

| file | sha256 | what it is | license(s) |
|---|---|---|---|
| firmware.fd | 142589cc4882f29a… | OVMF AmdSevX64 RELEASE: TianoCore EDK II edk2-stable202608, with the OpenSSL 3.5.7 and LZMA SDK 19.00 code it links, and an embedded GNU GRUB 2.14 image | BSD-2-Clause-Patent; Apache-2.0; public domain; GPL-3.0-or-later (GRUB) |
| kernel | 1a3a02d5a982946e… | Linux 7.2.3-arch1-2, Arch Linux's bzImage | GPL-2.0-only WITH Linux-syscall-note |
| template/vsock.ko.zst, vmw_vsock_virtio_transport.ko.zst, vmw_vsock_virtio_transport_common.ko.zst, tsm_report.ko.zst, sev-guest.ko.zst | release.json | modules of that kernel build | GPL-2.0 (modinfo: "GPL v2" / "GPL") |
| template/init | 30b660c4bb8d3cbf… | Enclave's `isolation/m2/dominit.c`, compiled `gcc -static -O2`: static glibc and GCC runtime | Enclave LICENSE; LGPL-2.1-or-later (glibc); GPL-3.0-or-later WITH GCC-exception-3.1 |
| template/front | 282cb360aa98865a… | Enclave's `isolation/m2/front` (Go), with the Go standard library and runtime | Enclave LICENSE; BSD-3-Clause (Go) |
| template/rt/wasmtime | b77aecdb33fbf026… | Wasmtime 48.0.1, Arch Linux's build: the Rust 1.98.0 standard library, 217 crates.io crates and 38 wasmtime workspace crates, including the C of capstone, zstd 1.5.5 and ittnotify | Apache-2.0 WITH LLVM-exception; the Rust standard library (MIT OR Apache-2.0); per crate (THIRD-PARTY-NOTICES.md) |
| template/rt/libc.so.6, libm.so.6, ld-linux-x86-64.so.2 | release.json | glibc 2.44 | LGPL-2.1-or-later |
| template/rt/libgcc_s.so.1 | e618cb9c90c2eb3a… | GCC 16.2.1 runtime | GPL-3.0-or-later WITH GCC-exception-3.1 |
| template/rt/runtime.json | 8044b26a6ef691e3… | the runtime identity (`isolation/contract/runtime-identity.sh` over wasmtime) | Enclave LICENSE |
| release.json | (its sha256 is the release id) | the manifest (`isolation/m4/release-manifest.py`) | Enclave LICENSE |

The empty directories template/dev, proc, sys, tmp and template/rt are mount points and hold nothing.

## How each was established

**firmware.fd: rebuilt from pinned source, byte-identical.** `rebuild-firmware.sh` produces sha256 142589cc… from:
- edk2 commit 2970e569 (tag edk2-stable202608), with every submodule at the commit the tree records
  (`edk2-submodules.txt`);
- one patch (`patches/edk2-amdsev-grub-modules.patch`);
- nasm cd37b81b, acpica (iasl 20260408) 98bbab7d, and mtools 4.0.43 (sha256-pinned);
- the host toolchain: gcc 16.2.1, binutils 2.47, python 3.14.7 and make 4.4.1;
- the host's GRUB 2:2.14-1 and dosfstools 4.2-5;
- two BUILD-TIME inputs, recorded in `firmware-inputs/build.env`:
  - the GRUB memdisk's FAT volume ID and time;
  - the length of the edk2 tree's path.

A first rebuild without them differed in exactly those places, and in nothing else:
- 10 bytes of the memdisk (its volume ID and grub.cfg's timestamps);
- one module, StatusCodeHandlerPei: 64 bytes of zeroed CodeView padding, and the header fields that record its size.

EDK2 also draws StackCookieValues at random for each build. They are not an input: AmdSevX64 links StackCheckLibNull
into all 92 modules, so no cookie value is read, and none of the 200 occurs in any module or in the firmware. The
first rebuild's differing cookie in StatusCodeHandlerPei's AutoGen.h is read by nothing (enclave-e3). A rebuild without
the original cookie files matches. (This firmware therefore has no working stack protector: upstream OVMF's
default.)

The build report (`-Y LIBRARY`, 94 modules) is what names the third-party code that is linked:
- OpenSSL's libcrypto (edk2 submodule 8cf17aae, VERSION.dat 3.5.7), only through BaseCryptLib into
  QemuKernelLoaderFsDxe;
- the LZMA SDK decompressor (LzmaCustomDecompressLib), linked as a NULL library.

Everything else is EDK2's own code. The Grub FFS file is `OvmfPkg/AmdSev/Grub/grub.efi`:
- grub.sh builds it with the host's `grub-mkimage` (GRUB 2:2.14-1) from the patch's module list, with a FAT memdisk
  holding edk2's grub.cfg;
- the rebuilt grub.efi is byte-identical to the one in the original build tree.

**kernel and modules: Arch's binaries, copied.**
- **The kernel:** `/boot/vmlinuz-linux` equals `/usr/lib/modules/7.2.3-arch1-2/vmlinuz`, which package linux
  7.2.3.arch1-2 owns.
  - The setup header's version string reads "7.2.3-arch1-2 (linux@archlinux) #1 SMP PREEMPT_DYNAMIC Thu, 03 Sep 2026
    17:55:06 +0000".
  - The image embeds its config (IKCONFIG). That config equals the packaging repository's config.x86_64 at tag
    7.2.3.arch1-2, except the two lines that record the rustc Arch built with: 1.98.1, where the file says 1.98.0.
- **The modules:** they come from the same package's module tree (domain-release.sh's `m1/domain.env` takes the
  guest's kernel release from the image). modinfo gives:
  - vermagic "7.2.3-arch1-2 SMP preempt mod_unload";
  - license "GPL v2" (the three vsock modules) or "GPL" (tsm_report, sev-guest);
  - signer "Build time autogenerated kernel key", which is Arch's ephemeral per-build key.
- **Rebuilding:** `CONFIG_MODULE_SIG_FORCE` is not set, so a rebuilt kernel and modules run. They are not
  bit-identical to Arch's, because the signing key is not in any source.

**template/init: rebuilt, byte-identical.**
- The command is `gcc -static -O2 -o init isolation/m2/dominit.c` (app-image-template.sh), with gcc 16.2.1
  (.comment "GCC: (GNU) 16.2.1 20260810").
- A `-Wl,-Map` link of the same command names every archive member it pulled in:
  - libc.a, crt1.o, crti.o and crtn.o, from glibc 2.44+r24+g16be1518495f-1;
  - libgcc.a, libgcc_eh.a, crtbeginT.o and crtend.o, from gcc 16.2.1+r23+gd564253eb6c8-1;
  - nothing from libatomic.

**template/front: rebuilt with an empty GOCACHE, byte-identical.**
- The command is `CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' ./front`, in
  isolation/m2.
- `go version -m` gives:
  - go1.27.0 with GOEXPERIMENT nodwarf5 (the Arch go 2:1.27.0-1 toolchain's own default: no environment or GOENV file
    sets it);
  - module enclave.host/isolation/m2;
  - the one dependency enclave.host/isolation/contract, a replace to ../contract in this repository.
- There are no third-party Go modules.

**template/rt/wasmtime: Arch's binary, copied.**
- It equals /usr/bin/wasmtime, which package wasmtime 48.0.1-1 owns. Its .comment says "rustc version 1.98.0 … (Arch
  Linux rust 1:1.98.0-1)" and "Linker: LLD 22.1.8".
- Arch builds it from tag v48.0.1 (commit 7bac2c27) with `cargo build --release --frozen`, which means default
  features.
- The crate set is `cargo tree --locked -p wasmtime-cli -e normal --target x86_64-unknown-linux-gnu` on that tag
  (`wasmtime-crates.tsv`). It lists 272 crates:
  - 217 from crates.io, compiled in;
  - 38 wasmtime workspace crates;
  - 17 proc-macros, which run at build time and are not in the binary.
- **The Rust standard library** (core, alloc, std) of rustc 1.98.0 is linked in as well. cargo tree does not list it;
  its texts (COPYRIGHT, LICENSE-APACHE, LICENSE-MIT at rust-lang/rust 88d9e12a) are in the notices.
- **Cross-check against the bytes:** the binary names 105 crates.io crates in its panic paths
  (`wasmtime-crates-in-binary.txt`), and every one is in that set.
- **C compiled in by -sys crates:**
  - capstone: the binary carries capstone/MCInst.c's assertion path and capstone's error strings;
  - zstd 1.5.5 (zstd-sys): 303 ZSTD_ strings;
  - ittnotify (ittapi-sys).
- **Not in it:** OpenVINO itself. The openvino crates are bindings that load a system libopenvino at run time, and the
  release carries none.
- **Its libraries:** `readelf -d` NEEDs only libgcc_s.so.1, libm.so.6 and libc.so.6, and runtime-set.sh copies exactly
  those, plus the ELF interpreter.

**template/rt libraries: Arch's binaries, copied.**
- libc.so.6, libm.so.6 and ld-linux-x86-64.so.2 equal the installed files that glibc 2.44+r24+g16be1518495f-1 owns;
  libc.so.6 prints "GNU C Library (GNU libc) stable release version 2.44."
- libgcc_s.so.1 equals the installed file that libgcc 16.2.1+r23+gd564253eb6c8-1 owns.

## Terms that bear on shipping these bytes (specific findings; no general licensing question is raised here)
- **Copyleft components shipped as binaries:** the kernel and modules (GPL-2.0), glibc (LGPL-2.1+), libgcc_s
  (GPL-3.0+ with the runtime exception) and the GRUB image (GPL-3.0+).
  - The corresponding source of each is in SOURCES.md: exact tarballs or commits, Arch's recipes, the kernel config,
    patches, and the scripts that built these bytes.
  - That source is to be distributed ALONGSIDE the binaries, from the same place, as one bundle (SOURCES.md). Where
    both are hosted is the publisher's decision, and is not made here.
  - dominit.c is also inside the release tarball.
- **template/init is linked statically with glibc (LGPL-2.1 section 6). A SPECIFIC FINDING, open (enclave-e3).**
  - What is provided for relinking:
    - init's source (dominit.c, inside the tarball);
    - the exact link command (above);
    - glibc's source.
  - Section 6 also requires that the terms for the combined work "permit modification of the work for the customer's
    own use and reverse engineering for debugging such modifications".
  - The repository LICENSE, section 3, lifts section 2's restrictions for modifying the LGPL component and for that
    reverse engineering. It does not lift section 2(a) for USING the modified combined work. Section 1(b) permits
    non-production local runs only.
  - So the LICENSE's text may not grant everything section 6 asks for this binary. Resolving it is a decision for
    Steven, and nothing here changes the LICENSE. Options, none of them taken:
    - a LICENSE addition;
    - building init against a libc under non-copyleft terms, so that no LGPL code is statically linked into it. That
      changes init, and so the measurement.
  - Everything else in this release is shipped under its own license, unaffected by this point.
- **GRUB (GPL-3.0+)** is a separate program aggregated in the firmware volume. The Installation Information clause
  (GPL-3.0 section 6) concerns User Products; a modified firmware still runs. No conflict found.
- **Modules signed with Arch's per-build key:** the key is not part of the corresponding source, and GPL-2.0 does not
  require it. The kernel does not enforce module signatures. No conflict found.
- **The Rust standard library** linked into wasmtime is MIT OR Apache-2.0; its texts are in the notices. No conflict
  found.
- **Dual-licensed crates:** ittapi and ittapi-sys ("GPL-2.0-only OR BSD-3-Clause") are used under BSD-3-Clause.
  zstd-sys's bundled zstd ("BSD-3-Clause OR GPL-2.0") is used under BSD-3-Clause.
- **Crates without a license file:** six crates.io crates ship none, and each gets the text of its declared license
  (THIRD-PARTY-NOTICES.md says which copy). No crate is under a copyleft-only license.
