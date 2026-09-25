# Publication artifacts for domain releases (prepared for review; NOTHING here publishes anything)

A domain release (isolation/m4/domain-release.sh) is what a trusted client recomputes guest measurements from:
- the verifying firmware;
- the guest kernel;
- the image template (init, front, runtime set, modules).

Publishing one means shipping third-party binaries. So a publication artifact is the release itself, plus four things:
- proof that it rebuilds;
- what is in it;
- the notices its components require;
- the corresponding source of its copyleft components.

Enclave's own code in it stays under the repository LICENSE, unchanged.

## The recipe (reusable for any release commit)
1. **Firmware** (only when a release's firmware is new): `rebuild-firmware.sh <workdir> <expected sha256>
   [<firmware-inputs dir>]`.
   - It rebuilds OVMF AmdSevX64 from pinned sources, and never writes to ~/.cache/enclave-isolation.
   - Without an inputs dir, it pins fresh build-time inputs and saves them. Commit them beside the release, so the
     firmware can be rebuilt exactly later.
2. **Corresponding source:** `fetch-corresponding-source.sh <dir>` downloads or archives the pinned sources outside
   git and writes SHA256SUMS. Its pins are this release's; a release with other kernel, libc or GRUB packages gets its
   own copy of the script.
3. **Inventory and notices:** `collect-notices.py <release notes dir> --sources <dir> --edk2 <tree> --wasmtime-src
   <checkout> --crates <crates.json> --cargo-home <dir>`. It copies every license text from the components' own sources
   into licenses/ and writes THIRD-PARTY-NOTICES.md. INVENTORY.md and SOURCES.md record how each component was
   established from the bytes.
4. **The artifact:** `make-artifact.sh <commit> <outdir> --expect <deployed release dir> --firmware <rebuilt fd>
   --firmware-versions <its versions.txt> --notices <release notes dir>`.
   - It builds the release from a clean worktree of <commit> with domain-release.sh, and verifies its manifest id.
   - It compares every file, the tree and the modes with the deployed release.
   - It packs one deterministic tarball: release/, PUBLICATION-MANIFEST.json and the notices.

Rules the scripts keep:
- no writes to ~/enclave-prod or the firmware cache;
- no guestd;
- nothing is uploaded anywhere.

## Releases
- [release-0181bce3/](release-0181bce3/): release id 5c3561f9…, the one deployed as ~/enclave-prod/release-0181bce3.
  [ARTIFACT.md](release-0181bce3/ARTIFACT.md) has the tarball, its hash and the exact rebuild commands.
