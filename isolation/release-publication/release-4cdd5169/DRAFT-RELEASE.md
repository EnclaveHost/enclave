# DRAFT release manifest: domain release 4cdd5169 (NOT a release; nothing created or published)

**Status: DRAFT, for review by e3, 5d, 63 and bf.** Publication of the releases before it (79c5ecf2 included) is HELD. No GitHub release, tag or upload exists, and none is to be created from
this file until that review is done and the publication is approved. The candidate location is this repository's
existing GitHub Releases, with no new hosting.

## What would be published, together

| asset | sha256 | bytes |
|---|---|---|
| enclave-domain-release-52156652d67a.tar.xz (the binaries, the notices and init's source) | b5315ff0b20ff839566f40ac1f072ce34a4d5e28282f8aad749a960f82d86bf2 | 31997212 |
| enclave-guest-corresponding-source-11b366ea5a41.tar (the corresponding source) | 21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da | 328878080 |

- **The release:** id 52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1 (sha256 of release.json),
  built at image commit 4cdd516924981eeacefc8ccaefb4e7fc0e1ec939.
- **The source bundle is 79c5ecf2's, unchanged** (SOURCES.md): the third-party bytes are 79c5ecf2's exactly. Its README
  names 5c3561f9, a4f22748 and 79c5ecf2. A re-made bundle naming 52156652 too would be a different tar under the same
  name, so none is made; at most one of the two may ever be published.
- **The two assets go out together, in the same place.** The source bundle is not optional, and a link to upstream
  sources does not replace it.

## The notices, inside the release tarball (and in this directory)

| file | sha256 |
|---|---|
| THIRD-PARTY-NOTICES.md | e40b4841458e19a3b5d57828bff0a10ff38c00ff0e917eeffed1d616f7f5a8ca |
| INVENTORY.md | e630b94cf71c0a6d1f6140ad0262a6da92e31e3d2d038eb49cc961c7d7c4da6d |
| SOURCES.md | 6a529b06c49e8b559aa67cbbe13d30675d7b8360b87793898ebe988144c8c45d |
| licenses/ (188 texts; the sha256 of their sorted `sha256sum` list) | c4e18ee9fae0def9660a801c8c1eb25edfb240fa8d8e1d54cd94fecb462a0a07 |

## The text that goes next to the assets (GPL-3.0 section 6(d): directions beside the binaries)
Draft, for the release page and for every other channel that offers these binaries, kept up for as long as they are
offered:

> enclave-domain-release-52156652d67a.tar.xz is an Enclave guest domain release (release id 52156652…). It contains
> third-party software under its own licenses: the Linux kernel and modules (GPL-2.0), GNU GRUB inside the firmware
> (GPL-3.0-or-later), the GNU C Library as a shared runtime (LGPL-2.1-or-later), the GCC runtime (GPL-3.0-or-later
> with the GCC Runtime Library Exception), musl libc (MIT), EDK II, OpenSSL, Wasmtime and its Rust crates, the Go and
> Rust standard libraries, and others. THIRD-PARTY-NOTICES.md and licenses/ inside the tarball carry their notices.
> The complete corresponding source of those components is enclave-guest-corresponding-source-11b366ea5a41.tar,
> published here beside it; SOURCES.md inside the tarball lists every file in it with its sha256.
> Enclave's own code in the release is under this repository's LICENSE.

## Scope, for the publication text
- **What changed from 79c5ecf2:** only template/front, Enclave's own code: the console guard (nothing but the front's
  own `DOM` statements reaches the host's console). No third-party byte changed; the notices differ only in their title.
- **template/init is 79c5ecf2's bytes:** musl 1.2.6 (MIT) linked statically, with GCC's crtbeginS.o and crtendS.o
  (GCC Runtime Library Exception). No glibc and no LGPL code is statically linked into init.
- **glibc stays as a shared runtime.** template/rt/ still ships glibc's shared runtime set, which wasmtime is
  dynamically linked with (ld-linux-x86-64.so.2, libc.so.6, libm.so.6), and libgcc_s.so.1. Their notices and their
  complete corresponding source are as in the earlier packages.
- **No legal claim is made either way** beyond these facts.

## Not in this publication
79c5ecf2's own publication (../release-aa6c985c/) is HELD as well; if both were ever published they would share the
one bundle. The earlier releases 5c3561f9 (0181bce3) and a4f22748 (17e182a8) link glibc statically into init. Their
packages exist (../release-0181bce3/, ../release-17e182a8/), but their publication stays HELD: the open LGPL-2.1
section 6 point applies to them, and this release does not resolve it.
