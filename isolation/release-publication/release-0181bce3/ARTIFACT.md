# The publication artifact of release 0181bce3 (for review; not published)

| | |
|---|---|
| release id | 5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2 (sha256 of release.json) |
| build commit | 0181bce3aac5fa03dfaf2928d834ecd04d2a4a73 |
| tarball | enclave-domain-release-5c3561f91bc7.tar.xz, 31.9 MB (kept outside git, beside its .sha256) |
| tarball sha256 | efb2d33c93ede4388457cefdbc02ab45e98b168607e3f388a4717b641f862812 |
| contents | release/ (the 16 release files), PUBLICATION-MANIFEST.json, THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (181 texts) |

## Checked (2026-09-25, on warden-host, in ~/enclave-bench/pub-0181bce3; nothing under ~/enclave-prod written)
- **Rebuilt from a clean worktree at the commit, byte-identical to the deployed release:** all 16 files, the same tree,
  the same modes, and the manifest id verified.
- **The firmware inside it was rebuilt from pinned source** (`rebuild-firmware.sh`, from scratch):
  sha256 142589cc…, byte-identical.
- **template/init and template/front were recompiled, byte-identical.** front was rebuilt with an empty Go build
  cache.
- **The kernel, the modules, wasmtime and the rt libraries are Arch Linux's binaries,** copied from the installed
  packages. INVENTORY.md names each package and how that was established.
- **The tarball is deterministic.** Two independent runs of `make-artifact.sh` produced the same sha256.

## Rebuild
From a checkout of this branch:
```
sh isolation/release-publication/rebuild-firmware.sh <fw workdir, path <= 45 chars> \
   142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 isolation/release-publication/release-0181bce3/firmware-inputs
sh isolation/release-publication/fetch-corresponding-source.sh <sources dir>
sh isolation/release-publication/make-artifact.sh 0181bce3 <outdir> --expect <deployed release dir> \
   --firmware <fw workdir>/OVMF.amdsev.fd --firmware-versions <fw workdir>/versions.txt \
   --notices isolation/release-publication/release-0181bce3
```
The notices are regenerated with:

```
python3 isolation/release-publication/collect-notices.py isolation/release-publication/release-0181bce3 --sources <sources dir> \
   --edk2 <fw workdir>/src/edk2__ --wasmtime-src <wasmtime v48.0.1 checkout> \
   --crates isolation/release-publication/release-0181bce3/wasmtime-crates.tsv --cargo-home <dir>
```
The crate list (wasmtime-crates.tsv) comes from `cargo tree` on the wasmtime tag; the crate sources come from crates.io.

The host's toolchain must be the one PUBLICATION-MANIFEST.json records, the Arch packages it names. A different gcc,
Go or GRUB gives different bytes, and the comparison then fails by design.
