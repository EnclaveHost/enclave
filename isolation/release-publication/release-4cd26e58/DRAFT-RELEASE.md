# DRAFT release manifest: domain release 4cd26e58 (NOT a release; nothing created or published)

**Status: DRAFT, for review by e3, 5d, 63 and bf.** Publication of the releases before it (79c5ecf2 included) is HELD.
No GitHub release, tag or upload exists, and none is to be created from this file until that review is done and the
publication is approved. The candidate location is this repository's existing GitHub Releases, with no new hosting.

## What would be published, together

| asset | sha256 | bytes |
|---|---|---|
| enclave-domain-release-aee2059ffcc7.tar.xz (the binaries, the notices and init's source) | ffb5b3a3df7259e9abdb71793ac790634b849fafdd11fe1cb34b9ceb36fb6a60 | 32039972 |
| enclave-guest-corresponding-source-11b366ea5a41.tar (the corresponding source) | 21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da | 328878080 |

- **The release:** id aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532 (sha256 of release.json),
  built at image commit 4cd26e58bf44958fdf37b063408640f35596dc02 on branch isolation/seccomp-evidence (not main).
- **The source bundle is 79c5ecf2's, unchanged** (SOURCES.md): the third-party bytes are 79c5ecf2's exactly. Its README
  names 5c3561f9, a4f22748 and 79c5ecf2. A re-made bundle naming aee2059f too would be a different tar under the same
  name, so none is made; at most one of the two may ever be published.
- **The two assets go out together, in the same place.** The source bundle is not optional, and a link to upstream
  sources does not replace it.

## The notices, inside the release tarball (and in this directory)

| file | sha256 |
|---|---|
| THIRD-PARTY-NOTICES.md | 961aaea690242bee44e6727d5d6e6d95c0fd9f15c4583bc6584d0505a5def3d5 |
| INVENTORY.md | 1196ec8399b9ff83219e372ab79bb43838f4348c232b47bd0dd0b4fc29015e30 |
| SOURCES.md | 2f249ea293f9124b7f7c82e715aa246dfe2a1b787cb7c45d9c99255f31d87a15 |
| licenses/ (188 texts; the sha256 of their sorted `sha256sum` list) | c4e18ee9fae0def9660a801c8c1eb25edfb240fa8d8e1d54cd94fecb462a0a07 |

## The text that goes next to the assets (GPL-3.0 section 6(d): directions beside the binaries)
Draft, for the release page and for every other channel that offers these binaries, kept up for as long as they are
offered:

> enclave-domain-release-aee2059ffcc7.tar.xz is an Enclave guest domain release (release id aee2059f…). It contains
> third-party software under its own licenses: the Linux kernel and modules (GPL-2.0), GNU GRUB inside the firmware
> (GPL-3.0-or-later), the GNU C Library as a shared runtime (LGPL-2.1-or-later), the GCC runtime (GPL-3.0-or-later
> with the GCC Runtime Library Exception), musl libc (MIT), EDK II, OpenSSL, Wasmtime and its Rust crates, the Go and
> Rust standard libraries, and others. THIRD-PARTY-NOTICES.md and licenses/ inside the tarball carry their notices.
> The complete corresponding source of those components is enclave-guest-corresponding-source-11b366ea5a41.tar,
> published here beside it; SOURCES.md inside the tarball lists every file in it with its sha256.
> Enclave's own code in the release is under this repository's LICENSE.

## Scope, for the publication text
- **What changed from 5db18199:** only Enclave's own template/front (the seccomp check at each attestation, stated as
  seccomp=<hash>) and template/init (the statement of the app runtime's seccomp filter; the filter itself is
  unchanged). No third-party byte changed; the notices differ only in their title.
- **template/init links musl 1.2.6 (MIT) statically,** now 147 members of its libc.a, with GCC's crtbeginS.o and
  crtendS.o (GCC Runtime Library Exception); no libgcc or libatomic member. No glibc and no LGPL code is statically
  linked into init.
- **glibc stays as a shared runtime.** template/rt/ still ships glibc's shared runtime set, which wasmtime is
  dynamically linked with (ld-linux-x86-64.so.2, libc.so.6, libm.so.6), and libgcc_s.so.1. Their notices and their
  complete corresponding source are as in the earlier packages.
- **No legal claim is made either way** beyond these facts.

## Not in this publication
The publications of 79c5ecf2, 52156652, f7888d86 and 5db18199 (../release-aa6c985c/, ../release-4cdd5169/,
../release-b63c2def/, ../release-0c087de8/)
are HELD as well; if more than one were ever published they would share the one bundle. The earlier releases 5c3561f9
(0181bce3) and a4f22748 (17e182a8) link glibc statically into init. Their packages exist (../release-0181bce3/,
../release-17e182a8/), but their publication stays HELD: the open LGPL-2.1 section 6 point applies to them, and this
release does not resolve it.
