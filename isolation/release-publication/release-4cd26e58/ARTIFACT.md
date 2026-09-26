# The publication artifact of release 4cd26e58, the seccomp-statement release (for review; not published)

| | |
|---|---|
| release id | aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532 (sha256 of release.json) |
| source | branch **isolation/seccomp-evidence**, commit **4cd26e58bf44958fdf37b063408640f35596dc02** (not main; enclave-87's ruling). enclave-5d and enclave-bf gave GO on the chain through 47b7b520; 4cd26e58 adds a host-side table change only (enclave-b4). enclave-bf's independent rebuild of the release: GO |
| release tarball | enclave-domain-release-aee2059ffcc7.tar.xz, sha256 **ffb5b3a3df7259e9abdb71793ac790634b849fafdd11fe1cb34b9ceb36fb6a60**, 32039972 bytes |
| its contents | release/ (the 16 release files), template/init's source (source/isolation/m2/dominit.c, app-seccomp.h, sha256-min.h), PUBLICATION-MANIFEST.json (with the musl build record), THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (188 texts) |
| corresponding source, distributed alongside it | 79c5ecf2's bundle, unchanged: enclave-guest-corresponding-source-11b366ea5a41.tar, sha256 **21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da** |
| draft release manifest | [DRAFT-RELEASE.md](DRAFT-RELEASE.md): no release was created |

## Checked (2026-09-26; nothing deployed was written)
- **The cut:** `cut-release.sh 4cd26e58` built the release twice from a clean worktree, the second time with a cold Go
  cache; musl from 4cd26e58's own build-musl.sh (libc.a 4f72e098…, signature checked); byte-identical; the id verifies.
  enclave-bf reproduced it independently: the same id, `diff -r` identical.
- **Against 5db18199** (`check-third-party.py`): only template/front (3ccf698b… → b4f56fed…) and template/init
  (00355508… → b8aa8dcb…) differ; the kernel, firmware, rt/, modules, cmdline and measure parameters are byte-identical.
- **The filter init states:** app_seccomp_prog, compiled from 4cd26e58's app-seccomp.h, is 71 instructions, 568 bytes,
  sha256 d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66. Its exact bytes occur once in this init, and
  once in 5db18199's: the filter is unchanged, and init now states it.
- **init's link,** re-derived with `-Wl,-Map` by app-image-template.sh's exact command (the same bytes, b8aa8dcb):
  musl's Scrt1.o, crti.o, crtn.o and 147 libc.a members (5db18199's 142, re-derived the same way, plus kill, poll,
  rename, sscanf and vsscanf); GCC's crtbeginS.o and crtendS.o; no libgcc or libatomic member. No INTERP, no glibc
  string.
- **The artifact:** `make-artifact.sh` twice → the same tarball, ffb5b3a3…. Its release/ is IDENTICAL to the cut.
- **The notices:** `collect-notices.py --init musl` with 79c5ecf2's inputs; THIRD-PARTY-NOTICES.md equals 5db18199's
  below its title, and licenses/ is identical (c4e18ee9…).
- **init's source, now complete:** from this artifact on, make-artifact.sh ships dominit.c WITH the local headers it
  includes, transitively (here app-seccomp.h and sha256-min.h), and the manifest's `source` lists each with its sha256.
  5db18199's first artifact (../release-0c087de8/, d2252757) carried dominit.c alone, which does not compile without
  app-seccomp.h; on enclave-87's word it was re-made with this script (ace3ae69…), its source/ alone building 00355508.
- **init's source compiles as shipped:** source/ alone, extracted from the tarball and built by the release's command
  against the same musl prefix, gives b8aa8dcb…, the released init.

## Rebuild
As for 5db18199 ([../release-0c087de8/ARTIFACT.md](../release-0c087de8/ARTIFACT.md)), at 4cd26e58 on
isolation/seccomp-evidence:
- `cut-release.sh 4cd26e58 <dir> --reference <5db18199's release dir> --reference-id 5db18199…`;
- `MUSL_PREFIX=<dir>/musl make-artifact.sh 4cd26e58 <outdir> --expect <dir>/release-4cd26e58 --firmware <rebuilt fd>
  --firmware-versions <its versions.txt> --notices isolation/release-publication/release-4cd26e58`;
- the notices: `collect-notices.py … --init musl --title "domain release 4cd26e58 (release id aee2059ffcc7bd8a...,
  the seccomp-statement release)" --extra-md isolation/release-publication/production/front-embedded-data.md`.

## Reviews before anything is published
e3, 5d, 63 and bf review this artifact and DRAFT-RELEASE.md. Until then, and until the publication hold lifts,
nothing is created or published.
