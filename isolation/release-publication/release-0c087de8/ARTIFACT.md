# The publication artifact of release 0c087de8, the W^X-at-attest release (for review; not published)

| | |
|---|---|
| release id | 5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77 (sha256 of release.json) |
| source | branch **isolation/wx-at-attest**, commit **0c087de8213ddd6ac7b8ed7e472b02ad23672bd5** (not main; enclave-87's ruling). enclave-bf and enclave-5d gave GO on the chain; enclave-bf's artifact diff: GO |
| release tarball | enclave-domain-release-5db18199ef0d.tar.xz, sha256 **d2252757a565cbaa112d5f678d64078dbef08d345187c9eb6b30472a5cd9be47**, 32015636 bytes |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json (with the musl build record), THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (188 texts) |
| corresponding source, distributed alongside it | 79c5ecf2's bundle, unchanged: enclave-guest-corresponding-source-11b366ea5a41.tar, sha256 **21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da** |
| draft release manifest | [DRAFT-RELEASE.md](DRAFT-RELEASE.md): no release was created |

## Checked (2026-09-26; nothing deployed was written)
- **The cut:** `cut-release.sh 0c087de8` built the release twice from a clean worktree, the second time with a cold Go
  cache; musl from 0c087de8's own build-musl.sh (libc.a 4f72e098…, signature checked); byte-identical; the id verifies.
  The same id came from 41628357 earlier (a build VOIDED by enclave-b4's HOLD on a host-side test): the guest sources
  are identical between the two commits.
- **Against f7888d86** (`check-third-party.py`): only template/front (6c619b9d… → 3ccf698b…) and template/init
  (52640baf… → 00355508…) differ; the kernel, firmware, rt/, modules, cmdline and measure parameters are byte-identical.
  enclave-bf checked the same independently and rebuilt both files from a clean 0c087de8 worktree, byte-identical.
- **init's link,** re-derived with `-Wl,-Map` by app-image-template.sh's exact command (the same bytes, 00355508):
  musl's Scrt1.o, crti.o, crtn.o and 142 libc.a members; GCC's crtbeginS.o and crtendS.o; no libgcc or libatomic
  member. No INTERP, no glibc string.
- **The artifact:** `make-artifact.sh` twice → the same tarball, d2252757…. Its release/ is IDENTICAL to the cut.
- **The notices:** `collect-notices.py --init musl` with 79c5ecf2's inputs; THIRD-PARTY-NOTICES.md equals f7888d86's
  below its title, and licenses/ is identical (c4e18ee9…).

## Rebuild
As for f7888d86 ([../release-b63c2def/ARTIFACT.md](../release-b63c2def/ARTIFACT.md)), at 0c087de8 on isolation/wx-at-attest:
- `cut-release.sh 0c087de8 <dir> --reference <f7888d86's release dir> --reference-id f7888d86…`;
- `MUSL_PREFIX=<dir>/musl make-artifact.sh 0c087de8 <outdir> --expect <dir>/release-0c087de8 --firmware <rebuilt fd>
  --firmware-versions <its versions.txt> --notices isolation/release-publication/release-0c087de8`;
- the notices: `collect-notices.py … --init musl --title "domain release 0c087de8 (release id 5db18199ef0d321e...,
  the W^X-at-attest release)" --extra-md isolation/release-publication/production/front-embedded-data.md`.

## Reviews before anything is published
e3, 5d, 63 and bf review this artifact and DRAFT-RELEASE.md. Until then, and until the publication hold lifts,
nothing is created or published.
