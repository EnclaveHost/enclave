# The publication artifact of release aa6c985c, the production release (for review; not published)

| | |
|---|---|
| release id | 79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4 (sha256 of release.json) |
| build commit | aa6c985c688e73ffc2ec547b691c2d804e50ad69 (approved, and reproduced from scratch, by d1 and e3) |
| release tarball | enclave-domain-release-79c5ecf24eb4.tar.xz, sha256 **c3b7f47d111aecf9f2de6b4956682665663f3badfe5040969449197a1be59c96** |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json (with the musl build record), THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (188 texts) |
| corresponding source, distributed alongside it | enclave-guest-corresponding-source-11b366ea5a41.tar, sha256 **21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da** (29 files; shared with 5c3561f9 and a4f22748) |
| draft release manifest | [DRAFT-RELEASE.md](DRAFT-RELEASE.md): no release was created |

## Checked (2026-09-25; read-only on enclave-5d's artifact; nothing deployed was written)
- **`check-third-party.py` against 5c3561f9 prints SAME.** Only Enclave's own init and front differ.
- **The init's link, derived here:** musl only, plus GCC's crtbeginS.o and crtendS.o. There is no glibc, no
  interpreter, and no dynamic section.
- **The rebuild:** from a clean worktree at aa6c985c, against a musl prefix built by that commit's build-musl.sh
  (libc.a 4f72e098…, signature checked). It is byte-identical to 5d's approved artifact: all 16 files, the tree and
  the modes, and the id verified.
- **3ddacdf4,** which hardens build-musl.sh, builds the same release bytes as well. Its tarball differs only in the
  commit its manifest records.
- **The firmware inside it is the one rebuilt from pinned source (142589cc):** rebuilt from scratch, with TZ=UTC0.
- **The tarball and the bundle are both deterministic:** two runs each, the same sha256.
- **Scanned:** the tarball's documents and manifest name no build host, home path or reviewer. The manifest's host
  inputs are standard system paths only. Two matches are in files shipped verbatim, and are correct as they are:
  - "Steven G. Kargl" is a copyright holder in the libm crate's license;
  - source/isolation/m2/dominit.c names "(Codex, 2026-09-25)" in a comment. It is Enclave's own source, and it must be
    the exact source.

## Rebuild
As in [../release-0181bce3/ARTIFACT.md](../release-0181bce3/ARTIFACT.md), with three differences:
- musl first: `sh isolation/m2/build-musl.sh <prefix>`, from the commit;
- `MUSL_PREFIX=<prefix> make-artifact.sh aa6c985c … --notices isolation/release-publication/release-aa6c985c`;
- the notices from `collect-notices.py … --init musl --title "domain release aa6c985c (release id 79c5ecf24eb48a70...,
  the production release)" --extra-md isolation/release-publication/production/front-embedded-data.md`.

## Reviews before anything is published
e3, 5d and 63 review this artifact and DRAFT-RELEASE.md. Until then, nothing is created or published.
- **enclave-63: OK on the binary and artifact side** (839a7f9d):
  - the tarball's sha256 matches, its release.json is 79c5ecf2, and all 15 files verify;
  - the release is identical to the one installed;
  - the bundle's sha256 matches, and it holds musl with its .asc, glibc and gcc;
  - no GitHub release or domain-release tag exists.
  63 did not assess the notices' content.
- **enclave-e3: APPROVED** release-aa6c985c/ and DRAFT-RELEASE.md (839a7f9d). All of its findings are fixed, each
  verified independently:
  - the hashes;
  - the release, and dominit.c;
  - the notices' texts: musl's and Rust 1.98.1's are byte-identical to their tarballs';
  - the bundle's SHA256SUMS, in C order;
  - unifont's b2sum, against the PKGBUILD in the bundle;
  - the GRUB reverts patch, against upstream's commits;
  - the kernel's CONFIG_RUST and rustc 1.98.1, against the release's own IKCONFIG;
  - musl's signature;
  - the section 6(d) text and the scope, against its own link-map derivation.
  e3's one note, on this file's scan claim, is corrected above.
- **enclave-5d: APPROVED** (839a7f9d), having checked the artifacts themselves:
  - the tarball is c3b7f47d…, its release/ is identical (`diff -r`) to 5d's artifact, and dominit.c equals
    aa6c985c's;
  - licenses/musl/COPYRIGHT and the notices' musl section are present;
  - the bundle is 21752b26…, and its musl-1.2.6.tar.gz is the pinned d585fd3b…, with its .asc;
  - there are no lab strings, keys or host details.
  5d did not re-derive the crate texts or the section 6(d) text.
- **All three reviews are done.** Publication is Codex's and Steven's decision, and the release step itself is outside
  this lane. Nothing has been created or published.
