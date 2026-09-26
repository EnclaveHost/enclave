# DRAFT release manifest: domain release b63c2def (NOT a release; nothing created or published)

**Status: DRAFT, for review by e3, 5d, 63 and bf.** Publication of the releases before it (79c5ecf2 included) is HELD. No GitHub release, tag or upload exists, and none is to be created from
this file until that review is done and the publication is approved. The candidate location is this repository's
existing GitHub Releases, with no new hosting.

## What would be published, together

| asset | sha256 | bytes |
|---|---|---|
| enclave-domain-release-f7888d869084.tar.xz (the binaries, the notices and init's source) | c3bc9937d67f6d5275311ffbdf641bb2d6d32d4fc457433d409f883aa1ea0ae6 | 32011560 |
| enclave-guest-corresponding-source-11b366ea5a41.tar (the corresponding source) | 21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da | 328878080 |

- **The release:** id f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca (sha256 of release.json),
  built at image commit b63c2def6e9b12088c30594b8cb58c7273903a60.
- **The source bundle is 79c5ecf2's, unchanged** (SOURCES.md): the third-party bytes are 79c5ecf2's exactly. Its README
  names 5c3561f9, a4f22748 and 79c5ecf2. A re-made bundle naming f7888d86 too would be a different tar under the same
  name, so none is made; at most one of the two may ever be published.
- **The two assets go out together, in the same place.** The source bundle is not optional, and a link to upstream
  sources does not replace it.

## The notices, inside the release tarball (and in this directory)

| file | sha256 |
|---|---|
| THIRD-PARTY-NOTICES.md | 587709d4d317ed970f1c0760a2f017271f37bfc7582831fc91e86dabbdee2c43 |
| INVENTORY.md | 478a8fbb69198bc2dcb0a191bb76589e7d642db062503ebb3041faf30804c09b |
| SOURCES.md | 33b09c0b2d9f183d0f4c797d806c845039ab00628fba171a6055f69cbca1cea4 |
| licenses/ (188 texts; the sha256 of their sorted `sha256sum` list) | c4e18ee9fae0def9660a801c8c1eb25edfb240fa8d8e1d54cd94fecb462a0a07 |

## The text that goes next to the assets (GPL-3.0 section 6(d): directions beside the binaries)
Draft, for the release page and for every other channel that offers these binaries, kept up for as long as they are
offered:

> enclave-domain-release-f7888d869084.tar.xz is an Enclave guest domain release (release id f7888d86…). It contains
> third-party software under its own licenses: the Linux kernel and modules (GPL-2.0), GNU GRUB inside the firmware
> (GPL-3.0-or-later), the GNU C Library as a shared runtime (LGPL-2.1-or-later), the GCC runtime (GPL-3.0-or-later
> with the GCC Runtime Library Exception), musl libc (MIT), EDK II, OpenSSL, Wasmtime and its Rust crates, the Go and
> Rust standard libraries, and others. THIRD-PARTY-NOTICES.md and licenses/ inside the tarball carry their notices.
> The complete corresponding source of those components is enclave-guest-corresponding-source-11b366ea5a41.tar,
> published here beside it; SOURCES.md inside the tarball lists every file in it with its sha256.
> Enclave's own code in the release is under this repository's LICENSE.

## Scope, for the publication text
- **What changed from 52156652:** only Enclave's own template/front (not dumpable; refuses a traced thread) and
  template/init (the hardened dominit: the app unprivileged, NO_NEW_PRIVS, empty capabilities, Yama at 2, user
  namespaces off, io_uring off, all read back and failing closed). No third-party byte changed; the notices differ only
  in their title.
- **template/init links musl 1.2.6 (MIT) statically,** now 142 members of its libc.a, with GCC's crtbeginS.o and
  crtendS.o (GCC Runtime Library Exception); no libgcc or libatomic member. No glibc and no LGPL code is statically
  linked into init.
- **glibc stays as a shared runtime.** template/rt/ still ships glibc's shared runtime set, which wasmtime is
  dynamically linked with (ld-linux-x86-64.so.2, libc.so.6, libm.so.6), and libgcc_s.so.1. Their notices and their
  complete corresponding source are as in the earlier packages.
- **No legal claim is made either way** beyond these facts.

## Not in this publication
79c5ecf2's and 52156652's own publications (../release-aa6c985c/, ../release-4cdd5169/) are HELD as well; if more than
one were ever published they would share the one bundle. The earlier releases 5c3561f9 (0181bce3) and a4f22748 (17e182a8) link glibc statically into init. Their
packages exist (../release-0181bce3/, ../release-17e182a8/), but their publication stays HELD: the open LGPL-2.1
section 6 point applies to them, and this release does not resolve it.
