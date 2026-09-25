# Third-party notices: domain release 0181bce3 (release id 5c3561f9...)

Every component below is part of the release's bytes (INVENTORY.md says where, and how that was established). Each remains under its own license. The texts are copied from each component's own source into licenses/, byte for byte; their sha256 are listed at the end. The corresponding source of the copyleft components is listed in SOURCES.md. Enclave's own code in the release (template/init from isolation/m2/dominit.c, template/front, the release manifest) is under the repository's LICENSE.

## Linux kernel (Arch Linux build)

- **In the release:** kernel; template/vsock.ko.zst, vmw_vsock_virtio_transport{,_common}.ko.zst, tsm_report.ko.zst, sev-guest.ko.zst
- **Version:** linux 7.2.3.arch1-2 (7.2.3 + Arch patch v7.2.3-arch1)
- **License:** GPL-2.0-only WITH Linux-syscall-note (COPYING; individual files carry compatible SPDX identifiers listed in LICENSES/)
- **Source:** linux-7.2.3.tar.xz + linux-v7.2.3-arch1.patch.zst + config.x86_64 (SOURCES.md)
- **Texts:** [licenses/linux/COPYING](licenses/linux/COPYING), [licenses/linux/LICENSES/preferred/GPL-2.0](licenses/linux/LICENSES/preferred/GPL-2.0), [licenses/linux/LICENSES/exceptions/Linux-syscall-note](licenses/linux/LICENSES/exceptions/Linux-syscall-note)

The kernel image and the five modules are Arch Linux's binaries, copied unmodified. The modules carry Arch's build-time signatures; the key is Arch's ephemeral per-build key, which no source contains. The kernel does not enforce module signatures (CONFIG_MODULE_SIG_FORCE is not set), so a kernel and modules rebuilt from this source run.

## GNU C Library (glibc)

- **In the release:** template/rt/libc.so.6, libm.so.6, ld-linux-x86-64.so.2 (shared); template/init (static: libc.a and crt1.o/crti.o/crtn.o linked in)
- **Version:** glibc 2.44+r24+g16be1518495f-1 (Arch; commit 16be1518495f)
- **License:** LGPL-2.1-or-later, with the notices in LICENSES
- **Source:** glibc-16be1518495f.tar.xz + Arch's PKGBUILD (SOURCES.md)
- **Texts:** [licenses/glibc/COPYING.LIB](licenses/glibc/COPYING.LIB), [licenses/glibc/COPYINGv2](licenses/glibc/COPYINGv2), [licenses/glibc/LICENSES](licenses/glibc/LICENSES)

template/init is linked STATICALLY with glibc, so LGPL-2.1 section 6 applies to it. For relinking it with a modified glibc, these are provided: its own source (source/isolation/m2/dominit.c in this tarball), the exact link command (INVENTORY.md) and glibc's source. Whether the repository LICENSE's terms grant everything section 6 asks of the combined work is an open finding, recorded in INVENTORY.md.

## GCC runtime libraries (libgcc_s, libgcc, libgcc_eh, crtbeginT.o, crtend.o)

- **In the release:** template/rt/libgcc_s.so.1 (shared); template/init (static)
- **Version:** gcc 16.2.1+r23+gd564253eb6c8-1 / libgcc (Arch; commit d564253eb6c8)
- **License:** GPL-3.0-or-later WITH GCC-exception-3.1
- **Source:** gcc-d564253eb6c8.tar.xz + Arch's PKGBUILD and patches (SOURCES.md)
- **Texts:** [licenses/gcc/COPYING3](licenses/gcc/COPYING3), [licenses/gcc/COPYING.RUNTIME](licenses/gcc/COPYING.RUNTIME)

The GCC Runtime Library Exception covers the libgcc code compiled into template/init and wasmtime. libgcc_s.so.1 is also shipped as a file of its own, so its complete corresponding source is provided.

## GNU GRUB (the AmdSev GRUB image inside the firmware volume)

- **In the release:** firmware.fd (the Grub FFS file, grub.efi)
- **Version:** grub 2:2.14-1 (Arch; tag grub-2.14, gnulib 9f48fb99)
- **License:** GPL-3.0-or-later
- **Source:** grub-2.14.tar.xz + gnulib-9f48fb99.tar.xz + Arch's PKGBUILD and patches; the image recipe is edk2's OvmfPkg/AmdSev/Grub/grub.sh with patches/edk2-amdsev-grub-modules.patch (SOURCES.md)
- **Texts:** [licenses/grub/COPYING](licenses/grub/COPYING)

grub.efi is made by grub-mkimage from the build host's installed GRUB modules (part_msdos part_gpt cryptodisk luks gcry_rijndael gcry_sha256 ext2 btrfs xfs fat configfile memdisk sleep normal echo test regexp linux reboot and their dependencies) with a memdisk holding edk2's grub.cfg. It is a separate program aggregated in the firmware volume. On the project's -kernel boot path the firmware loads the served kernel itself; the boot manager reaches GRUB only when no kernel is served (isolation/m1/domain.env). GPL-3.0 section 6's Installation Information clause concerns User Products; this firmware is a cloud guest's, and a modified firmware runs (it is measured differently, which is what a measurement is for).

## TianoCore EDK II (OVMF AmdSevX64)

- **In the release:** firmware.fd
- **Version:** edk2-stable202608 (2970e569), AmdSevX64 RELEASE
- **License:** BSD-2-Clause-Patent
- **Source:** the edk2 commit and submodule pins (edk2-submodules.txt), the patch, and rebuild-firmware.sh
- **Texts:** [licenses/edk2/License.txt](licenses/edk2/License.txt)

## OpenSSL (edk2 CryptoPkg OpensslLib, linked into QemuKernelLoaderFsDxe)

- **In the release:** firmware.fd
- **Version:** OpenSSL 3.5.7 (edk2 submodule 8cf17aae)
- **License:** Apache-2.0
- **Source:** edk2 submodule CryptoPkg/Library/OpensslLib/openssl at 8cf17aaeb4599f8af87fefd810b5b5fee90fe69e
- **Texts:** [licenses/openssl/LICENSE.txt](licenses/openssl/LICENSE.txt)

## LZMA SDK (edk2 LzmaCustomDecompressLib)

- **In the release:** firmware.fd
- **Version:** LZMA SDK 19.00 (in edk2)
- **License:** public domain
- **Source:** edk2 MdeModulePkg/Library/LzmaCustomDecompressLib/Sdk
- **Texts:** [licenses/lzma-sdk/LZMA-SDK-README.txt](licenses/lzma-sdk/LZMA-SDK-README.txt)

## Go standard library and runtime (compiled into template/front)

- **In the release:** template/front
- **Version:** go 2:1.27.0-1 (Arch; go1.27.0)
- **License:** BSD-3-Clause
- **Source:** go1.27.0.src.tar.gz (sha256 in Arch's PKGBUILD, SOURCES.md)
- **Texts:** [licenses/go/LICENSE](licenses/go/LICENSE), [licenses/go/PATENTS](licenses/go/PATENTS)

## Rust standard library (core, alloc, std, and the runtime pieces rustc links)

- **In the release:** template/rt/wasmtime
- **Version:** rustc 1.98.0 (88d9e12a; Arch rust 1:1.98.0-1, as wasmtime's .comment records)
- **License:** MIT OR Apache-2.0 (COPYRIGHT lists the parts under other terms)
- **Source:** rust-lang/rust at 88d9e12ae178fab0fb5cc050a94da85685d449ea
- **Texts:** [licenses/rust/COPYRIGHT](licenses/rust/COPYRIGHT), [licenses/rust/LICENSE-APACHE](licenses/rust/LICENSE-APACHE), [licenses/rust/LICENSE-MIT](licenses/rust/LICENSE-MIT)

cargo tree lists crates, not the standard library a Rust binary is linked with; these are its texts (enclave-e3).

## Wasmtime (template/rt/wasmtime)

- **In the release:** template/rt/wasmtime
- **Version:** wasmtime 48.0.1-1 (Arch; tag v48.0.1)
- **License:** Apache-2.0 WITH LLVM-exception (the wasmtime workspace crates); its crates below
- **Source:** the tag v48.0.1 and its Cargo.lock
- **Texts:** [licenses/wasmtime/LICENSE](licenses/wasmtime/LICENSE)

## Rust crates compiled into wasmtime (217)

- **In the release:** template/rt/wasmtime
- **Version:** Cargo.lock of wasmtime v48.0.1, default features
- **License:** per crate, below
- **Source:** crates.io, at the versions below

## The crates, one per row

| crate | version | license (declared) | texts |
|---|---|---|---|
| addr2line | 0.26.0 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [e99d88d232bf57d7-LICENSE-MIT](licenses/crates/e99d88d232bf57d7-LICENSE-MIT) |
| aho-corasick | 1.0.2 | Unlicense OR MIT | [01c266bced4a434d-COPYING](licenses/crates/01c266bced4a434d-COPYING), [0f96a83840e146e4-LICENSE-MIT](licenses/crates/0f96a83840e146e4-LICENSE-MIT), [7e12e5df4bae12cb-UNLICENSE](licenses/crates/7e12e5df4bae12cb-UNLICENSE) |
| allocator-api2 | 0.2.20 | MIT OR Apache-2.0 | [20fe7b00e904ed69-LICENSE-APACHE](licenses/crates/20fe7b00e904ed69-LICENSE-APACHE), [36516aefdc84c5d5-LICENSE-MIT](licenses/crates/36516aefdc84c5d5-LICENSE-MIT) |
| ambient-authority | 0.0.2 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [d00d6d48df2db6f9-COPYRIGHT](licenses/crates/d00d6d48df2db6f9-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| anstream | 0.6.21 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| anstyle | 1.0.13 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| anstyle-parse | 0.2.7 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| anyhow | 1.0.103 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [15656cc11a8331f2-LICENSE-MIT](licenses/crates/15656cc11a8331f2-LICENSE-MIT) |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT), [6226d0632e2e1a80-LICENSE-THIRD-PARTY](licenses/crates/6226d0632e2e1a80-LICENSE-THIRD-PARTY) |
| base64 | 0.22.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [0dd882e53de11566-LICENSE-MIT](licenses/crates/0dd882e53de11566-LICENSE-MIT) |
| beef | 0.5.2 | MIT OR Apache-2.0 | [fe99bc314b267213-LICENSE-APACHE](licenses/crates/fe99bc314b267213-LICENSE-APACHE), [809a5649163758f9-LICENSE-MIT](licenses/crates/809a5649163758f9-LICENSE-MIT) |
| bitflags | 2.11.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| block-buffer | 0.10.2 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [d5c22aa3118d240e-LICENSE-MIT](licenses/crates/d5c22aa3118d240e-LICENSE-MIT) |
| bumpalo | 3.20.2 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [65f94e99ddaf4f5d-LICENSE-MIT](licenses/crates/65f94e99ddaf4f5d-LICENSE-MIT) |
| bytes | 1.11.1 | MIT | [45f522cacecb1023-LICENSE](licenses/crates/45f522cacecb1023-LICENSE) |
| cap-fs-ext | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [5b3d8a674979e158-COPYRIGHT](licenses/crates/5b3d8a674979e158-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| cap-primitives | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a8799c2a07dabcb8-COPYRIGHT](licenses/crates/a8799c2a07dabcb8-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| cap-std | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [6b1691fdee3b03c3-COPYRIGHT](licenses/crates/6b1691fdee3b03c3-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| capstone | 0.14.0 | MIT | [357ada6815fdfec8-LICENSE](licenses/crates/357ada6815fdfec8-LICENSE) |
| capstone-sys | 0.18.0 | MIT | [a446f219aabe3667-LICENSE](licenses/crates/a446f219aabe3667-LICENSE), [65e9ed46a59976ed-LICENSE.TXT](licenses/crates/65e9ed46a59976ed-LICENSE.TXT), [dfdca2d7fdbabfd9-LICENSE_LLVM.TXT](licenses/crates/dfdca2d7fdbabfd9-LICENSE_LLVM.TXT) |
| cfg-if | 1.0.0 | MIT/Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [378f5840b258e277-LICENSE-MIT](licenses/crates/378f5840b258e277-LICENSE-MIT) |
| chacha20 | 0.10.0 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [b8c6939380a400f5-LICENSE-MIT](licenses/crates/b8c6939380a400f5-LICENSE-MIT) |
| clap | 4.5.48 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| clap_builder | 4.5.48 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| clap_complete | 4.5.58 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| clap_lex | 0.7.5 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| cobs | 0.3.0 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [e0cfa1006a645206-LICENSE-MIT](licenses/crates/e0cfa1006a645206-LICENSE-MIT) |
| colorchoice | 1.0.4 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| cpp_demangle | 0.5.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7b63ecd5f1902af1-LICENSE-MIT](licenses/crates/7b63ecd5f1902af1-LICENSE-MIT) |
| cpufeatures | 0.2.7 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [904801faf3f18503-LICENSE-MIT](licenses/crates/904801faf3f18503-LICENSE-MIT) |
| cpufeatures | 0.3.0 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [ae9baa7beea91027-LICENSE-MIT](licenses/crates/ae9baa7beea91027-LICENSE-MIT) |
| crc32fast | 1.3.2 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [61d383b05b87d78f-LICENSE-MIT](licenses/crates/61d383b05b87d78f-LICENSE-MIT) |
| crossbeam-deque | 0.8.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [5734ed989dfca1f6-LICENSE-MIT](licenses/crates/5734ed989dfca1f6-LICENSE-MIT) |
| crossbeam-epoch | 0.9.20 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [5734ed989dfca1f6-LICENSE-MIT](licenses/crates/5734ed989dfca1f6-LICENSE-MIT) |
| crossbeam-utils | 0.8.20 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [5734ed989dfca1f6-LICENSE-MIT](licenses/crates/5734ed989dfca1f6-LICENSE-MIT) |
| crypto-common | 0.1.6 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [3521672491a34794-LICENSE-MIT](licenses/crates/3521672491a34794-LICENSE-MIT) |
| debugid | 0.8.0 | Apache-2.0 | [a60eea8175145316-LICENSE](licenses/crates/a60eea8175145316-LICENSE) |
| digest | 0.10.7 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [9e0dfd2dd4173a53-LICENSE-MIT](licenses/crates/9e0dfd2dd4173a53-LICENSE-MIT) |
| directories-next | 2.0.0 | MIT OR Apache-2.0 | [d3174ad63e721d4c-LICENSE-APACHE](licenses/crates/d3174ad63e721d4c-LICENSE-APACHE), [11955c617c19899b-LICENSE-MIT](licenses/crates/11955c617c19899b-LICENSE-MIT) |
| dirs-sys-next | 0.1.2 | MIT OR Apache-2.0 | [d3174ad63e721d4c-LICENSE-APACHE](licenses/crates/d3174ad63e721d4c-LICENSE-APACHE), [6a2e0ade09a7d5f8-LICENSE-MIT](licenses/crates/6a2e0ade09a7d5f8-LICENSE-MIT) |
| either | 1.13.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7576269ea71f767b-LICENSE-MIT](licenses/crates/7576269ea71f767b-LICENSE-MIT) |
| encoding_rs | 0.8.31 | (Apache-2.0 OR MIT) AND BSD-3-Clause | [11789f45bb180841-COPYRIGHT](licenses/crates/11789f45bb180841-COPYRIGHT), [cfc7749b96f63bd3-LICENSE-APACHE](licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE), [3fa4ca83dcc92378-LICENSE-MIT](licenses/crates/3fa4ca83dcc92378-LICENSE-MIT), [838118388fe5c2e7-LICENSE-WHATWG](licenses/crates/838118388fe5c2e7-LICENSE-WHATWG) |
| env_logger | 0.10.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| equivalent | 1.0.1 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7365cc8878a1d7ce-LICENSE-MIT](licenses/crates/7365cc8878a1d7ce-LICENSE-MIT) |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [0816e154b159ba25-LICENSE-MIT](licenses/crates/0816e154b159ba25-LICENSE-MIT) |
| fastrand | 2.3.0 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| file-per-thread-logger | 0.2.0 | Apache-2.0 WITH LLVM-exception | [a6c48161a09acc75-LICENSE](licenses/crates/a6c48161a09acc75-LICENSE) |
| fnv | 1.0.7 | Apache-2.0 / MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [65fdb6c76cd61612-LICENSE-MIT](licenses/crates/65fdb6c76cd61612-LICENSE-MIT) |
| foldhash | 0.2.0 | Zlib | [b1181a40b2a7b25c-LICENSE](licenses/crates/b1181a40b2a7b25c-LICENSE) |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [20c7855c364d57ea-LICENSE-MIT](licenses/crates/20c7855c364d57ea-LICENSE-MIT) |
| fs-set-times | 0.20.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [e196ffeb5ab101e9-COPYRIGHT](licenses/crates/e196ffeb5ab101e9-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| futures | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| futures-channel | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| futures-core | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| futures-io | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| futures-sink | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| futures-task | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| futures-util | 0.3.31 | MIT OR Apache-2.0 | [275c491d6d116055-LICENSE-APACHE](licenses/crates/275c491d6d116055-LICENSE-APACHE), [6652c868f35dfe5e-LICENSE-MIT](licenses/crates/6652c868f35dfe5e-LICENSE-MIT) |
| fxprof-processed-profile | 0.8.1 | MIT OR Apache-2.0 | [074e6e32c86a4c0e-SPDX-Apache-2.0.txt](licenses/crates/074e6e32c86a4c0e-SPDX-Apache-2.0.txt) (no license file in the crate: the SPDX text of its declared license) |
| generic-array | 0.14.5 | MIT | [c09aae9d3c77b531-LICENSE](licenses/crates/c09aae9d3c77b531-LICENSE) |
| getrandom | 0.2.15 | MIT OR Apache-2.0 | [aaff376532ea30a0-LICENSE-APACHE](licenses/crates/aaff376532ea30a0-LICENSE-APACHE), [42fa16951ce7f24b-LICENSE-MIT](licenses/crates/42fa16951ce7f24b-LICENSE-MIT) |
| getrandom | 0.4.2 | MIT OR Apache-2.0 | [aaff376532ea30a0-LICENSE-APACHE](licenses/crates/aaff376532ea30a0-LICENSE-APACHE), [523a42c25d245dde-LICENSE-MIT](licenses/crates/523a42c25d245dde-LICENSE-MIT) |
| gimli | 0.32.3 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7b63ecd5f1902af1-LICENSE-MIT](licenses/crates/7b63ecd5f1902af1-LICENSE-MIT) |
| gimli | 0.33.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7b63ecd5f1902af1-LICENSE-MIT](licenses/crates/7b63ecd5f1902af1-LICENSE-MIT) |
| h2 | 0.4.13 | MIT | [b21623012e6c453d-LICENSE](licenses/crates/b21623012e6c453d-LICENSE) |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [ff8f68cb076caf8c-LICENSE-MIT](licenses/crates/ff8f68cb076caf8c-LICENSE-MIT) |
| hashbrown | 0.17.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [ff8f68cb076caf8c-LICENSE-MIT](licenses/crates/ff8f68cb076caf8c-LICENSE-MIT) |
| heck | 0.5.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7b63ecd5f1902af1-LICENSE-MIT](licenses/crates/7b63ecd5f1902af1-LICENSE-MIT) |
| http | 1.3.1 | MIT OR Apache-2.0 | [8bb1b50b0e5c9399-LICENSE-APACHE](licenses/crates/8bb1b50b0e5c9399-LICENSE-APACHE), [dc91f8200e4b2a1f-LICENSE-MIT](licenses/crates/dc91f8200e4b2a1f-LICENSE-MIT) |
| http-body | 1.0.1 | MIT | [cddabf8adc6ccd6c-LICENSE](licenses/crates/cddabf8adc6ccd6c-LICENSE) |
| http-body-util | 0.1.3 | MIT | [b843fb7430efdf97-LICENSE](licenses/crates/b843fb7430efdf97-LICENSE) |
| httparse | 1.10.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [391a5396cec6230b-LICENSE-MIT](licenses/crates/391a5396cec6230b-LICENSE-MIT) |
| httpdate | 1.0.2 | MIT/Apache-2.0 | [4d10fe5f3aa176b0-LICENSE-APACHE](licenses/crates/4d10fe5f3aa176b0-LICENSE-APACHE), [934887691e05d69d-LICENSE-MIT](licenses/crates/934887691e05d69d-LICENSE-MIT) |
| humantime | 2.1.0 | MIT/Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [f6deca8261a8f4a3-LICENSE-MIT](licenses/crates/f6deca8261a8f4a3-LICENSE-MIT) |
| hyper | 1.9.0 | MIT | [2d01890414494742-LICENSE](licenses/crates/2d01890414494742-LICENSE) |
| icu_collections | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_locid | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_locid_transform | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_locid_transform_data | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_normalizer | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_normalizer_data | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_properties | 1.5.1 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_properties_data | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| icu_provider | 1.5.0 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| id-arena | 2.3.0 | MIT/Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [378f5840b258e277-LICENSE-MIT](licenses/crates/378f5840b258e277-LICENSE-MIT) |
| idna | 1.1.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [b38f11f6096706e6-LICENSE-MIT](licenses/crates/b38f11f6096706e6-LICENSE-MIT) |
| idna_adapter | 1.2.0 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [8b43ce8accd61e9d-LICENSE-MIT](licenses/crates/8b43ce8accd61e9d-LICENSE-MIT) |
| indexmap | 2.14.0 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [ecc269ef87fd38a1-LICENSE-MIT](licenses/crates/ecc269ef87fd38a1-LICENSE-MIT) |
| io-extras | 0.19.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [f0c1d22de8bd3b77-COPYRIGHT](licenses/crates/f0c1d22de8bd3b77-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| io-lifetimes | 2.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [495c30b45120f8af-COPYRIGHT](licenses/crates/495c30b45120f8af-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| io-lifetimes | 3.0.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [495c30b45120f8af-COPYRIGHT](licenses/crates/495c30b45120f8af-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| ipnet | 2.5.0 | MIT OR Apache-2.0 | [87d9feb9238c6bd8-LICENSE-APACHE](licenses/crates/87d9feb9238c6bd8-LICENSE-APACHE), [47dc9ff29128ddfb-LICENSE-MIT](licenses/crates/47dc9ff29128ddfb-LICENSE-MIT) |
| is-terminal | 0.4.17 | MIT | [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT), [bab426a663ce3d5b-LICENSE-MIT-atty](licenses/crates/bab426a663ce3d5b-LICENSE-MIT-atty) |
| is_terminal_polyfill | 1.70.1 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| itertools | 0.14.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7576269ea71f767b-LICENSE-MIT](licenses/crates/7576269ea71f767b-LICENSE-MIT) |
| itoa | 1.0.14 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| ittapi | 0.4.0 | GPL-2.0-only OR BSD-3-Clause | [cf48cdd9ed87c203-BSD-3-Clause.txt](licenses/crates/cf48cdd9ed87c203-BSD-3-Clause.txt) (no license file in the crate: used under BSD-3-Clause, the text from ittapi-sys (same upstream, intel/ittapi)) |
| ittapi-sys | 0.4.0 | GPL-2.0-only OR BSD-3-Clause | [cf48cdd9ed87c203-BSD-3-Clause.txt](licenses/crates/cf48cdd9ed87c203-BSD-3-Clause.txt), [cbe0f9505c5ca02e-GPL-2.0-only.txt](licenses/crates/cbe0f9505c5ca02e-GPL-2.0-only.txt), [cf48cdd9ed87c203-BSD-3-Clause.txt](licenses/crates/cf48cdd9ed87c203-BSD-3-Clause.txt), [cbe0f9505c5ca02e-GPL-2.0-only.txt](licenses/crates/cbe0f9505c5ca02e-GPL-2.0-only.txt) |
| json-from-wast | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| lazy_static | 1.4.0 | MIT/Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [0621878e61f0d0fd-LICENSE-MIT](licenses/crates/0621878e61f0d0fd-LICENSE-MIT) |
| leb128 | 0.2.5 | Apache-2.0/MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7b63ecd5f1902af1-LICENSE-MIT](licenses/crates/7b63ecd5f1902af1-LICENSE-MIT) |
| leb128fmt | 0.1.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| libc | 0.2.185 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [123a331b5dbf04c3-LICENSE-MIT](licenses/crates/123a331b5dbf04c3-LICENSE-MIT) |
| libloading | 0.8.6 | ISC | [b29f8b01452350c2-LICENSE](licenses/crates/b29f8b01452350c2-LICENSE) |
| libm | 0.2.16 | MIT | [3823dda7cf046602-LICENSE.txt](licenses/crates/3823dda7cf046602-LICENSE.txt) |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [3290ae0fbc9ddb77-COPYRIGHT](licenses/crates/3290ae0fbc9ddb77-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| litemap | 0.7.4 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| log | 0.4.28 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| logos | 0.14.2 | MIT OR Apache-2.0 | [f30735c114075349-LICENSE-APACHE](licenses/crates/f30735c114075349-LICENSE-APACHE), [112fcdb9f4935988-LICENSE-MIT](licenses/crates/112fcdb9f4935988-LICENSE-MIT) |
| logos-codegen | 0.14.2 | MIT OR Apache-2.0 | [f30735c114075349-LICENSE-APACHE](licenses/crates/f30735c114075349-LICENSE-APACHE), [112fcdb9f4935988-LICENSE-MIT](licenses/crates/112fcdb9f4935988-LICENSE-MIT) |
| matchers | 0.2.0 | MIT | [a47129d738752a6a-LICENSE](licenses/crates/a47129d738752a6a-LICENSE) |
| maybe-owned | 0.3.4 | MIT OR Apache-2.0 | [aecc100d0547aa3b-LICENSE-APACHE](licenses/crates/aecc100d0547aa3b-LICENSE-APACHE), [ef2b3bbd7b718a78-LICENSE-MIT](licenses/crates/ef2b3bbd7b718a78-LICENSE-MIT) |
| memchr | 2.7.6 | Unlicense OR MIT | [01c266bced4a434d-COPYING](licenses/crates/01c266bced4a434d-COPYING), [0f96a83840e146e4-LICENSE-MIT](licenses/crates/0f96a83840e146e4-LICENSE-MIT), [7e12e5df4bae12cb-UNLICENSE](licenses/crates/7e12e5df4bae12cb-UNLICENSE) |
| memfd | 0.6.5 | MIT OR Apache-2.0 | [c71d239df91726fc-LICENSE-APACHE](licenses/crates/c71d239df91726fc-LICENSE-APACHE), [e5d8f26c5b92d382-LICENSE-MIT](licenses/crates/e5d8f26c5b92d382-LICENSE-MIT) |
| mio | 1.2.0 | MIT | [07919255c7e04793-LICENSE](licenses/crates/07919255c7e04793-LICENSE) |
| nu-ansi-term | 0.50.3 | MIT | [2844658604074202-LICENSE](licenses/crates/2844658604074202-LICENSE) |
| object | 0.39.0 | Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [0b74dfa0bcee5c42-LICENSE-MIT](licenses/crates/0b74dfa0bcee5c42-LICENSE-MIT) |
| once_cell | 1.19.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| openvino | 0.11.0 | Apache-2.0 | [074e6e32c86a4c0e-SPDX-Apache-2.0.txt](licenses/crates/074e6e32c86a4c0e-SPDX-Apache-2.0.txt) (no license file in the crate: the SPDX text of its declared license) |
| openvino-finder | 0.11.0 | Apache-2.0 | [074e6e32c86a4c0e-SPDX-Apache-2.0.txt](licenses/crates/074e6e32c86a4c0e-SPDX-Apache-2.0.txt) (no license file in the crate: the SPDX text of its declared license) |
| openvino-sys | 0.11.0 | Apache-2.0 | [074e6e32c86a4c0e-SPDX-Apache-2.0.txt](licenses/crates/074e6e32c86a4c0e-SPDX-Apache-2.0.txt) (no license file in the crate: the SPDX text of its declared license) |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [b38f11f6096706e6-LICENSE-MIT](licenses/crates/b38f11f6096706e6-LICENSE-MIT) |
| pin-project-lite | 0.2.14 | Apache-2.0 OR MIT | [0d542e0c8804e39a-LICENSE-APACHE](licenses/crates/0d542e0c8804e39a-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| pin-utils | 0.1.0 | MIT OR Apache-2.0 | [a4db788775cb25f2-LICENSE-APACHE](licenses/crates/a4db788775cb25f2-LICENSE-APACHE), [28802412d2bfbafe-LICENSE-MIT](licenses/crates/28802412d2bfbafe-LICENSE-MIT) |
| postcard | 1.1.3 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [177540cad091a40e-LICENSE-MIT](licenses/crates/177540cad091a40e-LICENSE-MIT) |
| proc-macro2 | 1.0.101 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| quote | 1.0.41 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| rand | 0.10.1 | MIT OR Apache-2.0 | [90eb64f0279b0d94-COPYRIGHT](licenses/crates/90eb64f0279b0d94-COPYRIGHT), [35242e7a83f69875-LICENSE-APACHE](licenses/crates/35242e7a83f69875-LICENSE-APACHE), [209fbbe0ad52d923-LICENSE-MIT](licenses/crates/209fbbe0ad52d923-LICENSE-MIT) |
| rand_core | 0.10.0 | MIT OR Apache-2.0 | [92b81db30f7ab6d6-COPYRIGHT](licenses/crates/92b81db30f7ab6d6-COPYRIGHT), [6df43f6f4b5d4587-LICENSE-APACHE](licenses/crates/6df43f6f4b5d4587-LICENSE-APACHE), [8b6e9feec03e7c9a-LICENSE-MIT](licenses/crates/8b6e9feec03e7c9a-LICENSE-MIT) |
| rayon | 1.5.3 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [0621878e61f0d0fd-LICENSE-MIT](licenses/crates/0621878e61f0d0fd-LICENSE-MIT) |
| rayon-core | 1.12.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [0621878e61f0d0fd-LICENSE-MIT](licenses/crates/0621878e61f0d0fd-LICENSE-MIT) |
| regalloc2 | 0.15.2 | Apache-2.0 WITH LLVM-exception | [268872b9816f90fd-LICENSE](licenses/crates/268872b9816f90fd-LICENSE) |
| regex | 1.9.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| regex-automata | 0.3.3 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| regex-automata | 0.4.11 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| regex-syntax | 0.7.4 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| regex-syntax | 0.8.5 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [6485b8ed310d3f03-LICENSE-MIT](licenses/crates/6485b8ed310d3f03-LICENSE-MIT) |
| ring | 0.17.14 | Apache-2.0 AND ISC | [b3d734001a94efff-LICENSE](licenses/crates/b3d734001a94efff-LICENSE), [005fc765ddc5115d-LICENSE-BoringSSL](licenses/crates/005fc765ddc5115d-LICENSE-BoringSSL), [f025ccfb7dfb6bdf-LICENSE-other-bits](licenses/crates/f025ccfb7dfb6bdf-LICENSE-other-bits) |
| rustc-demangle | 0.1.24 | MIT/Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [378f5840b258e277-LICENSE-MIT](licenses/crates/378f5840b258e277-LICENSE-MIT) |
| rustc-hash | 2.1.1 | Apache-2.0 OR MIT | [95bd3988beee069f-LICENSE-APACHE](licenses/crates/95bd3988beee069f-LICENSE-APACHE), [30fefc3a7d6a0041-LICENSE-MIT](licenses/crates/30fefc3a7d6a0041-LICENSE-MIT) |
| rustix | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [377c2e7c53250cc5-COPYRIGHT](licenses/crates/377c2e7c53250cc5-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| rustix-linux-procfs | 0.1.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [d415a86ccfd79412-COPYRIGHT](licenses/crates/d415a86ccfd79412-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| rustls | 0.23.37 | Apache-2.0 OR ISC OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7cfafc877eccc46c-LICENSE-ISC](licenses/crates/7cfafc877eccc46c-LICENSE-ISC), [709e3175b4212f7b-LICENSE-MIT](licenses/crates/709e3175b4212f7b-LICENSE-MIT) |
| rustls-pki-types | 1.13.1 | MIT OR Apache-2.0 | [45fd05c4865e7c35-LICENSE-APACHE](licenses/crates/45fd05c4865e7c35-LICENSE-APACHE), [9117d922e6671255-LICENSE-MIT](licenses/crates/9117d922e6671255-LICENSE-MIT) |
| rustls-webpki | 0.103.13 | ISC | [5b698ca13897be3a-LICENSE](licenses/crates/5b698ca13897be3a-LICENSE) |
| ryu | 1.0.9 | Apache-2.0 OR BSL-1.0 | [c71d239df91726fc-LICENSE-APACHE](licenses/crates/c71d239df91726fc-LICENSE-APACHE), [c9bff75738922193-LICENSE-BOOST](licenses/crates/c9bff75738922193-LICENSE-BOOST) |
| semver | 1.0.27 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| serde | 1.0.228 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| serde_core | 1.0.228 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| serde_json | 1.0.140 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| serde_spanned | 1.0.3 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| sha2 | 0.10.2 | MIT OR Apache-2.0 | [a9040321c3712d8f-LICENSE-APACHE](licenses/crates/a9040321c3712d8f-LICENSE-APACHE), [b4eb00df6e2a4d22-LICENSE-MIT](licenses/crates/b4eb00df6e2a4d22-LICENSE-MIT) |
| sharded-slab | 0.1.4 | MIT | [eafbfa606bc005ed-LICENSE](licenses/crates/eafbfa606bc005ed-LICENSE) |
| signal-hook-registry | 1.4.1 | Apache-2.0/MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [503558bfefe66ca1-LICENSE-MIT](licenses/crates/503558bfefe66ca1-LICENSE-MIT) |
| slab | 0.4.11 | MIT | [8ce0830173fdac60-LICENSE](licenses/crates/8ce0830173fdac60-LICENSE) |
| smallvec | 1.15.1 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [0b28172679e0009b-LICENSE-MIT](licenses/crates/0b28172679e0009b-LICENSE-MIT) |
| socket2 | 0.6.3 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [378f5840b258e277-LICENSE-MIT](licenses/crates/378f5840b258e277-LICENSE-MIT) |
| stable_deref_trait | 1.2.0 | MIT/Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [5e05b024f653a5ce-LICENSE-MIT](licenses/crates/5e05b024f653a5ce-LICENSE-MIT) |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 | [cfc7749b96f63bd3-LICENSE-APACHE](licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE), [ea084a2373ebc1f0-LICENSE-MIT](licenses/crates/ea084a2373ebc1f0-LICENSE-MIT) |
| strsim | 0.11.1 | MIT | [1e697ce8d21401fb-LICENSE](licenses/crates/1e697ce8d21401fb-LICENSE) |
| subtle | 2.5.0 | BSD-3-Clause | [36c48715a280d334-LICENSE](licenses/crates/36c48715a280d334-LICENSE) |
| syn | 2.0.106 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| synstructure | 0.13.1 | MIT | [219920e865eee70b-LICENSE](licenses/crates/219920e865eee70b-LICENSE) |
| target-lexicon | 0.13.5 | Apache-2.0 WITH LLVM-exception | [268872b9816f90fd-LICENSE](licenses/crates/268872b9816f90fd-LICENSE) |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [8b427f5bc5017645-LICENSE-MIT](licenses/crates/8b427f5bc5017645-LICENSE-MIT) |
| termcolor | 1.4.1 | Unlicense OR MIT | [01c266bced4a434d-COPYING](licenses/crates/01c266bced4a434d-COPYING), [0f96a83840e146e4-LICENSE-MIT](licenses/crates/0f96a83840e146e4-LICENSE-MIT), [7e12e5df4bae12cb-UNLICENSE](licenses/crates/7e12e5df4bae12cb-UNLICENSE) |
| terminal_size | 0.4.4 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [bc8dcbbd559a61b8-LICENSE-MIT](licenses/crates/bc8dcbbd559a61b8-LICENSE-MIT) |
| thiserror | 1.0.65 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| thiserror | 2.0.17 | MIT OR Apache-2.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| thread_local | 1.1.4 | Apache-2.0/MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [c9a75f18b9ab2927-LICENSE-MIT](licenses/crates/c9a75f18b9ab2927-LICENSE-MIT) |
| tinystr | 0.7.6 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| tokio | 1.51.1 | MIT | [253cd04c6714889d-LICENSE](licenses/crates/253cd04c6714889d-LICENSE) |
| tokio-rustls | 0.26.4 | MIT OR Apache-2.0 | [cc117d90b498b32b-LICENSE-APACHE](licenses/crates/cc117d90b498b32b-LICENSE-APACHE), [e20fa2b8e0a2565f-LICENSE-MIT](licenses/crates/e20fa2b8e0a2565f-LICENSE-MIT) |
| tokio-util | 0.7.16 | MIT | [253cd04c6714889d-LICENSE](licenses/crates/253cd04c6714889d-LICENSE) |
| toml | 0.9.8 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| toml_datetime | 0.7.3 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| toml_parser | 1.0.4 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| toml_writer | 1.0.4 | MIT OR Apache-2.0 | [c6596eb7be8581c1-LICENSE-APACHE](licenses/crates/c6596eb7be8581c1-LICENSE-APACHE), [6efb0476a1cc0850-LICENSE-MIT](licenses/crates/6efb0476a1cc0850-LICENSE-MIT) |
| tracing | 0.1.41 | MIT | [898b1ae9821e98da-LICENSE](licenses/crates/898b1ae9821e98da-LICENSE) |
| tracing-core | 0.1.34 | MIT | [898b1ae9821e98da-LICENSE](licenses/crates/898b1ae9821e98da-LICENSE) |
| tracing-log | 0.2.0 | MIT | [898b1ae9821e98da-LICENSE](licenses/crates/898b1ae9821e98da-LICENSE) |
| tracing-subscriber | 0.3.20 | MIT | [898b1ae9821e98da-LICENSE](licenses/crates/898b1ae9821e98da-LICENSE) |
| try-lock | 0.2.4 | MIT | [69127cd697ac8e4d-LICENSE](licenses/crates/69127cd697ac8e4d-LICENSE) |
| typenum | 1.15.0 | MIT OR Apache-2.0 | [db11fec9946737df-LICENSE](licenses/crates/db11fec9946737df-LICENSE), [516b24e051bf5630-LICENSE-APACHE](licenses/crates/516b24e051bf5630-LICENSE-APACHE), [a825bd853ab71619-LICENSE-MIT](licenses/crates/a825bd853ab71619-LICENSE-MIT) |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT), [f7db81051789b729-LICENSE-UNICODE](licenses/crates/f7db81051789b729-LICENSE-UNICODE) |
| unicode-width | 0.2.0 | MIT OR Apache-2.0 | [23860c2a7b5d96b2-COPYRIGHT](licenses/crates/23860c2a7b5d96b2-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [7b63ecd5f1902af1-LICENSE-MIT](licenses/crates/7b63ecd5f1902af1-LICENSE-MIT) |
| untrusted | 0.9.0 | ISC | [7abd9b6960dcf7d4-LICENSE.txt](licenses/crates/7abd9b6960dcf7d4-LICENSE.txt) |
| url | 2.5.7 | MIT OR Apache-2.0 | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [b38f11f6096706e6-LICENSE-MIT](licenses/crates/b38f11f6096706e6-LICENSE-MIT) |
| utf16_iter | 1.0.5 | Apache-2.0 OR MIT | [b84efe109a420fa3-COPYRIGHT](licenses/crates/b84efe109a420fa3-COPYRIGHT), [cfc7749b96f63bd3-LICENSE-APACHE](licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE), [3fa4ca83dcc92378-LICENSE-MIT](licenses/crates/3fa4ca83dcc92378-LICENSE-MIT) |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | [c30152c94a6d75e0-COPYRIGHT](licenses/crates/c30152c94a6d75e0-COPYRIGHT), [cfc7749b96f63bd3-LICENSE-APACHE](licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE), [3fa4ca83dcc92378-LICENSE-MIT](licenses/crates/3fa4ca83dcc92378-LICENSE-MIT) |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT | [62c7a1e35f564068-LICENSE-APACHE](licenses/crates/62c7a1e35f564068-LICENSE-APACHE), [e4c9b06fa850cb9b-LICENSE-MIT](licenses/crates/e4c9b06fa850cb9b-LICENSE-MIT) |
| uuid | 1.0.0 | Apache-2.0 OR MIT | [b4b2c0de2a05de33-COPYRIGHT](licenses/crates/b4b2c0de2a05de33-COPYRIGHT), [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [436bc5a105d8e57d-LICENSE-MIT](licenses/crates/436bc5a105d8e57d-LICENSE-MIT) |
| want | 0.3.0 | MIT | [a65f5d0a945d2677-LICENSE](licenses/crates/a65f5d0a945d2677-LICENSE) |
| wasm-encoder | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wasm-metadata | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wasm-wave | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wasmparser | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wasmprinter | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wast | 254.0.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wast | 35.0.2 | Apache-2.0 WITH LLVM-exception | [268872b9816f90fd-LICENSE](licenses/crates/268872b9816f90fd-LICENSE) (no license file in the crate: Apache-2.0 WITH LLVM-exception as in wasmtime's LICENSE) |
| wat | 1.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| webpki-roots | 1.0.7 | CDLA-Permissive-2.0 | [e271993808fec50a-LICENSE](licenses/crates/e271993808fec50a-LICENSE) |
| winnow | 0.7.13 | MIT | [cb5aedb296c5246d-LICENSE-MIT](licenses/crates/cb5aedb296c5246d-LICENSE-MIT) |
| wit-component | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| wit-parser | 0.254.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [a60eea8175145316-LICENSE-APACHE](licenses/crates/a60eea8175145316-LICENSE-APACHE), [268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception](licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception), [23f18e03dc49df91-LICENSE-MIT](licenses/crates/23f18e03dc49df91-LICENSE-MIT) |
| witx | 0.9.1 | Apache-2.0 | [8a29d5e911226e86-LICENSE](licenses/crates/8a29d5e911226e86-LICENSE) |
| write16 | 1.0.0 | Apache-2.0 OR MIT | [3210be7332b5bdf4-COPYRIGHT](licenses/crates/3210be7332b5bdf4-COPYRIGHT), [cfc7749b96f63bd3-LICENSE-APACHE](licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE), [3fa4ca83dcc92378-LICENSE-MIT](licenses/crates/3fa4ca83dcc92378-LICENSE-MIT) |
| writeable | 0.5.5 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| yoke | 0.7.5 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| zerofrom | 0.1.5 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| zeroize | 1.8.2 | Apache-2.0 OR MIT | [cfc7749b96f63bd3-LICENSE-APACHE](licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE), [0b04ee3ce0021a92-LICENSE-MIT](licenses/crates/0b04ee3ce0021a92-LICENSE-MIT) |
| zerovec | 0.10.4 | Unicode-3.0 | [f367c1b8e1aa2624-LICENSE](licenses/crates/f367c1b8e1aa2624-LICENSE) |
| zstd | 0.13.0 | MIT | [129e8edef29e9abc-LICENSE](licenses/crates/129e8edef29e9abc-LICENSE) |
| zstd-safe | 7.0.0 | MIT/Apache-2.0 | [a77b7cfeaf911ed4-LICENSE](licenses/crates/a77b7cfeaf911ed4-LICENSE), [0d542e0c8804e39a-LICENSE.Apache-2.0](licenses/crates/0d542e0c8804e39a-LICENSE.Apache-2.0), [129e8edef29e9abc-LICENSE.Mit](licenses/crates/129e8edef29e9abc-LICENSE.Mit) |
| zstd-sys | 2.0.9+zstd.1.5.5 | MIT/Apache-2.0 | [a77b7cfeaf911ed4-LICENSE](licenses/crates/a77b7cfeaf911ed4-LICENSE), [0d542e0c8804e39a-LICENSE.Apache-2.0](licenses/crates/0d542e0c8804e39a-LICENSE.Apache-2.0), [48341f685c873040-LICENSE.BSD-3-Clause](licenses/crates/48341f685c873040-LICENSE.BSD-3-Clause), [129e8edef29e9abc-LICENSE.Mit](licenses/crates/129e8edef29e9abc-LICENSE.Mit), [7055266497633c90-LICENSE](licenses/crates/7055266497633c90-LICENSE), [f9c375a1be4a41f7-COPYING](licenses/crates/f9c375a1be4a41f7-COPYING) |

Where a crate is offered under a choice of licenses ("X OR Y"), it is used under any one of them; for the two crates offered as "GPL-2.0-only OR BSD-3-Clause" (ittapi, ittapi-sys), under BSD-3-Clause.

## The texts, by sha256

| file | sha256 | taken from |
|---|---|---|
| licenses/crates/005fc765ddc5115d-LICENSE-BoringSSL | 005fc765ddc5115da796cca915baa9557abae13ff35e0a47c47affc56f6c414d | crates.io: ring-0.17.14/LICENSE-BoringSSL |
| licenses/crates/01c266bced4a434d-COPYING | 01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f | crates.io: aho-corasick-1.0.2/COPYING; also crates.io: memchr-2.7.6/COPYING; also crates.io: termcolor-1.4.1/COPYING |
| licenses/crates/0621878e61f0d0fd-LICENSE-MIT | 0621878e61f0d0fda054bcbe02df75192c28bde1ecc8289cbd86aeba2dd72720 | crates.io: lazy_static-1.4.0/LICENSE-MIT; also crates.io: rayon-1.5.3/LICENSE-MIT; also crates.io: rayon-core-1.12.0/LICENSE-MIT |
| licenses/crates/074e6e32c86a4c0e-SPDX-Apache-2.0.txt | 074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff | the SPDX text (Arch package licenses): Apache-2.0.txt; also the SPDX text (Arch package licenses): Apache-2.0.txt; also the SPDX text (Arch package licenses): Apache-2.0.txt; also the SPDX text (Arch package licenses): Apache-2.0.txt |
| licenses/crates/07919255c7e04793-LICENSE | 07919255c7e04793d8ea760d6c2ce32d19f9ff02bdbdde3ce90b1e1880929a9b | crates.io: mio-1.2.0/LICENSE |
| licenses/crates/0816e154b159ba25-LICENSE-MIT | 0816e154b159ba255c563f7c8c7df5bbb8cc5fc96f5ab8cf9f4743b4f41fe7eb | crates.io: fallible-iterator-0.3.0/LICENSE-MIT |
| licenses/crates/0b04ee3ce0021a92-LICENSE-MIT | 0b04ee3ce0021a922f43f37a17fee09a5a1ee6d1f4e149d5bf75b72395a49c72 | crates.io: zeroize-1.8.2/LICENSE-MIT |
| licenses/crates/0b28172679e0009b-LICENSE-MIT | 0b28172679e0009b655da42797c03fd163a3379d5cfa67ba1f1655e974a2a1a9 | crates.io: smallvec-1.15.1/LICENSE-MIT |
| licenses/crates/0b74dfa0bcee5c42-LICENSE-MIT | 0b74dfa0bcee5c420c6b7f67b4b2658f9ab8388c97b8e733975f2cecbdd668a6 | crates.io: object-0.39.0/LICENSE-MIT |
| licenses/crates/0d542e0c8804e39a-LICENSE-APACHE | 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594 | crates.io: pin-project-lite-0.2.14/LICENSE-APACHE |
| licenses/crates/0d542e0c8804e39a-LICENSE.Apache-2.0 | 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594 | crates.io: zstd-safe-7.0.0/LICENSE.Apache-2.0; also crates.io: zstd-sys-2.0.9+zstd.1.5.5/LICENSE.Apache-2.0 |
| licenses/crates/0dd882e53de11566-LICENSE-MIT | 0dd882e53de11566d50f8e8e2d5a651bcf3fabee4987d70f306233cf39094ba7 | crates.io: base64-0.22.1/LICENSE-MIT |
| licenses/crates/0f96a83840e146e4-LICENSE-MIT | 0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f | crates.io: aho-corasick-1.0.2/LICENSE-MIT; also crates.io: memchr-2.7.6/LICENSE-MIT; also crates.io: termcolor-1.4.1/LICENSE-MIT |
| licenses/crates/112fcdb9f4935988-LICENSE-MIT | 112fcdb9f4935988cc2313e4cc38faaeccfff53eb1296499e618932d472908e0 | crates.io: logos-0.14.2/LICENSE-MIT; also crates.io: logos-codegen-0.14.2/LICENSE-MIT |
| licenses/crates/11789f45bb180841-COPYRIGHT | 11789f45bb180841cd362a5eee6789c68ddb573a11105e30768c308a6add0190 | crates.io: encoding_rs-0.8.31/COPYRIGHT |
| licenses/crates/11955c617c19899b-LICENSE-MIT | 11955c617c19899b5c36d78c916739d1686f2e7ad8e3cec684c2f0f73b0db950 | crates.io: directories-next-2.0.0/LICENSE-MIT |
| licenses/crates/123a331b5dbf04c3-LICENSE-MIT | 123a331b5dbf04c30097fa43b8f858bc85df671fe776de498d01f3d6b7c1f69e | crates.io: libc-0.2.185/LICENSE-MIT |
| licenses/crates/129e8edef29e9abc-LICENSE | 129e8edef29e9abcd2ebabe252f4ef1b1289cdca356bf0040284a2fbccfb96c8 | crates.io: zstd-0.13.0/LICENSE |
| licenses/crates/129e8edef29e9abc-LICENSE.Mit | 129e8edef29e9abcd2ebabe252f4ef1b1289cdca356bf0040284a2fbccfb96c8 | crates.io: zstd-safe-7.0.0/LICENSE.Mit; also crates.io: zstd-sys-2.0.9+zstd.1.5.5/LICENSE.Mit |
| licenses/crates/15656cc11a8331f2-LICENSE-MIT | 15656cc11a8331f28c0986b8ab97220d3e76f98e60ed388b5ffad37dfac4710c | crates.io: arbitrary-1.4.2/LICENSE-MIT |
| licenses/crates/177540cad091a40e-LICENSE-MIT | 177540cad091a40e8071db310bc3b6115c4e329a92a234609b60c154b008a888 | crates.io: postcard-1.1.3/LICENSE-MIT |
| licenses/crates/1e697ce8d21401fb-LICENSE | 1e697ce8d21401fbf1bddd9b5c3fd4c4c79ae1e3bdf51f81761c85e11d5a89cd | crates.io: strsim-0.11.1/LICENSE |
| licenses/crates/209fbbe0ad52d923-LICENSE-MIT | 209fbbe0ad52d9235e37badf9cadfe4dbdc87203179c0899e738b39ade42177b | crates.io: rand-0.10.1/LICENSE-MIT |
| licenses/crates/20c7855c364d57ea-LICENSE-MIT | 20c7855c364d57ea4c97889a5e8d98470a9952dade37bd9248b9a54431670e5e | crates.io: form_urlencoded-1.2.2/LICENSE-MIT |
| licenses/crates/20fe7b00e904ed69-LICENSE-APACHE | 20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58 | crates.io: allocator-api2-0.2.20/LICENSE-APACHE |
| licenses/crates/219920e865eee70b-LICENSE | 219920e865eee70b7dcfc948a86b099e7f4fe2de01bcca2ca9a20c0a033f2b59 | crates.io: synstructure-0.13.1/LICENSE |
| licenses/crates/23860c2a7b5d96b2-COPYRIGHT | 23860c2a7b5d96b21569afedf033469bab9fe14a1b24a35068b8641c578ce24d | crates.io: unicode-width-0.2.0/COPYRIGHT |
| licenses/crates/23f18e03dc49df91-LICENSE-MIT | 23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3 | crates.io: ambient-authority-0.0.2/LICENSE-MIT; also crates.io: anyhow-1.0.103/LICENSE-MIT; also crates.io: atomic-waker-1.1.2/LICENSE-MIT; also crates.io: cap-fs-ext-4.0.3/LICENSE-MIT; also crates.io: cap-primitives-4.0.3/LICENSE-MIT; also crates.io: cap-std-4.0.3/LICENSE-MIT; also crates.io: env_logger-0.10.0/LICENSE-MIT; also crates.io: fastrand-2.3.0/LICENSE-MIT; also crates.io: fs-set-times-0.20.3/LICENSE-MIT; also crates.io: io-extras-0.19.0/LICENSE-MIT; also crates.io: io-lifetimes-2.0.3/LICENSE-MIT; also crates.io: io-lifetimes-3.0.1/LICENSE-MIT; also crates.io: is-terminal-0.4.17/LICENSE-MIT; also crates.io: itoa-1.0.14/LICENSE-MIT; also crates.io: json-from-wast-0.254.0/LICENSE-MIT; also crates.io: leb128fmt-0.1.0/LICENSE-MIT; also crates.io: linux-raw-sys-0.12.1/LICENSE-MIT; also crates.io: once_cell-1.19.0/LICENSE-MIT; also crates.io: pin-project-lite-0.2.14/LICENSE-MIT; also crates.io: proc-macro2-1.0.101/LICENSE-MIT; also crates.io: quote-1.0.41/LICENSE-MIT; also crates.io: rustix-1.1.4/LICENSE-MIT; also crates.io: rustix-linux-procfs-0.1.1/LICENSE-MIT; also crates.io: semver-1.0.27/LICENSE-MIT; also crates.io: serde-1.0.228/LICENSE-MIT; also crates.io: serde_core-1.0.228/LICENSE-MIT; also crates.io: serde_json-1.0.140/LICENSE-MIT; also crates.io: syn-2.0.106/LICENSE-MIT; also crates.io: thiserror-1.0.65/LICENSE-MIT; also crates.io: thiserror-2.0.17/LICENSE-MIT; also crates.io: unicode-ident-1.0.24/LICENSE-MIT; also crates.io: wasm-encoder-0.254.0/LICENSE-MIT; also crates.io: wasm-metadata-0.254.0/LICENSE-MIT; also crates.io: wasm-wave-0.254.0/LICENSE-MIT; also crates.io: wasmparser-0.254.0/LICENSE-MIT; also crates.io: wasmprinter-0.254.0/LICENSE-MIT; also crates.io: wast-254.0.0/LICENSE-MIT; also crates.io: wat-1.254.0/LICENSE-MIT; also crates.io: wit-component-0.254.0/LICENSE-MIT; also crates.io: wit-parser-0.254.0/LICENSE-MIT |
| licenses/crates/253cd04c6714889d-LICENSE | 253cd04c6714889df2d32f3f64d669179a1c95c76ac43c40882c52eb06bc3552 | crates.io: tokio-1.51.1/LICENSE; also crates.io: tokio-util-0.7.16/LICENSE |
| licenses/crates/268872b9816f90fd-LICENSE | 268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5 | crates.io: regalloc2-0.15.2/LICENSE; also crates.io: target-lexicon-0.13.5/LICENSE; also wasmtime v48.0.1: LICENSE |
| licenses/crates/268872b9816f90fd-LICENSE-Apache-2.0_WITH_LLVM-exception | 268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5 | crates.io: ambient-authority-0.0.2/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: cap-fs-ext-4.0.3/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: cap-primitives-4.0.3/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: cap-std-4.0.3/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: fs-set-times-0.20.3/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: io-extras-0.19.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: io-lifetimes-2.0.3/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: io-lifetimes-3.0.1/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: json-from-wast-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: linux-raw-sys-0.12.1/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: rustix-1.1.4/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: rustix-linux-procfs-0.1.1/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wasm-encoder-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wasm-metadata-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wasm-wave-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wasmparser-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wasmprinter-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wast-254.0.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wat-1.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wit-component-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception; also crates.io: wit-parser-0.254.0/LICENSE-Apache-2.0_WITH_LLVM-exception |
| licenses/crates/275c491d6d116055-LICENSE-APACHE | 275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427 | crates.io: futures-0.3.31/LICENSE-APACHE; also crates.io: futures-channel-0.3.31/LICENSE-APACHE; also crates.io: futures-core-0.3.31/LICENSE-APACHE; also crates.io: futures-io-0.3.31/LICENSE-APACHE; also crates.io: futures-sink-0.3.31/LICENSE-APACHE; also crates.io: futures-task-0.3.31/LICENSE-APACHE; also crates.io: futures-util-0.3.31/LICENSE-APACHE |
| licenses/crates/2844658604074202-LICENSE | 284465860407420254e39be4e1bdcaaf2e7f2d18e06f9bab75bc75341a5d8501 | crates.io: nu-ansi-term-0.50.3/LICENSE |
| licenses/crates/28802412d2bfbafe-LICENSE-MIT | 28802412d2bfbafe432b305634413b41a984d30fba0df41d30aa2c8a2077c5b1 | crates.io: pin-utils-0.1.0/LICENSE-MIT |
| licenses/crates/2d01890414494742-LICENSE | 2d01890414494742ba4a509fcec8efa40f6d8be22cbd72be7cff08d6fda4ec89 | crates.io: hyper-1.9.0/LICENSE |
| licenses/crates/30fefc3a7d6a0041-LICENSE-MIT | 30fefc3a7d6a0041541858293bcbea2dde4caa4c0a5802f996a7f7e8c0085652 | crates.io: rustc-hash-2.1.1/LICENSE-MIT |
| licenses/crates/3210be7332b5bdf4-COPYRIGHT | 3210be7332b5bdf48eb24a945258b9f38616a2cceb0dfc06e3c3c7e9740475a0 | crates.io: write16-1.0.0/COPYRIGHT |
| licenses/crates/3290ae0fbc9ddb77-COPYRIGHT | 3290ae0fbc9ddb77d2239121d710f0bb9d31b3b4744e6d97fe01e652b4c1870b | crates.io: linux-raw-sys-0.12.1/COPYRIGHT |
| licenses/crates/3521672491a34794-LICENSE-MIT | 3521672491a3479422d5fe1aca6645dd2984090f85da6e5205abfb18fb7a6897 | crates.io: crypto-common-0.1.6/LICENSE-MIT |
| licenses/crates/35242e7a83f69875-LICENSE-APACHE | 35242e7a83f69875e6edeff02291e688c97caafe2f8902e4e19b49d3e78b4cab | crates.io: rand-0.10.1/LICENSE-APACHE |
| licenses/crates/357ada6815fdfec8-LICENSE | 357ada6815fdfec863fe4bd63d978fc15e386f4a819098eba04f273eb80b5741 | crates.io: capstone-0.14.0/LICENSE |
| licenses/crates/36516aefdc84c5d5-LICENSE-MIT | 36516aefdc84c5d5a1e7485425913a22dbda69eb1930c5e84d6ae4972b5194b9 | crates.io: allocator-api2-0.2.20/LICENSE-MIT |
| licenses/crates/36c48715a280d334-LICENSE | 36c48715a280d334a995f26fc38103f21cb92425a20c8eeaa368b229b49b6d4d | crates.io: subtle-2.5.0/LICENSE |
| licenses/crates/377c2e7c53250cc5-COPYRIGHT | 377c2e7c53250cc5905c0b0532d35973392af16ffb9596a41d99d202cf3617c9 | crates.io: rustix-1.1.4/COPYRIGHT |
| licenses/crates/378f5840b258e277-LICENSE-MIT | 378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397 | crates.io: cfg-if-1.0.0/LICENSE-MIT; also crates.io: id-arena-2.3.0/LICENSE-MIT; also crates.io: rustc-demangle-0.1.24/LICENSE-MIT; also crates.io: socket2-0.6.3/LICENSE-MIT |
| licenses/crates/3823dda7cf046602-LICENSE.txt | 3823dda7cf046602f4b4e77ec8e227863dc4736037cc85bb33d9f19febe16bb7 | crates.io: libm-0.2.16/LICENSE.txt |
| licenses/crates/391a5396cec6230b-LICENSE-MIT | 391a5396cec6230bfabd4ef4eb2350eb895bc5efce377a2218f5702ed020d3e3 | crates.io: httparse-1.10.1/LICENSE-MIT |
| licenses/crates/3fa4ca83dcc92378-LICENSE-MIT | 3fa4ca83dcc9237839b1bdeb2e6d16bdfb5ec0c5ce42b24694d8bbf0dcbef72c | crates.io: encoding_rs-0.8.31/LICENSE-MIT; also crates.io: utf16_iter-1.0.5/LICENSE-MIT; also crates.io: utf8_iter-1.0.4/LICENSE-MIT; also crates.io: write16-1.0.0/LICENSE-MIT |
| licenses/crates/42fa16951ce7f24b-LICENSE-MIT | 42fa16951ce7f24b5a467a40e5b449a1d41e662f97ca779864f053f39e097737 | crates.io: getrandom-0.2.15/LICENSE-MIT |
| licenses/crates/436bc5a105d8e57d-LICENSE-MIT | 436bc5a105d8e57dcd8778730f3754f7bf39c14d2f530e4cde4bd2d17a83ec3d | crates.io: uuid-1.0.0/LICENSE-MIT |
| licenses/crates/45f522cacecb1023-LICENSE | 45f522cacecb1023856e46df79ca625dfc550c94910078bd8aec6e02880b3d42 | crates.io: bytes-1.11.1/LICENSE |
| licenses/crates/45fd05c4865e7c35-LICENSE-APACHE | 45fd05c4865e7c350b98ad7ac50e1b15462d49af4a91e9b0c9dd933dc9a69742 | crates.io: rustls-pki-types-1.13.1/LICENSE-APACHE |
| licenses/crates/47dc9ff29128ddfb-LICENSE-MIT | 47dc9ff29128ddfb4d6a0435383c9f89120bc374dbcc1dd00b933a0b28aa7865 | crates.io: ipnet-2.5.0/LICENSE-MIT |
| licenses/crates/48341f685c873040-LICENSE.BSD-3-Clause | 48341f685c87304089aa099b23c386f8bacc519ef555aa7a13e239908907b3fd | crates.io: zstd-sys-2.0.9+zstd.1.5.5/LICENSE.BSD-3-Clause |
| licenses/crates/495c30b45120f8af-COPYRIGHT | 495c30b45120f8af07cfa26eb9cb1ebfe8324560dca2b3b1e76cad1b9b6b489a | crates.io: io-lifetimes-2.0.3/COPYRIGHT; also crates.io: io-lifetimes-3.0.1/COPYRIGHT |
| licenses/crates/4d10fe5f3aa176b0-LICENSE-APACHE | 4d10fe5f3aa176b05b229a248866bad70b834c173f1252a814ff4748d8a13837 | crates.io: httpdate-1.0.2/LICENSE-APACHE |
| licenses/crates/503558bfefe66ca1-LICENSE-MIT | 503558bfefe66ca15e4e3f7955b3cb0ec87fd52f29bf24b336af7bd00e946d5c | crates.io: signal-hook-registry-1.4.1/LICENSE-MIT |
| licenses/crates/516b24e051bf5630-LICENSE-APACHE | 516b24e051bf5630880ebbd55c40a25ce9552ebaf8970a53e8976eb70e522406 | crates.io: typenum-1.15.0/LICENSE-APACHE |
| licenses/crates/523a42c25d245dde-LICENSE-MIT | 523a42c25d245dde9c015f882cec7f4555aad883382a6cf19b4b7d9b2cd5419b | crates.io: getrandom-0.4.2/LICENSE-MIT |
| licenses/crates/5734ed989dfca1f6-LICENSE-MIT | 5734ed989dfca1f625b40281ee9f4530f91b2411ec01cb748223e7eb87e201ab | crates.io: crossbeam-deque-0.8.1/LICENSE-MIT; also crates.io: crossbeam-epoch-0.9.20/LICENSE-MIT; also crates.io: crossbeam-utils-0.8.20/LICENSE-MIT |
| licenses/crates/5b3d8a674979e158-COPYRIGHT | 5b3d8a674979e158328c57f5c4cc12150df79d0bdf12c86eafc2e9c6006a2d4e | crates.io: cap-fs-ext-4.0.3/COPYRIGHT |
| licenses/crates/5b698ca13897be3a-LICENSE | 5b698ca13897be3afdb7174256fa1574f8c6892b8bea1a66dd6469d3fe27885a | crates.io: rustls-webpki-0.103.13/LICENSE |
| licenses/crates/5e05b024f653a5ce-LICENSE-MIT | 5e05b024f653a5ce199e77cbbbd42fb5553562ec714b819421ed0c3e552a75d7 | crates.io: stable_deref_trait-1.2.0/LICENSE-MIT |
| licenses/crates/61d383b05b87d78f-LICENSE-MIT | 61d383b05b87d78f94d2937e2580cce47226d17823c0430fbcad09596537efcf | crates.io: crc32fast-1.3.2/LICENSE-MIT |
| licenses/crates/6226d0632e2e1a80-LICENSE-THIRD-PARTY | 6226d0632e2e1a80c23597e964da9812ae193c535fe058154afb034e94167aa5 | crates.io: atomic-waker-1.1.2/LICENSE-THIRD-PARTY |
| licenses/crates/62c7a1e35f564068-LICENSE-APACHE | 62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a | crates.io: anyhow-1.0.103/LICENSE-APACHE; also crates.io: itoa-1.0.14/LICENSE-APACHE; also crates.io: libc-0.2.185/LICENSE-APACHE; also crates.io: proc-macro2-1.0.101/LICENSE-APACHE; also crates.io: quote-1.0.41/LICENSE-APACHE; also crates.io: semver-1.0.27/LICENSE-APACHE; also crates.io: serde-1.0.228/LICENSE-APACHE; also crates.io: serde_core-1.0.228/LICENSE-APACHE; also crates.io: serde_json-1.0.140/LICENSE-APACHE; also crates.io: syn-2.0.106/LICENSE-APACHE; also crates.io: thiserror-1.0.65/LICENSE-APACHE; also crates.io: thiserror-2.0.17/LICENSE-APACHE; also crates.io: unicode-ident-1.0.24/LICENSE-APACHE; also crates.io: utf8parse-0.2.2/LICENSE-APACHE |
| licenses/crates/6485b8ed310d3f03-LICENSE-MIT | 6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb | crates.io: bitflags-2.11.1/LICENSE-MIT; also crates.io: log-0.4.28/LICENSE-MIT; also crates.io: regex-1.9.1/LICENSE-MIT; also crates.io: regex-automata-0.3.3/LICENSE-MIT; also crates.io: regex-automata-0.4.11/LICENSE-MIT; also crates.io: regex-syntax-0.7.4/LICENSE-MIT; also crates.io: regex-syntax-0.8.5/LICENSE-MIT |
| licenses/crates/65e9ed46a59976ed-LICENSE.TXT | 65e9ed46a59976eda8f5bd1ea79a680dea38dd299c760bc9a8d87a764ef5029b | crates.io: capstone-sys-0.18.0/capstone/LICENSE.TXT |
| licenses/crates/65f94e99ddaf4f5d-LICENSE-MIT | 65f94e99ddaf4f5d1782a6dae23f35d4293a9a01444a13135a6887017d353cee | crates.io: bumpalo-3.20.2/LICENSE-MIT |
| licenses/crates/65fdb6c76cd61612-LICENSE-MIT | 65fdb6c76cd61612070c066eec9ecdb30ee74fb27859d0d9af58b9f499fd0c3e | crates.io: fnv-1.0.7/LICENSE-MIT |
| licenses/crates/6652c868f35dfe5e-LICENSE-MIT | 6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd | crates.io: futures-0.3.31/LICENSE-MIT; also crates.io: futures-channel-0.3.31/LICENSE-MIT; also crates.io: futures-core-0.3.31/LICENSE-MIT; also crates.io: futures-io-0.3.31/LICENSE-MIT; also crates.io: futures-sink-0.3.31/LICENSE-MIT; also crates.io: futures-task-0.3.31/LICENSE-MIT; also crates.io: futures-util-0.3.31/LICENSE-MIT |
| licenses/crates/69127cd697ac8e4d-LICENSE | 69127cd697ac8e4da8d4a206ae067bbeb2aef41618c4be521509772110c4f202 | crates.io: try-lock-0.2.4/LICENSE |
| licenses/crates/6a2e0ade09a7d5f8-LICENSE-MIT | 6a2e0ade09a7d5f816f11566fee2b151b32235a7fad52b41d49cce96f833c1a9 | crates.io: dirs-sys-next-0.1.2/LICENSE-MIT |
| licenses/crates/6b1691fdee3b03c3-COPYRIGHT | 6b1691fdee3b03c3946696a7be125fcf50eff310b9486fac850c1b8aea91478b | crates.io: cap-std-4.0.3/COPYRIGHT |
| licenses/crates/6df43f6f4b5d4587-LICENSE-APACHE | 6df43f6f4b5d4587f3d8d71e45532c688fd168afa5fe89d571cb32fa09c4ef51 | crates.io: rand_core-0.10.0/LICENSE-APACHE |
| licenses/crates/6efb0476a1cc0850-LICENSE-MIT | 6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6 | crates.io: anstream-0.6.21/LICENSE-MIT; also crates.io: anstyle-1.0.13/LICENSE-MIT; also crates.io: anstyle-parse-0.2.7/LICENSE-MIT; also crates.io: anstyle-query-1.1.5/LICENSE-MIT; also crates.io: clap-4.5.48/LICENSE-MIT; also crates.io: clap_builder-4.5.48/LICENSE-MIT; also crates.io: clap_complete-4.5.58/LICENSE-MIT; also crates.io: clap_lex-0.7.5/LICENSE-MIT; also crates.io: colorchoice-1.0.4/LICENSE-MIT; also crates.io: is_terminal_polyfill-1.70.1/LICENSE-MIT; also crates.io: serde_spanned-1.0.3/LICENSE-MIT; also crates.io: toml-0.9.8/LICENSE-MIT; also crates.io: toml_datetime-0.7.3/LICENSE-MIT; also crates.io: toml_parser-1.0.4/LICENSE-MIT; also crates.io: toml_writer-1.0.4/LICENSE-MIT |
| licenses/crates/7055266497633c90-LICENSE | 7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8 | crates.io: zstd-sys-2.0.9+zstd.1.5.5/zstd/LICENSE |
| licenses/crates/709e3175b4212f7b-LICENSE-MIT | 709e3175b4212f7b13aa93971c9f62ff8c69ec45ad8c6532a7e0c41d7a7d6f8c | crates.io: rustls-0.23.37/LICENSE-MIT |
| licenses/crates/7365cc8878a1d7ce-LICENSE-MIT | 7365cc8878a1d7ce155a58c4ca09c3d7a6be413efa5334a80ea842912b669349 | crates.io: equivalent-1.0.1/LICENSE-MIT |
| licenses/crates/7576269ea71f767b-LICENSE-MIT | 7576269ea71f767b99297934c0b2367532690f8c4badc695edf8e04ab6a1e545 | crates.io: either-1.13.0/LICENSE-MIT; also crates.io: itertools-0.14.0/LICENSE-MIT |
| licenses/crates/7abd9b6960dcf7d4-LICENSE.txt | 7abd9b6960dcf7d4d0a48606a5b71bfe37d472db68d70637f3a58a56785f1621 | crates.io: untrusted-0.9.0/LICENSE.txt |
| licenses/crates/7b63ecd5f1902af1-LICENSE-MIT | 7b63ecd5f1902af1b63729947373683c32745c16a10e8e6292e2e2dcd7e90ae0 | crates.io: cpp_demangle-0.5.1/LICENSE-MIT; also crates.io: gimli-0.32.3/LICENSE-MIT; also crates.io: gimli-0.33.0/LICENSE-MIT; also crates.io: heck-0.5.0/LICENSE-MIT; also crates.io: leb128-0.2.5/LICENSE-MIT; also crates.io: unicode-width-0.2.0/LICENSE-MIT |
| licenses/crates/7cfafc877eccc46c-LICENSE-ISC | 7cfafc877eccc46c0e346ccbaa5c51bb6b894d2b818e617d970211e232785ad4 | crates.io: rustls-0.23.37/LICENSE-ISC |
| licenses/crates/7e12e5df4bae12cb-UNLICENSE | 7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c | crates.io: aho-corasick-1.0.2/UNLICENSE; also crates.io: memchr-2.7.6/UNLICENSE; also crates.io: termcolor-1.4.1/UNLICENSE |
| licenses/crates/809a5649163758f9-LICENSE-MIT | 809a5649163758f9182c72fa09fd50a426b5966dd1b4720915ba024c6b910356 | crates.io: beef-0.5.2/LICENSE-MIT |
| licenses/crates/838118388fe5c2e7-LICENSE-WHATWG | 838118388fe5c2e7f1dbbaeed13e1c7f3ebf88be91319c7c1d77c18e987d1a50 | crates.io: encoding_rs-0.8.31/LICENSE-WHATWG |
| licenses/crates/87d9feb9238c6bd8-LICENSE-APACHE | 87d9feb9238c6bd8e0024fc4733b06cff036f89f36d93b7df1c8a0549bbb7a5b | crates.io: ipnet-2.5.0/LICENSE-APACHE |
| licenses/crates/898b1ae9821e98da-LICENSE | 898b1ae9821e98daf8964c8d6c7f61641f5f5aa78ad500020771c0939ee0dea1 | crates.io: tracing-0.1.41/LICENSE; also crates.io: tracing-core-0.1.34/LICENSE; also crates.io: tracing-log-0.2.0/LICENSE; also crates.io: tracing-subscriber-0.3.20/LICENSE |
| licenses/crates/8a29d5e911226e86-LICENSE | 8a29d5e911226e86f898fc689d939b2c6b2e3b238343fcbf1d0b4e7dc3c7ea40 | crates.io: witx-0.9.1/LICENSE |
| licenses/crates/8b427f5bc5017645-LICENSE-MIT | 8b427f5bc501764575e52ba4f9d95673cf8f6d80a86d0d06599852e1a9a20a36 | crates.io: tempfile-3.27.0/LICENSE-MIT |
| licenses/crates/8b43ce8accd61e9d-LICENSE-MIT | 8b43ce8accd61e9d370b5ca9e9c4f953279b5c239926c62315b40e24df51b726 | crates.io: idna_adapter-1.2.0/LICENSE-MIT |
| licenses/crates/8b6e9feec03e7c9a-LICENSE-MIT | 8b6e9feec03e7c9a5facb26855cecd31662bf989b636bcfe79521bdf8ac863f0 | crates.io: rand_core-0.10.0/LICENSE-MIT |
| licenses/crates/8bb1b50b0e5c9399-LICENSE-APACHE | 8bb1b50b0e5c9399ae33bd35fab2769010fa6c14e8860c729a52295d84896b7a | crates.io: http-1.3.1/LICENSE-APACHE |
| licenses/crates/8ce0830173fdac60-LICENSE | 8ce0830173fdac609dfb4ea603fdc002c2f4af0dc9b1a005653f5da9cf534b18 | crates.io: slab-0.4.11/LICENSE |
| licenses/crates/904801faf3f18503-LICENSE-MIT | 904801faf3f1850328af8e1aa1047b9190cc22ed40df5c87f2d93d17f847ef67 | crates.io: cpufeatures-0.2.7/LICENSE-MIT |
| licenses/crates/90eb64f0279b0d94-COPYRIGHT | 90eb64f0279b0d9432accfa6023ff803bc4965212383697eee27a0f426d5f8d5 | crates.io: rand-0.10.1/COPYRIGHT |
| licenses/crates/9117d922e6671255-LICENSE-MIT | 9117d922e667125508dde62b02c1f57ed22f5ad21eb536aa2e2d99e1c796e639 | crates.io: rustls-pki-types-1.13.1/LICENSE-MIT |
| licenses/crates/92b81db30f7ab6d6-COPYRIGHT | 92b81db30f7ab6d693e0af5661a40d273ca1947e891123ed823924192c10cbc7 | crates.io: rand_core-0.10.0/COPYRIGHT |
| licenses/crates/934887691e05d69d-LICENSE-MIT | 934887691e05d69d7c86ad3f2c360980fa30c15b035e351f3c9865e99da4debc | crates.io: httpdate-1.0.2/LICENSE-MIT |
| licenses/crates/95bd3988beee069f-LICENSE-APACHE | 95bd3988beee069fa2848f648dab43cc6e0b2add2ad6bcb17360caf749802bcc | crates.io: rustc-hash-2.1.1/LICENSE-APACHE |
| licenses/crates/9e0dfd2dd4173a53-LICENSE-MIT | 9e0dfd2dd4173a530e238cb6adb37aa78c34c6bc7444e0e10c1ab5d8881f63ba | crates.io: digest-0.10.7/LICENSE-MIT |
| licenses/crates/a446f219aabe3667-LICENSE | a446f219aabe3667850444bbd5f11b7e931889b4d5dbf3bc074fe00f25f1124c | crates.io: capstone-sys-0.18.0/LICENSE |
| licenses/crates/a47129d738752a6a-LICENSE | a47129d738752a6ae52247fea645b42cb320d19e9327f1eb2d1a7f99d9455ad3 | crates.io: matchers-0.2.0/LICENSE |
| licenses/crates/a4db788775cb25f2-LICENSE-APACHE | a4db788775cb25f2da419a7ccd3f1f89c3d2cfa8748fb25257596b88183b4c77 | crates.io: pin-utils-0.1.0/LICENSE-APACHE |
| licenses/crates/a60eea8175145316-LICENSE | a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2 | crates.io: debugid-0.8.0/LICENSE |
| licenses/crates/a60eea8175145316-LICENSE-APACHE | a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2 | crates.io: addr2line-0.26.0/LICENSE-APACHE; also crates.io: ambient-authority-0.0.2/LICENSE-APACHE; also crates.io: arbitrary-1.4.2/LICENSE-APACHE; also crates.io: atomic-waker-1.1.2/LICENSE-APACHE; also crates.io: base64-0.22.1/LICENSE-APACHE; also crates.io: bitflags-2.11.1/LICENSE-APACHE; also crates.io: bumpalo-3.20.2/LICENSE-APACHE; also crates.io: cap-fs-ext-4.0.3/LICENSE-APACHE; also crates.io: cap-primitives-4.0.3/LICENSE-APACHE; also crates.io: cap-std-4.0.3/LICENSE-APACHE; also crates.io: cfg-if-1.0.0/LICENSE-APACHE; also crates.io: cpp_demangle-0.5.1/LICENSE-APACHE; also crates.io: crossbeam-deque-0.8.1/LICENSE-APACHE; also crates.io: crossbeam-epoch-0.9.20/LICENSE-APACHE; also crates.io: crossbeam-utils-0.8.20/LICENSE-APACHE; also crates.io: either-1.13.0/LICENSE-APACHE; also crates.io: env_logger-0.10.0/LICENSE-APACHE; also crates.io: equivalent-1.0.1/LICENSE-APACHE; also crates.io: fastrand-2.3.0/LICENSE-APACHE; also crates.io: fnv-1.0.7/LICENSE-APACHE; also crates.io: form_urlencoded-1.2.2/LICENSE-APACHE; also crates.io: fs-set-times-0.20.3/LICENSE-APACHE; also crates.io: gimli-0.32.3/LICENSE-APACHE; also crates.io: gimli-0.33.0/LICENSE-APACHE; also crates.io: hashbrown-0.16.1/LICENSE-APACHE; also crates.io: hashbrown-0.17.0/LICENSE-APACHE; also crates.io: heck-0.5.0/LICENSE-APACHE; also crates.io: httparse-1.10.1/LICENSE-APACHE; also crates.io: id-arena-2.3.0/LICENSE-APACHE; also crates.io: idna-1.1.0/LICENSE-APACHE; also crates.io: idna_adapter-1.2.0/LICENSE-APACHE; also crates.io: indexmap-2.14.0/LICENSE-APACHE; also crates.io: io-extras-0.19.0/LICENSE-APACHE; also crates.io: io-lifetimes-2.0.3/LICENSE-APACHE; also crates.io: io-lifetimes-3.0.1/LICENSE-APACHE; also crates.io: itertools-0.14.0/LICENSE-APACHE; also crates.io: json-from-wast-0.254.0/LICENSE-APACHE; also crates.io: lazy_static-1.4.0/LICENSE-APACHE; also crates.io: leb128-0.2.5/LICENSE-APACHE; also crates.io: leb128fmt-0.1.0/LICENSE-APACHE; also crates.io: linux-raw-sys-0.12.1/LICENSE-APACHE; also crates.io: log-0.4.28/LICENSE-APACHE; also crates.io: object-0.39.0/LICENSE-APACHE; also crates.io: once_cell-1.19.0/LICENSE-APACHE; also crates.io: percent-encoding-2.3.2/LICENSE-APACHE; also crates.io: postcard-1.1.3/LICENSE-APACHE; also crates.io: rayon-1.5.3/LICENSE-APACHE; also crates.io: rayon-core-1.12.0/LICENSE-APACHE; also crates.io: regex-1.9.1/LICENSE-APACHE; also crates.io: regex-automata-0.3.3/LICENSE-APACHE; also crates.io: regex-automata-0.4.11/LICENSE-APACHE; also crates.io: regex-syntax-0.7.4/LICENSE-APACHE; also crates.io: regex-syntax-0.8.5/LICENSE-APACHE; also crates.io: rustc-demangle-0.1.24/LICENSE-APACHE; also crates.io: rustix-1.1.4/LICENSE-APACHE; also crates.io: rustix-linux-procfs-0.1.1/LICENSE-APACHE; also crates.io: rustls-0.23.37/LICENSE-APACHE; also crates.io: signal-hook-registry-1.4.1/LICENSE-APACHE; also crates.io: smallvec-1.15.1/LICENSE-APACHE; also crates.io: socket2-0.6.3/LICENSE-APACHE; also crates.io: stable_deref_trait-1.2.0/LICENSE-APACHE; also crates.io: tempfile-3.27.0/LICENSE-APACHE; also crates.io: thread_local-1.1.4/LICENSE-APACHE; also crates.io: unicode-width-0.2.0/LICENSE-APACHE; also crates.io: url-2.5.7/LICENSE-APACHE; also crates.io: uuid-1.0.0/LICENSE-APACHE; also crates.io: wasm-encoder-0.254.0/LICENSE-APACHE; also crates.io: wasm-metadata-0.254.0/LICENSE-APACHE; also crates.io: wasm-wave-0.254.0/LICENSE-APACHE; also crates.io: wasmparser-0.254.0/LICENSE-APACHE; also crates.io: wasmprinter-0.254.0/LICENSE-APACHE; also crates.io: wast-254.0.0/LICENSE-APACHE; also crates.io: wat-1.254.0/LICENSE-APACHE; also crates.io: wit-component-0.254.0/LICENSE-APACHE; also crates.io: wit-parser-0.254.0/LICENSE-APACHE |
| licenses/crates/a65f5d0a945d2677-LICENSE | a65f5d0a945d267751344c95665945b90c030ea107faf5c85d518929886187da | crates.io: want-0.3.0/LICENSE |
| licenses/crates/a6c48161a09acc75-LICENSE | a6c48161a09acc75a0e25503bab66a731eb5fba5392ed4bb4743e4ba5085327a | crates.io: file-per-thread-logger-0.2.0/LICENSE |
| licenses/crates/a77b7cfeaf911ed4-LICENSE | a77b7cfeaf911ed410ffbe76f0cb2b24ad8a4d94e7ead5727e914425c416cc63 | crates.io: zstd-safe-7.0.0/LICENSE; also crates.io: zstd-sys-2.0.9+zstd.1.5.5/LICENSE |
| licenses/crates/a825bd853ab71619-LICENSE-MIT | a825bd853ab71619a4923d7b4311221427848070ff44d990da39b0b274c1683f | crates.io: typenum-1.15.0/LICENSE-MIT |
| licenses/crates/a8799c2a07dabcb8-COPYRIGHT | a8799c2a07dabcb8d52481f885c5ab7000acb8a4d3cd9503fbcb97c84d350e65 | crates.io: cap-primitives-4.0.3/COPYRIGHT |
| licenses/crates/a9040321c3712d8f-LICENSE-APACHE | a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5 | crates.io: block-buffer-0.10.2/LICENSE-APACHE; also crates.io: chacha20-0.10.0/LICENSE-APACHE; also crates.io: cpufeatures-0.2.7/LICENSE-APACHE; also crates.io: cpufeatures-0.3.0/LICENSE-APACHE; also crates.io: crypto-common-0.1.6/LICENSE-APACHE; also crates.io: digest-0.10.7/LICENSE-APACHE; also crates.io: sha2-0.10.2/LICENSE-APACHE |
| licenses/crates/aaff376532ea30a0-LICENSE-APACHE | aaff376532ea30a0cd5330b9502ad4a4c8bf769c539c87ffe78819d188a18ebf | crates.io: getrandom-0.2.15/LICENSE-APACHE; also crates.io: getrandom-0.4.2/LICENSE-APACHE |
| licenses/crates/ae9baa7beea91027-LICENSE-MIT | ae9baa7beea910273c2f384c2a6b721fb7bd02bda3436074a1072e4ee689f985 | crates.io: cpufeatures-0.3.0/LICENSE-MIT |
| licenses/crates/aecc100d0547aa3b-LICENSE-APACHE | aecc100d0547aa3bcbe04bcf5cb87c7db0be11004602adfa5056edf8bb847b35 | crates.io: maybe-owned-0.3.4/LICENSE-APACHE |
| licenses/crates/b1181a40b2a7b25c-LICENSE | b1181a40b2a7b25cf66fd01481713bc1005df082c53ef73e851e55071b102744 | crates.io: foldhash-0.2.0/LICENSE |
| licenses/crates/b21623012e6c453d-LICENSE | b21623012e6c453d944b0342c515b631cfcbf30704c2621b291526b69c10724d | crates.io: h2-0.4.13/LICENSE |
| licenses/crates/b29f8b01452350c2-LICENSE | b29f8b01452350c20dd1af16ef83b598fea3053578ccc1c7a0ef40e57be2620f | crates.io: libloading-0.8.6/LICENSE |
| licenses/crates/b38f11f6096706e6-LICENSE-MIT | b38f11f6096706e6de553dabe2a7ed142d59b6fa8c97e290c67496154745cdd5 | crates.io: idna-1.1.0/LICENSE-MIT; also crates.io: percent-encoding-2.3.2/LICENSE-MIT; also crates.io: url-2.5.7/LICENSE-MIT |
| licenses/crates/b3d734001a94efff-LICENSE | b3d734001a94efff3579978d953391aa7115f877657d25eb54037a43875d078a | crates.io: ring-0.17.14/LICENSE |
| licenses/crates/b4b2c0de2a05de33-COPYRIGHT | b4b2c0de2a05de3372d5c828128413ce82bb7dba2272487b7729f09cc3d3519d | crates.io: uuid-1.0.0/COPYRIGHT |
| licenses/crates/b4eb00df6e2a4d22-LICENSE-MIT | b4eb00df6e2a4d22518fcaa6a2b4646f249b3a3c9814509b22bd2091f1392ff1 | crates.io: sha2-0.10.2/LICENSE-MIT |
| licenses/crates/b843fb7430efdf97-LICENSE | b843fb7430efdf9732c834b6814beda44fccf3f0ddf7c9e030b39da17f6b159c | crates.io: http-body-util-0.1.3/LICENSE |
| licenses/crates/b84efe109a420fa3-COPYRIGHT | b84efe109a420fa3ca98be33f4227327af7ffa426195812c270feb1268bc2426 | crates.io: utf16_iter-1.0.5/COPYRIGHT |
| licenses/crates/b8c6939380a400f5-LICENSE-MIT | b8c6939380a400f53e11923d50fcc4dd2fa1ba8339fd9d04cda38a0251b6c9b0 | crates.io: chacha20-0.10.0/LICENSE-MIT |
| licenses/crates/bab426a663ce3d5b-LICENSE-MIT-atty | bab426a663ce3d5bbbcea9cdc300da74e94d76c3c79e46699a953f967a08e533 | crates.io: is-terminal-0.4.17/LICENSE-MIT-atty |
| licenses/crates/bc8dcbbd559a61b8-LICENSE-MIT | bc8dcbbd559a61b8a8c0c89d5c3e15d0dc47c6fae94e78ac428d6a7b7da3c4f9 | crates.io: terminal_size-0.4.4/LICENSE-MIT |
| licenses/crates/c09aae9d3c77b531-LICENSE | c09aae9d3c77b531f56351a9947bc7446511d6b025b3255312d3e3442a9a7583 | crates.io: generic-array-0.14.5/LICENSE |
| licenses/crates/c30152c94a6d75e0-COPYRIGHT | c30152c94a6d75e021adbc52b3a52470366a46edb917e17deae3259251af244c | crates.io: utf8_iter-1.0.4/COPYRIGHT |
| licenses/crates/c6596eb7be8581c1-LICENSE-APACHE | c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08 | crates.io: anstream-0.6.21/LICENSE-APACHE; also crates.io: anstyle-1.0.13/LICENSE-APACHE; also crates.io: anstyle-parse-0.2.7/LICENSE-APACHE; also crates.io: anstyle-query-1.1.5/LICENSE-APACHE; also crates.io: clap-4.5.48/LICENSE-APACHE; also crates.io: clap_builder-4.5.48/LICENSE-APACHE; also crates.io: clap_complete-4.5.58/LICENSE-APACHE; also crates.io: clap_lex-0.7.5/LICENSE-APACHE; also crates.io: cobs-0.3.0/LICENSE-APACHE; also crates.io: colorchoice-1.0.4/LICENSE-APACHE; also crates.io: crc32fast-1.3.2/LICENSE-APACHE; also crates.io: fallible-iterator-0.3.0/LICENSE-APACHE; also crates.io: humantime-2.1.0/LICENSE-APACHE; also crates.io: is_terminal_polyfill-1.70.1/LICENSE-APACHE; also crates.io: serde_spanned-1.0.3/LICENSE-APACHE; also crates.io: terminal_size-0.4.4/LICENSE-APACHE; also crates.io: toml-0.9.8/LICENSE-APACHE; also crates.io: toml_datetime-0.7.3/LICENSE-APACHE; also crates.io: toml_parser-1.0.4/LICENSE-APACHE; also crates.io: toml_writer-1.0.4/LICENSE-APACHE |
| licenses/crates/c71d239df91726fc-LICENSE-APACHE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | crates.io: memfd-0.6.5/LICENSE-APACHE; also crates.io: ryu-1.0.9/LICENSE-APACHE |
| licenses/crates/c9a75f18b9ab2927-LICENSE-MIT | c9a75f18b9ab2927829a208fc6aa2cf4e63b8420887ba29cdb265d6619ae82d5 | crates.io: thread_local-1.1.4/LICENSE-MIT |
| licenses/crates/c9bff75738922193-LICENSE-BOOST | c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566 | crates.io: ryu-1.0.9/LICENSE-BOOST |
| licenses/crates/cb5aedb296c5246d-LICENSE-MIT | cb5aedb296c5246d1f22e9099f925a65146f9f0d6b4eebba97fd27a6cdbbab2d | crates.io: winnow-0.7.13/LICENSE-MIT |
| licenses/crates/cbe0f9505c5ca02e-GPL-2.0-only.txt | cbe0f9505c5ca02ee34bfca453df31a98e31e6d56afcdf8ab0f87f4c94f1181b | crates.io: ittapi-sys-0.4.0/LICENSES/GPL-2.0-only.txt; also crates.io: ittapi-sys-0.4.0/c-library/LICENSES/GPL-2.0-only.txt |
| licenses/crates/cc117d90b498b32b-LICENSE-APACHE | cc117d90b498b32b11a886f279b359da16a73c3b01efbb2f5cc004b20262334e | crates.io: tokio-rustls-0.26.4/LICENSE-APACHE |
| licenses/crates/cddabf8adc6ccd6c-LICENSE | cddabf8adc6ccd6c3e68f5d71eac9fae3094116623cf23a46af0a5fd6b8ee813 | crates.io: http-body-1.0.1/LICENSE |
| licenses/crates/cf48cdd9ed87c203-BSD-3-Clause.txt | cf48cdd9ed87c2031b68fb1b9f4cfb55d00dcf815b21a30bf8304aa1e5e6f76a | crates.io: ittapi-sys-0.4.0/LICENSES/BSD-3-Clause.txt; also crates.io: ittapi-sys-0.4.0/LICENSES/BSD-3-Clause.txt; also crates.io: ittapi-sys-0.4.0/c-library/LICENSES/BSD-3-Clause.txt |
| licenses/crates/cfc7749b96f63bd3-LICENSE-APACHE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | crates.io: encoding_rs-0.8.31/LICENSE-APACHE; also crates.io: static_assertions-1.1.0/LICENSE-APACHE; also crates.io: utf16_iter-1.0.5/LICENSE-APACHE; also crates.io: utf8_iter-1.0.4/LICENSE-APACHE; also crates.io: write16-1.0.0/LICENSE-APACHE; also crates.io: zeroize-1.8.2/LICENSE-APACHE |
| licenses/crates/d00d6d48df2db6f9-COPYRIGHT | d00d6d48df2db6f91e4ca9c656e5e30782d5becf52bb3e5bfd0aff467bd37781 | crates.io: ambient-authority-0.0.2/COPYRIGHT |
| licenses/crates/d3174ad63e721d4c-LICENSE-APACHE | d3174ad63e721d4c9dccb8ad4320848992d314369bc46319720b5802c9153fe9 | crates.io: directories-next-2.0.0/LICENSE-APACHE; also crates.io: dirs-sys-next-0.1.2/LICENSE-APACHE |
| licenses/crates/d415a86ccfd79412-COPYRIGHT | d415a86ccfd794129666247cbbadebee7a6d0ac3ff701c76c07b0f9424f0307d | crates.io: rustix-linux-procfs-0.1.1/COPYRIGHT |
| licenses/crates/d5c22aa3118d240e-LICENSE-MIT | d5c22aa3118d240e877ad41c5d9fa232f9c77d757d4aac0c2f943afc0a95e0ef | crates.io: block-buffer-0.10.2/LICENSE-MIT |
| licenses/crates/db11fec9946737df-LICENSE | db11fec9946737df39ca3898d9cd8c10ec6f6c3a884a6802b0ad0b81b4e8f23a | crates.io: typenum-1.15.0/LICENSE |
| licenses/crates/dc91f8200e4b2a1f-LICENSE-MIT | dc91f8200e4b2a1f9261035d4c18c33c246911a6c0f7b543d75347e61b249cff | crates.io: http-1.3.1/LICENSE-MIT |
| licenses/crates/dfdca2d7fdbabfd9-LICENSE_LLVM.TXT | dfdca2d7fdbabfd937f9dc41b7f61647b0e6cb1f9ee767ecb4520f979ebe91da | crates.io: capstone-sys-0.18.0/capstone/LICENSE_LLVM.TXT |
| licenses/crates/e0cfa1006a645206-LICENSE-MIT | e0cfa1006a64520633de6bfbf563f5b1bea04ef0c5b73f049681931fa297dda3 | crates.io: cobs-0.3.0/LICENSE-MIT |
| licenses/crates/e196ffeb5ab101e9-COPYRIGHT | e196ffeb5ab101e9ec8bbe395c9f367c5380ee2d28c47e5c03371523798a9af7 | crates.io: fs-set-times-0.20.3/COPYRIGHT |
| licenses/crates/e20fa2b8e0a2565f-LICENSE-MIT | e20fa2b8e0a2565f24a792b94b4bf4b6c2b9d36f781d8a9516e218a036e6677a | crates.io: tokio-rustls-0.26.4/LICENSE-MIT |
| licenses/crates/e271993808fec50a-LICENSE | e271993808fec50ab29350b39539cdec611a9103f827e0aa26d61da70e2d33f8 | crates.io: webpki-roots-1.0.7/LICENSE |
| licenses/crates/e4c9b06fa850cb9b-LICENSE-MIT | e4c9b06fa850cb9b540a5e400e9f6394cf15efcf4098144de477d1d3dae10150 | crates.io: utf8parse-0.2.2/LICENSE-MIT |
| licenses/crates/e5d8f26c5b92d382-LICENSE-MIT | e5d8f26c5b92d382e7ab2826500e5099a40a7751e92a55bc51c6770933411f9e | crates.io: memfd-0.6.5/LICENSE-MIT |
| licenses/crates/e99d88d232bf57d7-LICENSE-MIT | e99d88d232bf57d70f0fb87f6b496d44b6653f99f8a63d250a54c61ea4bcde40 | crates.io: addr2line-0.26.0/LICENSE-MIT |
| licenses/crates/ea084a2373ebc1f0-LICENSE-MIT | ea084a2373ebc1f0902c09266e7bf25a05ab3814c1805bb017ffa7308f90c061 | crates.io: static_assertions-1.1.0/LICENSE-MIT |
| licenses/crates/eafbfa606bc005ed-LICENSE | eafbfa606bc005ed7fd2f623d65af17ffe4ef7c017221ac14405bf4140771ea9 | crates.io: sharded-slab-0.1.4/LICENSE |
| licenses/crates/ecc269ef87fd38a1-LICENSE-MIT | ecc269ef87fd38a1d98e30bfac9ba964a9dbd9315c3770fed98d4d7cb5882055 | crates.io: indexmap-2.14.0/LICENSE-MIT |
| licenses/crates/ef2b3bbd7b718a78-LICENSE-MIT | ef2b3bbd7b718a7881253226313f103e89b379e1279681a3c1ebcb65a27d209d | crates.io: maybe-owned-0.3.4/LICENSE-MIT |
| licenses/crates/f025ccfb7dfb6bdf-LICENSE-other-bits | f025ccfb7dfb6bdfedc75ca0f67acc69e6fb4998143d834f7c2f38a29989680f | crates.io: ring-0.17.14/LICENSE-other-bits |
| licenses/crates/f0c1d22de8bd3b77-COPYRIGHT | f0c1d22de8bd3b776a40f2691f08b84e91c7bafc78b72a51150e231002b88db3 | crates.io: io-extras-0.19.0/COPYRIGHT |
| licenses/crates/f30735c114075349-LICENSE-APACHE | f30735c11407534952947e1c7b7457ddf28847000bb038402495ad66f3d020a4 | crates.io: logos-0.14.2/LICENSE-APACHE; also crates.io: logos-codegen-0.14.2/LICENSE-APACHE |
| licenses/crates/f367c1b8e1aa2624-LICENSE | f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2 | crates.io: icu_collections-1.5.0/LICENSE; also crates.io: icu_locid-1.5.0/LICENSE; also crates.io: icu_locid_transform-1.5.0/LICENSE; also crates.io: icu_locid_transform_data-1.5.0/LICENSE; also crates.io: icu_normalizer-1.5.0/LICENSE; also crates.io: icu_normalizer_data-1.5.0/LICENSE; also crates.io: icu_properties-1.5.1/LICENSE; also crates.io: icu_properties_data-1.5.0/LICENSE; also crates.io: icu_provider-1.5.0/LICENSE; also crates.io: litemap-0.7.4/LICENSE; also crates.io: tinystr-0.7.6/LICENSE; also crates.io: writeable-0.5.5/LICENSE; also crates.io: yoke-0.7.5/LICENSE; also crates.io: zerofrom-0.1.5/LICENSE; also crates.io: zerovec-0.10.4/LICENSE |
| licenses/crates/f6deca8261a8f4a3-LICENSE-MIT | f6deca8261a8f4a3403dc74c725c46051157fd36c27cd4b100277eb1f303ad11 | crates.io: humantime-2.1.0/LICENSE-MIT |
| licenses/crates/f7db81051789b729-LICENSE-UNICODE | f7db81051789b729fea528a63ec4c938fdcb93d9d61d97dc8cc2e9df6d47f2a1 | crates.io: unicode-ident-1.0.24/LICENSE-UNICODE |
| licenses/crates/f9c375a1be4a41f7-COPYING | f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505 | crates.io: zstd-sys-2.0.9+zstd.1.5.5/zstd/COPYING |
| licenses/crates/fe99bc314b267213-LICENSE-APACHE | fe99bc314b2672132fe8b986fdcdf5a4ffb29edfdf6bf79ec88ccc6cbe092b13 | crates.io: beef-0.5.2/LICENSE-APACHE |
| licenses/crates/ff8f68cb076caf8c-LICENSE-MIT | ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2 | crates.io: hashbrown-0.16.1/LICENSE-MIT; also crates.io: hashbrown-0.17.0/LICENSE-MIT |
| licenses/edk2/License.txt | 50ce20c9cfdb0e19ee34fe0a51fc0afe961f743697b068359ab2f862b494df80 | edk2 2970e569: License.txt |
| licenses/gcc/COPYING.RUNTIME | 9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74 | corresponding-source: gcc-d564253eb6c8.tar.xz: gcc-d564253eb6c8/COPYING.RUNTIME |
| licenses/gcc/COPYING3 | 8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903 | corresponding-source: gcc-d564253eb6c8.tar.xz: gcc-d564253eb6c8/COPYING3 |
| licenses/glibc/COPYING.LIB | 20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95 | corresponding-source: glibc-16be1518495f.tar.xz: glibc-16be1518495f/COPYING.LIB |
| licenses/glibc/COPYINGv2 | edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6 | corresponding-source: glibc-16be1518495f.tar.xz: glibc-16be1518495f/COPYINGv2 |
| licenses/glibc/LICENSES | b22a69aa3f80a5201818c66cb0df0f25f9fa13cf5861b0093a058dbd12d50dce | corresponding-source: glibc-16be1518495f.tar.xz: glibc-16be1518495f/LICENSES |
| licenses/go/LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | corresponding-source: go1.27.0.src.tar.gz: go/LICENSE |
| licenses/go/PATENTS | 96f408bfae65bf137fc2525d3ecb030271c50c1e90799f87abf8846d8dd505cc | corresponding-source: go1.27.0.src.tar.gz: go/PATENTS |
| licenses/grub/COPYING | 8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903 | corresponding-source: grub-2.14.tar.xz: grub-2.14/COPYING |
| licenses/linux/COPYING | fb5a425bd3b3cd6071a3a9aff9909a859e7c1158d54d32e07658398cd67eb6a0 | corresponding-source: linux-7.2.3.tar.xz: linux-7.2.3/COPYING |
| licenses/linux/LICENSES/exceptions/Linux-syscall-note | 8e378ab93586eb55135d3bc119cce787f7324f48394777d00c34fa3d0be3303f | corresponding-source: linux-7.2.3.tar.xz: linux-7.2.3/LICENSES/exceptions/Linux-syscall-note |
| licenses/linux/LICENSES/preferred/GPL-2.0 | 8780e78a1a737e127f25a65f6d95269bffd36158dc261114de7859b490bfc5aa | corresponding-source: linux-7.2.3.tar.xz: linux-7.2.3/LICENSES/preferred/GPL-2.0 |
| licenses/lzma-sdk/LZMA-SDK-README.txt | 4f872a23afb2c30182182d639bcef958f7cdee84c86689645e4279c13423bdaf | edk2 2970e569: MdeModulePkg/Library/LzmaCustomDecompressLib/LZMA-SDK-README.txt |
| licenses/openssl/LICENSE.txt | 7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a | edk2 2970e569: CryptoPkg/Library/OpensslLib/openssl/LICENSE.txt |
| licenses/rust/COPYRIGHT | 172020dbfd5b53a226dfde77616190a48dcff519b0bc0e6deb91a8450782c4af | corresponding-source: rust-1.98.0-COPYRIGHT |
| licenses/rust/LICENSE-APACHE | 62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a | corresponding-source: rust-1.98.0-LICENSE-APACHE |
| licenses/rust/LICENSE-MIT | b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1 | corresponding-source: rust-1.98.0-LICENSE-MIT |
| licenses/wasmtime/LICENSE | 268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5 | wasmtime v48.0.1: LICENSE |
