# The publication artifact of release b63c2def, the hardened release (for review; not published)

| | |
|---|---|
| release id | f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca (sha256 of release.json) |
| build commit | b63c2def6e9b12088c30594b8cb58c7273903a60 (isolation/snp-dominit-yama: 298924ae's front + enclave-5d's hardened dominit; enclave-5d's GO; enclave-bf's artifact diff GO) |
| release tarball | enclave-domain-release-f7888d869084.tar.xz, sha256 **c3bc9937d67f6d5275311ffbdf641bb2d6d32d4fc457433d409f883aa1ea0ae6**, 32011560 bytes |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json (with the musl build record), THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (188 texts) |
| corresponding source, distributed alongside it | 79c5ecf2's bundle, unchanged: enclave-guest-corresponding-source-11b366ea5a41.tar, sha256 **21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da** |
| draft release manifest | [DRAFT-RELEASE.md](DRAFT-RELEASE.md): no release was created |

## Checked (2026-09-26; nothing deployed was written)
- **The cut:** `cut-release.sh b63c2def` built the release twice from a clean worktree, the second time with a cold Go
  cache. musl came from b63c2def's own build-musl.sh (libc.a 4f72e098…, signature checked). The two builds are
  byte-identical: every file, the tree and the modes. The id verifies.
- **Against 52156652** (`check-third-party.py`): only template/front (76f345bc… → 6c619b9d…) and template/init
  (ba7f7ff0… → 52640baf…) differ; the kernel, firmware, rt/, modules, cmdline and measure parameters are byte-identical.
  enclave-bf checked the same independently and rebuilt both files from a clean b63c2def worktree, byte-identical.
- **init's link,** re-derived here with `-Wl,-Map` by app-image-template.sh's exact command (the same bytes, 52640baf):
  musl's Scrt1.o, crti.o, crtn.o and 142 libc.a members; GCC's crtbeginS.o and crtendS.o; no libgcc or libatomic
  member. No INTERP, no dynamic section, no glibc string.
- **The artifact:** `make-artifact.sh` twice → the same tarball, c3bc9937…. Its release/ is IDENTICAL to the cut:
  16 files, the tree and the modes.
- **The notices:** `collect-notices.py --init musl` with 79c5ecf2's inputs; THIRD-PARTY-NOTICES.md equals 52156652's
  below its title, and licenses/ is identical (c4e18ee9…). INVENTORY.md and SOURCES.md are 52156652's, edited for this
  release (init's section re-derived).

## Rebuild
As for 52156652 ([../release-4cdd5169/ARTIFACT.md](../release-4cdd5169/ARTIFACT.md)), at b63c2def:
- `cut-release.sh b63c2def <dir> --reference <52156652's release dir> --reference-id 52156652…`;
- `MUSL_PREFIX=<dir>/musl make-artifact.sh b63c2def <outdir> --expect <dir>/release-b63c2def --firmware <rebuilt fd>
  --firmware-versions <its versions.txt> --notices isolation/release-publication/release-b63c2def`;
- the notices: `collect-notices.py … --init musl --title "domain release b63c2def (release id f7888d8690845cbb...,
  the hardened release)" --extra-md isolation/release-publication/production/front-embedded-data.md`.

## Reviews before anything is published
e3, 5d, 63 and bf review this artifact and DRAFT-RELEASE.md. Until then, and until the publication hold lifts,
nothing is created or published.
