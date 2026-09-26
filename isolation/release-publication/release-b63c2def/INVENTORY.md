# Inventory: domain release b63c2def (release id f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca)

**The hardened release.** It was built at image commit b63c2def6e9b12088c30594b8cb58c7273903a60
(isolation/snp-dominit-yama). That is isolation/front-console-guard 298924ae plus enclave-5d's hardened dominit
(f4a2e77c, 3457b825, b63c2def; enclave-5d's GO):
- the front is not dumpable, and refuses to start if any of its threads is traced;
- init runs the app unprivileged, with NO_NEW_PRIVS and empty capabilities, and holds Yama ptrace_scope at 2, user
  namespaces at 0 and io_uring at 2, failing closed.
It replaces 52156652 (4cdd5169) for the next tree switch, and 52156652 is its rollback.

**Only Enclave's own template/front and template/init changed from 52156652.** `check-third-party.py` against
52156652 lists those two as the only differing files. enclave-bf compared the two releases independently and rebuilt
both files from a clean worktree at b63c2def: front 6c619b9d…, init 52640baf…, byte-identical.

This is a DIFF NOTE against release 0181bce3, as 79c5ecf2's and 52156652's were. The third-party parts of that release's
inventory hold here unchanged, because the bytes are the same, and they are reproduced at the end.

## What is the same as 0181bce3
`check-third-party.py` first verifies both releases against their ids, then compares every file, and prints SAME:
- **firmware.fd 142589cc…:** rebuilt from pinned source, byte-identical;
- **kernel 1a3a02d5…, and the five modules;**
- **template/rt/:** wasmtime b77aecdb…, libc.so.6, libm.so.6, ld-linux-x86-64.so.2, libgcc_s.so.1 and runtime.json.

The cmdline and the measure parameters are identical too. The check does not cover third-party code linked into
Enclave's own files; that is below.

## Enclave's own files, and what is linked into them

| file | sha256 | built by |
|---|---|---|
| template/init | 52640baffd3442e25ce05b3a8555b9462d959cb7d5769e802667ce075ed7df6c | `/usr/bin/gcc -specs <musl prefix>/lib/musl-gcc.specs -static -O2 -o init isolation/m2/dominit.c`, gcc 16.2.1, musl 1.2.6 built by isolation/m2/build-musl.sh |
| template/front | 6c619b9dcae0423bded451a11f37f6959f331aede0dc3bfd27e79d76960ef547 | `GOFLAGS= CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' ./front` (the PRODUCTION front: no releaselab tag), go1.27.0 (Arch go 2:1.27.0-1, toolchain default GOEXPERIMENT nodwarf5) |

**template/init: musl, not glibc; NEW bytes (the hardened dominit).** isolation/m2/dominit.c changed from
4cdd5169 to b63c2def. It was built twice by cut-release.sh, against a musl prefix made by b63c2def's build-musl.sh
(libc.a sha256 4f72e098…; the source's sha256 and musl's release signature both checked), and is 52640baf…
(97368 bytes). Rebuilt here once more with `-Wl,-Map` by app-image-template.sh's exact command, it is the same bytes, so
the map describes the released init:
- **The link loads:**
  - musl's Scrt1.o, crti.o and crtn.o, and 142 members of musl's libc.a, counted from the map's "Archive member
    included" section. It now pulls prctl.lo, setgroups.lo and syscall.lo for the privilege drop and the holds;
    capset and capget go through syscall(). enclave-bf's own map of the same link agrees on the kind of members.
  - GCC's crtbeginS.o and crtendS.o (gcc 16.2.1+r23+gd564253eb6c8-1, under the GCC Runtime Library Exception).
  - No member of libgcc.a, libgcc_eh.a or libatomic, which the link searches and takes nothing from.
- **The binary:** no program interpreter, no dynamic section, and no glibc string.
- **So:** no glibc and no LGPL code is statically linked into it. musl's COPYRIGHT is in the notices, and its source in
  the bundle.
- **glibc is still shipped,** as the shared runtime set in template/rt/ that wasmtime is dynamically linked with,
  exactly as in 0181bce3. Its notices and complete corresponding source stay as they were.

**template/front:** 52156652's front (the console guard) plus the hardening from 298924ae
(isolation/m2/front/dumpable.go): it is not dumpable from its first instruction, and it refuses to start if any of its
threads is traced.
- It carries the release client, with no third-party Go modules (`go version -m`: the main module and its in-repository
  replace enclave.host/isolation/contract; no go.sum).
- It embeds four public CA root certificates and Enclave's relay release key, which the notices list with their
  hashes.
- The Go standard library and runtime are BSD-3-Clause.

## Findings
- **Nothing third-party changed from 52156652.** Only Enclave's own front and init changed; init's link now takes more
  members of musl's libc.a, all MIT.
- **No conflict was found between a component's terms and shipping it.** Enclave's LICENSE is unchanged.
- **GPL-3.0 section 6(d):** the directions to the corresponding source must sit NEXT TO the binaries, kept up for as
  long as they are offered, on every channel that offers them (SOURCES.md).

## Appendix: the third-party parts of release 0181bce3's inventory (the same bytes here)

Verbatim from isolation/release-publication/release-0181bce3/INVENTORY.md, without its init and front, which differ
here (above).

### The files (16; `release.json` lists the other 15)

| file | sha256 | what it is | license(s) |
|---|---|---|---|
| firmware.fd | 142589cc4882f29a… | OVMF AmdSevX64 RELEASE: TianoCore EDK II edk2-stable202608, with the OpenSSL 3.5.7 and LZMA SDK 19.00 code it links, and an embedded GNU GRUB 2.14 image | BSD-2-Clause-Patent; Apache-2.0; public domain; GPL-3.0-or-later (GRUB) |
| kernel | 1a3a02d5a982946e… | Linux 7.2.3-arch1-2, Arch Linux's bzImage | GPL-2.0-only WITH Linux-syscall-note |
| template/vsock.ko.zst, vmw_vsock_virtio_transport.ko.zst, vmw_vsock_virtio_transport_common.ko.zst, tsm_report.ko.zst, sev-guest.ko.zst | release.json | modules of that kernel build | GPL-2.0 (modinfo: "GPL v2" / "GPL") |
| template/rt/wasmtime | b77aecdb33fbf026… | Wasmtime 48.0.1, Arch Linux's build: the Rust 1.98.0 standard library, 217 crates.io crates and 38 wasmtime workspace crates, including the C of capstone, zstd 1.5.5 and ittnotify | Apache-2.0 WITH LLVM-exception; the Rust standard library (MIT OR Apache-2.0); per crate (THIRD-PARTY-NOTICES.md) |
| template/rt/libc.so.6, libm.so.6, ld-linux-x86-64.so.2 | release.json | glibc 2.44 | LGPL-2.1-or-later |
| template/rt/libgcc_s.so.1 | e618cb9c90c2eb3a… | GCC 16.2.1 runtime | GPL-3.0-or-later WITH GCC-exception-3.1 |
| template/rt/runtime.json | 8044b26a6ef691e3… | the runtime identity (`isolation/contract/runtime-identity.sh` over wasmtime) | Enclave LICENSE |
| release.json | (its sha256 is the release id) | the manifest (`isolation/m4/release-manifest.py`) | Enclave LICENSE |

The empty directories template/dev, proc, sys, tmp and template/rt are mount points and hold nothing.


### How each was established

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
first rebuild's differing cookie in StatusCodeHandlerPei's AutoGen.h is read by nothing. A rebuild without
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

### Terms that bear on shipping these bytes (specific findings; no general licensing question is raised here)
- **Copyleft components shipped as binaries:** the kernel and modules (GPL-2.0), glibc (LGPL-2.1+), libgcc_s
  (GPL-3.0+ with the runtime exception) and the GRUB image (GPL-3.0+).
  - The corresponding source of each is in SOURCES.md: exact tarballs or commits, Arch's recipes, the kernel config,
    patches, and the scripts that built these bytes.
  - That source is to be distributed ALONGSIDE the binaries, from the same place, as one bundle (SOURCES.md). Where
    both are hosted is the publisher's decision, and is not made here.
  - dominit.c is also inside the release tarball.
- **GRUB (GPL-3.0+)** is a separate program aggregated in the firmware volume. The Installation Information clause
  (GPL-3.0 section 6) concerns User Products; a modified firmware still runs. No conflict found. GPL-3.0 section 6(d)
  asks for clear directions NEXT TO the binaries saying where the source is, maintained for as long as the binaries
  are offered, on every channel that offers them (SOURCES.md).
- **Modules signed with Arch's per-build key:** the key is not part of the corresponding source, and GPL-2.0 does not
  require it. The kernel does not enforce module signatures. No conflict found.
- **The Rust standard library** linked into wasmtime is MIT OR Apache-2.0; its texts are in the notices. No conflict
  found.
- **Dual-licensed crates:** ittapi and ittapi-sys ("GPL-2.0-only OR BSD-3-Clause") are used under BSD-3-Clause.
  zstd-sys's bundled zstd ("BSD-3-Clause OR GPL-2.0") is used under BSD-3-Clause.
- **Crates without a license file:** six crates.io crates ship none, and each gets the text of its declared license
  (THIRD-PARTY-NOTICES.md says which copy). No crate is under a copyleft-only license.
