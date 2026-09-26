# The publication artifact of release 4cdd5169, the console-guard release (for review; not published)

| | |
|---|---|
| release id | 52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1 (sha256 of release.json) |
| build commit | 4cdd516924981eeacefc8ccaefb4e7fc0e1ec939, the head of isolation/front-console-guard (the guard approved by d1 on 0475ae50, e3 on fbc50ea4, bf and d1 on 4cdd5169) |
| release tarball | enclave-domain-release-52156652d67a.tar.xz, sha256 **b5315ff0b20ff839566f40ac1f072ce34a4d5e28282f8aad749a960f82d86bf2**, 31997212 bytes |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json (with the musl build record), THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md, licenses/ (188 texts) |
| corresponding source, distributed alongside it | 79c5ecf2's bundle, unchanged: enclave-guest-corresponding-source-11b366ea5a41.tar, sha256 **21752b26d36f33198ffc8aadf3b8fdff235646dd35eaa694eb6d5473f6d093da** (SOURCES.md says why no new bundle is made) |
| draft release manifest | [DRAFT-RELEASE.md](DRAFT-RELEASE.md): no release was created |

## Checked (2026-09-26; nothing deployed was written)
- **The cut:** `cut-release.sh 4cdd5169` built the release twice from a clean worktree, the second time with a cold Go
  cache. musl came from 4cdd5169's own build-musl.sh (libc.a 4f72e098…, signature checked). The two builds are
  byte-identical: every file, the tree and the modes. The id verifies.
- **Against 79c5ecf2** (`check-third-party.py`): only template/front differs (bd066066… → 76f345bc…). template/init is
  79c5ecf2's ba7f7ff0…, and the kernel, firmware, rt/, modules, cmdline and measure parameters are byte-identical.
  enclave-bf checked the same independently: release.json differs only in the front's sha256 and size, and bf's own
  front build from a clean 4cdd5169 worktree is 76f345bc….
- **The artifact:** `make-artifact.sh` twice → the same tarball, b5315ff0…. Its release/ is IDENTICAL to the cut:
  16 files, the tree and the modes.
- **The notices:** `collect-notices.py --init musl` with 79c5ecf2's inputs. THIRD-PARTY-NOTICES.md equals 79c5ecf2's
  below its title, and licenses/ equals 79c5ecf2's (`diff -r`; the sorted-list sha256 is c4e18ee9… for both).
  INVENTORY.md and SOURCES.md are 79c5ecf2's, edited for this release.
- **dominit.c** is unchanged between aa6c985c and 4cdd5169 (sha256 209bf3c2…).

## Rebuild
As for 79c5ecf2 ([../release-aa6c985c/ARTIFACT.md](../release-aa6c985c/ARTIFACT.md)), at 4cdd5169:
- `cut-release.sh 4cdd5169 <dir> --reference <79c5ecf2's release dir> --reference-id 79c5ecf2…`;
- `MUSL_PREFIX=<dir>/musl make-artifact.sh 4cdd5169 <outdir> --expect <dir>/release-4cdd5169 --firmware <rebuilt fd>
  --firmware-versions <its versions.txt> --notices isolation/release-publication/release-4cdd5169`;
- the notices: `collect-notices.py … --init musl --title "domain release 4cdd5169 (release id 52156652d67a20a7...,
  the console-guard release)" --extra-md isolation/release-publication/production/front-embedded-data.md`.

## Reviews before anything is published
e3, 5d, 63 and bf review this artifact and DRAFT-RELEASE.md. Until then, and until the publication hold lifts,
nothing is created or published.
