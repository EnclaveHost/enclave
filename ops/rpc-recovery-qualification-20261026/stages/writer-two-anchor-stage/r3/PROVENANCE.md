# writer-two-anchor-stage/r3 provenance (prepared; NOT run by Claude)

**Chain of bases:**
1. The r9 release `release.git` commit `296a583331b638a430f72929648ebf26d86522d3`, tree `90e4cdaa…`.
2. **+ the frozen r1 patch** gives `f22d554c04f959a56d993f1c5048cd9e06a2d4b0` (r1 SUMS `cdacd616…`).
3. **+ the frozen r2 patch** (`writer-two-anchor-stage/r2/patches/writer-two-anchor-r2-vs-r1.patch`, sha256 `6ee01917…11a9`) gives `20d0d76a98da84622b98991547dc07fb2fe39e3e` (r2 SUMS `3dba09e6…22fe2`).
4. **+ `patches/writer-two-anchor-r3-vs-r2.patch`** gives source tree **`5f141c3fa476b904d6a0107a75c31c9113726591`**.

**How the trees were checked:**
- recomputed by Claude in a scratch bare repo whose alternates point at r9 `release.git`'s objects (`git read-tree` + `git apply --cached` + `git write-tree`);
- nothing was written into r9 `release.git`;
- all three trees reproduce: r1 `f22d554c`, r2 `20d0d76a` and r3 `5f141c3f`.

**The r3 change:**
- **One file, test only:** `test/derived-reader/two-anchor-r2.test.mjs`, from sha256 `727cc09f…cbcf5` (r2) to `38110cd2e4d9874a5eb16acdb5880e814b7b9fd891097cb98add9b725c2fc372`.
- **No module change:** the network, relay and journal code is byte-identical to r2.
- **Counts are unchanged:** two-anchor-reader-r2 stays at 12 tests, and the slice total stays at 158. The new checks are assertions inside the same test.

**Receipt of the failure being fixed** (copied read-only into `inputs/`; the originals stay in the r2 run dir):
- `inputs/r2-slice-1545-verdict.json` sha256 `8bc0c867…86d4` (= the r2 run's `verdict.json`);
- `inputs/r2-slice-1545-two-anchor-reader-r2.tap` sha256 `2d038038…2020` (= the r2 run's tap).

**Not done:**
- Prepared in scratch `/tmp/w3r`; `/tmp/w2b` and agent 50's work were not touched.
- No tests, builds, `node` runs, network actions or commits.
- **Executed:** only `bash -n` on the job, sha256 sums and the scratch git tree computation.
