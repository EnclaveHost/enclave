# The publication artifact of release 0181bce3 (for review; not published)

| | |
|---|---|
| release id | 5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2 (sha256 of release.json) |
| build commit | 0181bce3aac5fa03dfaf2928d834ecd04d2a4a73 |
| release tarball | enclave-domain-release-5c3561f91bc7.tar.xz, sha256 **732ef19f94a75789c7b4baf68cd38d8fcd434bebda8a367efc2446f869aa52f9** |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json, THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (184 texts) |
| corresponding source, distributed alongside it | enclave-guest-corresponding-source-d3cfd855be41.tar, sha256 **7509205f84a1d9110dabad000e4a28f0a12532bf6df030b82661ca8bd70b2fec** (23 files; also covers release a4f22748) |

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

## After enclave-e3's review of c53bd1ce
1. **HIGH (the source must accompany the binaries):**
   - the corresponding source is now one bundle, to be distributed next to the tarball from the same place;
   - dominit.c is inside the tarball;
   - the GRUB image's build scripts are in the bundle.
2. **MEDIUM (LGPL-2.1 section 6's terms for the static init):** recorded as an OPEN finding in INVENTORY.md, with
   options. It is Steven's decision, and the LICENSE is unchanged.
3. **MEDIUM (the tarball depended on the build date):** nasm's "compiled on" date no longer reaches versions.txt.
4. **MEDIUM (the Rust standard library notice):** added, from rust-lang/rust at rustc 1.98.0's commit.
5. **LOW (the stack cookies):** the rationale is corrected, and the cookie files are removed. They reach no byte.
6. **LOW (host details):**
   - TZ is MST7, not a named zone;
   - the notices name each text's source, not build-host paths;
   - the shipped documents no longer name the host.
7. **LOW (the recipe):**
   - make-artifact.sh uses its own Go cache and removes its worktree;
   - fetch-corresponding-source.sh requires an empty directory.

## Rebuild
From a checkout of this branch:
```
sh isolation/release-publication/rebuild-firmware.sh <fw workdir, path <= 45 chars> \
   142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 isolation/release-publication/release-0181bce3/firmware-inputs
sh isolation/release-publication/fetch-corresponding-source.sh <sources dir>
sh isolation/release-publication/make-source-bundle.sh <sources dir> <bundle dir> 5c3561f9… a4f22748…
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
