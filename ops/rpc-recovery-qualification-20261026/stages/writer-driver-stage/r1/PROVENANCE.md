# writer-driver-stage/r1 provenance (prepared; NOT run by Claude)

**Base:** the frozen `writer-two-anchor-stage/r3` (SUMS `5ca6754e…`).
- The source tree `5f141c3fa476b904d6a0107a75c31c9113726591` = r9 release `296a5833` + r1 + r2 + r3.

**Patch:** `patches/writer-driver-r1-vs-writer-two-anchor-r3.patch` gives source tree **`e5260035d70f057fb0237e773f58b70f63210674`**.
- **Two NEW files only;** no existing file changes (the job asserts it):
  - `relay/derived-reader-driver.mjs` sha256 `689ff934a950669280e4ed07a31073abe4b0be8750095b9beae14ef5dd906ffa` (252 lines);
  - `test/derived-reader-driver.test.mjs` sha256 `d35dec974800b81e4042cf554a0d697228f66e20f64c2fe51917611123999c0b` (183 lines, **10 tests**).
- **How the tree was computed:** in a scratch bare repo whose alternates point at r9 `release.git` objects (nothing written into it).
- **The patch was re-applied** to the r3 reconstruction and reproduces both files byte for byte.

**Not touched:**
- Claude50's `writer-cold-recovery-stage` and its scratch;
- every frozen stage; KVM-owned files and the KVM chat.

**Not done:** no tests, builds, `node` runs, network actions or commits.
- **Executed:** only `bash -n` on the job, sha256 sums and the scratch git computation.

**The driver is wired into nothing in r1.** The interface contract is in `logs/claude-writer-driver-r1.md`.
