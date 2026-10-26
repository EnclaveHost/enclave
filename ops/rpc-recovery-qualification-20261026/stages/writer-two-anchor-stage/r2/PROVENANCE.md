# writer-two-anchor-stage/r2 provenance (prepared; NOT run by Claude)

**Chain of bases:**
1. The r9 release `release.git` commit `296a5833…`, tree `90e4cdaa…`.
2. The **frozen r1 patch** gives `f22d554c…`.
   - r1 stage `SHA256SUMS` sha256 `cdacd616…`.
   - root 1522 ran the r1 slice: 144/144 pass.
3. **`patches/writer-two-anchor-r2-vs-r1.patch`** (sha256 `6ee01917…`) gives source tree **`20d0d76a98da84622b98991547dc07fb2fe39e3e`**.
   - Re-applied to a fresh archive of r9 plus the r1 patch, it reproduces both trees.
   - The patch touches 11 files: 9 changed, 2 new.

**Scope of what was done:**
- **Prepared in** a scratch copy (`/tmp/w2b`).
- **Untouched:** r1, r9, the KVM r3 closure, the KVM chat files and the main checkout.
- **Not done:** tests, builds, `node --check`, network actions or commits.
- **Executed:** only `bash -n` on the job and sha256 sums.
- **No new replica, IPC or role API; the vendored schedule reader is unchanged** (`694f1297…`, r1).

## Code hashes (sha256, r1 → r2)
| file | r1 | r2 |
|---|---|---|
| network/deployment-lifecycle-journal.mjs | 14471c5e1a3b250fff2e05827aacc5a2704f0a501392f871c53d6a2b2e06d7f2 (= r9) | f5c053bce37d437e5425a8867c7611d92d42daa9bf6e97f5918b99fffda109f7 |
| network/derived-reader/coverage.mjs | d3e88df686bbe264feaf725fda1452cc7a23928112712e52f8ce55f7fc3c3df7 (= r9) | d6a9cd105c9421aca907c29cbebd9bc34a180bd23d855701cbf376d14b771589 |
| network/derived-reader/coverage-store.mjs | 076f51bff7e2ac2c66369b1a2625ca90be6c0bfca42eb95a10dbe48dc17b4127 | 1e87de6b514dcc0e750c68025ef326c85fdf4bf8dd2b2e4ebb4086c692292d6a |
| network/derived-reader/lifecycle.mjs | 7bd60c3fa18e980a0aed73a27cfd4adab9afb38108b262ea86ffcc52f9a5353b | 0996e3edf949608118f4f1fa55c72a23bb60784d809f1f64108db517daca8669 |
| network/derived-reader/provider.mjs | cf652077ec126f8b0dade730e1c5674c6a9f84bac80ea674497a29667a4fc25a | fb2301762dbcdbbe52cc27730f9ddac77127c8105dd5776850692bcf5b8eea83 |
| network/lifecycle-finality-bridge.mjs | 28fad4cae207059b349a2f5009057f9a68c22a37e889e7b722627eed8873c3ec | c9162fac829088d7a2fa6b18542aae38eeeaa6fef6f031fa2bead21d4094e02e |
| relay/derived-writer-authority.mjs | b5a3a121e4aae614b9231e682c36a27761aa605a6df0f67614f86abe5fbae09c | 0fab45cbc3f54a9f133456642ae9d391550123f98f1eca1504f4fdf3e846318e |
| test/derived-reader/two-anchor.test.mjs | f6af67e7a8d7f31a4f426d53c086a98da5cc5755240205c93447679f7c51266f | 1e344f6eef5ecbe6303903420fe312ef6ec6ff732052968b8250f61c8a4c7118 |
| test/derived-writer-two-anchor.test.mjs | 0ffc2436ad3109b7b2ffc0c488ba8a934f2806ae79c02e3d87ccd5a69a9702d4 | e3e34a36d6948344fd4e5b109a4295b2a336c43fb3d744c132d1a3e4df4f8f62 |
| test/derived-reader/two-anchor-fixtures.mjs | (new) | 469729bb29c330aa28d6cc51565573e8ec4aac8b6934230a7695622d2fd33bfa |
| test/derived-reader/two-anchor-r2.test.mjs | (new) | 727cc09f0fbaae1a39bf7a2dbaf50745cffa6be89541512902ddb6744f3cbcf5 |

**Generated artifacts:** root's `check` rebuilds the reader bundle and the guest bundle; no build hash is claimed here. **KVM-owned files are changed**, so this needs KVM review.

## Expected counts (job verdict)
| suite | tests |
|---|---|
| two-anchor-reader (r1-adapted) | 13 |
| two-anchor-reader-r2 | 12 |
| two-anchor-writer | 12 (r1: 10) |
| KVM r3 suites | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

- **The `slice` mode total is 158.**
- **`check`** adds:
  - the r9/r1 set at its counts: endpoints 6, overlay 25/6, platform-api-config 5, relay-derived-reader-runtime 4, paid-derived-packaging 5;
  - the relay set 8/9/1/6/9/6/11/10/1/12;
  - the 5 startups and the 13-fixture unenrolled-tree checker.
