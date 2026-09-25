# DRAFT release manifest: domain release aa6c985c (NOT a release; nothing created or published)

**Status: DRAFT, for review by e3, 5d and 63.** No GitHub release, tag or upload exists, and none is to be created from
this file until that review is done and the publication is approved. The candidate location is this repository's
existing GitHub Releases, with no new hosting.

## What would be published, together

| asset | sha256 | bytes |
|---|---|---|
| enclave-domain-release-79c5ecf24eb4.tar.xz (the binaries, the notices and init's source) | c3b7f47d111aecf9f2de6b4956682665663f3badfe5040969449197a1be59c96 | 31995308 |
| enclave-guest-corresponding-source-11b366ea5a41.tar (the corresponding source) | 21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da | 328878080 |

- **The release:** id 79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4 (sha256 of release.json),
  built at image commit aa6c985c688e73ffc2ec547b691c2d804e50ad69.
- **The two assets go out together, in the same place.** The source bundle is not optional, and a link to upstream
  sources does not replace it.

## The notices, inside the release tarball (and in this directory)

| file | sha256 |
|---|---|
| THIRD-PARTY-NOTICES.md | 4cc3524bd35f0cba502dde1595786dcfe7f83e45d54f266e3905ea616c12101f |
| INVENTORY.md | c6519d209e42aae23df96588782a3bfbb186c266d3d5bc6ec3ea584343110f77 |
| SOURCES.md | fe18772125e7f2b98dbf98513eb65c8d0716f56a8513f106147ceecbc51b83c5 |
| licenses/ (188 texts; the sha256 of their sorted `sha256sum` list) | c4e18ee9fae0def9660a801c8c1eb25edfb240fa8d8e1d54cd94fecb462a0a07 |

## The text that goes next to the assets (GPL-3.0 section 6(d): directions beside the binaries)
Draft, for the release page and for every other channel that offers these binaries, kept up for as long as they are
offered:

> enclave-domain-release-79c5ecf24eb4.tar.xz is an Enclave guest domain release (release id 79c5ecf2…). It contains
> third-party software under its own licenses: the Linux kernel and modules (GPL-2.0), GNU GRUB inside the firmware
> (GPL-3.0-or-later), the GNU C Library as a shared runtime (LGPL-2.1-or-later), the GCC runtime (GPL-3.0-or-later
> with the GCC Runtime Library Exception), musl libc (MIT), EDK II, OpenSSL, Wasmtime and its Rust crates, the Go and
> Rust standard libraries, and others. THIRD-PARTY-NOTICES.md and licenses/ inside the tarball carry their notices.
> The complete corresponding source of those components is enclave-guest-corresponding-source-11b366ea5a41.tar,
> published here beside it; SOURCES.md inside the tarball lists every file in it with its sha256.
> Enclave's own code in the release is under this repository's LICENSE.

## Scope, for the publication text
- **What changed from a4f22748:** only template/init changed, which now links musl 1.2.6 (MIT) statically instead of
  glibc. No glibc and no LGPL code is statically linked into init.
- **glibc stays as a shared runtime.** template/rt/ still ships glibc's shared runtime set, which wasmtime is
  dynamically linked with (ld-linux-x86-64.so.2, libc.so.6, libm.so.6), and libgcc_s.so.1. Their notices and their
  complete corresponding source are as in the earlier packages.
- **The GCC runtime objects linked into init** (crtbeginS.o, crtendS.o) are covered by the GCC runtime notice.
- **No legal claim is made either way** beyond these facts.

## Not in this publication
The earlier releases 5c3561f9 (0181bce3, the rollback) and a4f22748 (17e182a8) link glibc statically into init. Their
packages exist (../release-0181bce3/, ../release-17e182a8/), but their publication stays HELD: the open LGPL-2.1
section 6 point applies to them, and this release does not resolve it.
