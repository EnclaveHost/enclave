# The publication artifact of release 0181bce3 (publication HELD; not published)

**HELD:** this release's init links glibc statically, and the LGPL-2.1 section 6 point stays open for it (INVENTORY.md).
The decision: the LICENSE is unchanged, and releases from aa6c985c on link init against musl; see ../release-aa6c985c/.
This package is kept current, but it is not to be published while the point is open.

| | |
|---|---|
| release id | 5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2 (sha256 of release.json) |
| build commit | 0181bce3aac5fa03dfaf2928d834ecd04d2a4a73 |
| release tarball | enclave-domain-release-5c3561f91bc7.tar.xz, sha256 **f47487bb81442da6679e7ef2008fff8a396a2086855383206249590aa4359a2c** |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json, THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (187 texts) |
| corresponding source, distributed alongside it | enclave-guest-corresponding-source-11b366ea5a41.tar, sha256 **21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da** (29 files; shared with a4f22748 and 79c5ecf2) |

Both are kept outside git. Where they are hosted, together, is the publisher's decision.

## Checked (2026-09-25; nothing deployed was written)
- **Rebuilt from a clean worktree at the commit, byte-identical to the deployed release:** all 16 files, the same tree,
  the same modes, and the manifest id verified. The build uses a Go cache of its own, empty at the start, and the
  worktree is removed afterwards.
- **The firmware was rebuilt from pinned source, from scratch, byte-identical (142589cc).** Its only recorded build-time
  inputs are the GRUB memdisk's volume ID and time, and the edk2 path length. The EDK2 stack cookies are not an input,
  and a rebuild with fresh random ones matches.
- **The kernel, the modules, wasmtime and the rt libraries are Arch Linux's binaries.** INVENTORY.md names each package
  and how that was established.
- **Both tarballs are deterministic.** Independent runs gave the same sha256. No build date, host path or location is
  recorded in them.

## Reviews
**The first review (c53bd1ce), addressed at 31d0bb46:**
- the source now accompanies the binaries as one bundle;
- dominit.c is in the tarball;
- the GRUB image's build scripts are in the bundle;
- the LGPL-2.1 section 6 point is recorded;
- there is no build date in the manifest;
- the Rust standard library's notice is added;
- the cookie rationale is corrected;
- no host details are recorded;
- the recipe uses its own Go cache and removes its worktree.

**The second review (31d0bb46), addressed here:**
- **GRUB's unifont source (widthspec.h, in the normal module) is in the bundle.**
- **The two commits Arch reverts are in the bundle as one patch** (arch-grub-2.14-1-reverts.patch). A history-less tree
  cannot replay `git revert`, so the patch is checked to apply to the grub-2.14 tarball.
- **The kernel's Rust core** (CONFIG_RUST=y; rustc 1.98.1) has its library source (rust-src-1.98.1) in the bundle and
  its texts in the notices.
- **Recipe fixes:**
  - versions.txt records iasl again;
  - SHA256SUMS is sorted in the C locale;
  - TZ=UTC0 with the original's local time as the epoch (the same bytes, and no zone);
  - make-artifact.sh has a cleanup trap;
  - check-third-party.py states that it does not cover third-party code linked into init or front.
- **No reviewer handles or internal host names** in the shipped documents.
- **GPL-3.0 section 6(d)'s directions beside the binaries** are stated in SOURCES.md.
- **The decision on the LGPL-2.1 section 6 point:** the LICENSE is unchanged, and init links musl from aa6c985c on.
  This release's init still links glibc, so its publication stays HELD.

## Rebuild
From a checkout of this branch:
```
sh isolation/release-publication/rebuild-firmware.sh <fw workdir, path <= 45 chars> \
   142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 isolation/release-publication/release-0181bce3/firmware-inputs
sh isolation/release-publication/fetch-corresponding-source.sh <sources dir>
sh isolation/release-publication/make-source-bundle.sh <sources dir> <bundle dir> 5c3561f9… a4f22748… 79c5ecf2…
python3 isolation/release-publication/collect-notices.py isolation/release-publication/release-0181bce3 --sources <sources dir> \
   --edk2 <fw workdir>/src/edk2__ --wasmtime-src <wasmtime v48.0.1 checkout> \
   --crates isolation/release-publication/release-0181bce3/wasmtime-crates.tsv --cargo-home <dir>
sh isolation/release-publication/make-artifact.sh 0181bce3 <outdir> --expect <deployed release dir> \
   --firmware <fw workdir>/OVMF.amdsev.fd --firmware-versions <fw workdir>/versions.txt \
   --notices isolation/release-publication/release-0181bce3
```
The crate list (wasmtime-crates.tsv) comes from `cargo tree` on the wasmtime tag; the crate sources come from crates.io.

The host's toolchain must be the one PUBLICATION-MANIFEST.json records, the Arch packages it names. A different gcc,
Go or GRUB gives different bytes, and the comparison then fails by design.
