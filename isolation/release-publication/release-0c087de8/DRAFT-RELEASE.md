# DRAFT release manifest: domain release 0c087de8 (NOT a release; nothing created or published)

**Status: DRAFT, for review by e3, 5d, 63 and bf.** Publication of the releases before it (79c5ecf2 included) is HELD. No GitHub release, tag or upload exists, and none is to be created from
this file until that review is done and the publication is approved. The candidate location is this repository's
existing GitHub Releases, with no new hosting.

## What would be published, together

| asset | sha256 | bytes |
|---|---|---|
| enclave-domain-release-5db18199ef0d.tar.xz (the binaries, the notices and init's source) | d2252757a565cbaa112d5f678d64078dbef08d345187c9eb6b30472a5cd9be47 | 32015636 |
| enclave-guest-corresponding-source-11b366ea5a41.tar (the corresponding source) | 21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da | 328878080 |

- **The release:** id 5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77 (sha256 of release.json),
  built at image commit 0c087de8213ddd6ac7b8ed7e472b02ad23672bd5 on branch isolation/wx-at-attest (not main).
- **The source bundle is 79c5ecf2's, unchanged** (SOURCES.md): the third-party bytes are 79c5ecf2's exactly. Its README
  names 5c3561f9, a4f22748 and 79c5ecf2. A re-made bundle naming 5db18199 too would be a different tar under the same
  name, so none is made; at most one of the two may ever be published.
- **The two assets go out together, in the same place.** The source bundle is not optional, and a link to upstream
  sources does not replace it.

## The notices, inside the release tarball (and in this directory)

| file | sha256 |
|---|---|
| THIRD-PARTY-NOTICES.md | e88e1c8c3547e80919efdd358cba4328dc60efa32ef274e0500de8873013ff1b |
| INVENTORY.md | 8aa949a2b5450820da85f66ab421f09bb21551b35a8a172e64851f5ae8a615c5 |
| SOURCES.md | 8d46586930c7f94839d5dedd1f1968d5551b400c7f2436f6e3cee84b2a9518e5 |
| licenses/ (188 texts; the sha256 of their sorted `sha256sum` list) | c4e18ee9fae0def9660a801c8c1eb25edfb240fa8d8e1d54cd94fecb462a0a07 |

## The text that goes next to the assets (GPL-3.0 section 6(d): directions beside the binaries)
Draft, for the release page and for every other channel that offers these binaries, kept up for as long as they are
offered:

> enclave-domain-release-5db18199ef0d.tar.xz is an Enclave guest domain release (release id 5db18199…). It contains
> third-party software under its own licenses: the Linux kernel and modules (GPL-2.0), GNU GRUB inside the firmware
> (GPL-3.0-or-later), the GNU C Library as a shared runtime (LGPL-2.1-or-later), the GCC runtime (GPL-3.0-or-later
> with the GCC Runtime Library Exception), musl libc (MIT), EDK II, OpenSSL, Wasmtime and its Rust crates, the Go and
> Rust standard libraries, and others. THIRD-PARTY-NOTICES.md and licenses/ inside the tarball carry their notices.
> The complete corresponding source of those components is enclave-guest-corresponding-source-11b366ea5a41.tar,
> published here beside it; SOURCES.md inside the tarball lists every file in it with its sha256.
> Enclave's own code in the release is under this repository's LICENSE.

## Scope, for the publication text
- **What changed from f7888d86:** only Enclave's own template/front (the runtime W^X self-test at each attestation)
  and template/init (the app runtime's seccomp filter). No third-party byte changed; the notices differ only in their
  title.
- **template/init links musl 1.2.6 (MIT) statically,** now 142 members of its libc.a, with GCC's crtbeginS.o and
  crtendS.o (GCC Runtime Library Exception); no libgcc or libatomic member. No glibc and no LGPL code is statically
  linked into init.
- **glibc stays as a shared runtime.** template/rt/ still ships glibc's shared runtime set, which wasmtime is
  dynamically linked with (ld-linux-x86-64.so.2, libc.so.6, libm.so.6), and libgcc_s.so.1. Their notices and their
  complete corresponding source are as in the earlier packages.
- **No legal claim is made either way** beyond these facts.

## Not in this publication
The publications of 79c5ecf2, 52156652 and f7888d86 (../release-aa6c985c/, ../release-4cdd5169/, ../release-b63c2def/)
are HELD as well; if more than one were ever published they would share the one bundle. The earlier releases 5c3561f9
(0181bce3) and a4f22748 (17e182a8) link glibc statically into init. Their packages exist (../release-0181bce3/,
../release-17e182a8/), but their publication stays HELD: the open LGPL-2.1 section 6 point applies to them, and this
release does not resolve it.
