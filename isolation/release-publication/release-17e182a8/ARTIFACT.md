# The publication artifact of release 17e182a8, the production release (for review; not published)

| | |
|---|---|
| release id | a4f227482df4830ab69b52e38dc5d6e2abea9e5c5fb71f5469f0c30e6b1cb784 (sha256 of release.json) |
| build commit | 17e182a8ba192152a83feee4f79d63f8628094e8 (approved by d1 and e3; e3's review was at its ancestor 77cf2d78) |
| release tarball | enclave-domain-release-a4f227482df4.tar.xz, sha256 **7955e736778d5cc8d9689eacdab570682f849351bc15164f4e0e32834a588107** |
| its contents | release/ (the 16 release files), source/isolation/m2/dominit.c, PUBLICATION-MANIFEST.json, THIRD-PARTY-NOTICES.md (with the front's embedded data), INVENTORY.md, SOURCES.md, licenses/ (184 texts) |
| corresponding source, distributed alongside it | enclave-guest-corresponding-source-d3cfd855be41.tar, sha256 **7509205f84a1d9110dabad000e4a28f0a12532bf6df030b82661ca8bd70b2fec**: the same bundle as 0181bce3's, since the third-party bytes are the same |
| rollback | release 5c3561f9 (0181bce3); its artifact is in ../release-0181bce3/ARTIFACT.md |

Both are kept outside git. Where they are hosted, together, is the publisher's decision.

## Checked (2026-09-25; read-only on enclave-5d's artifact; nothing deployed was written)
- **`check-third-party.py` against 5c3561f9 prints SAME.** Only Enclave's own front and init differ.
- **Rebuilt from a clean worktree at 17e182a8, byte-identical to 5d's approved artifact:** all 16 files, the tree and
  the modes, and the id verified. It builds a production front: ISOLATION_LAB_FRONT unset, GOFLAGS cleared, and a Go
  cache of its own.
- **The firmware inside it is the one rebuilt from pinned source (142589cc).**
- **The tarball is deterministic:** two independent runs gave the same sha256.

## Rebuild
The same as [../release-0181bce3/ARTIFACT.md](../release-0181bce3/ARTIFACT.md), with two differences:
- `make-artifact.sh 17e182a8 … --notices isolation/release-publication/release-17e182a8`;
- the notices are made with `--title "domain release 17e182a8 (release id a4f227482df4830a..., the production
  release)" --extra-md isolation/release-publication/production/front-embedded-data.md`.
