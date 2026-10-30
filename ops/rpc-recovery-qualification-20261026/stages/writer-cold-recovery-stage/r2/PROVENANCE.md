# writer-cold-recovery-stage/r2 provenance (prepared; NOT run by Claude)

**Root decision 1554/1556:** the authenticated backward header + receipt scan (§Alt).
- **The rejected r1 design** (committed lease index + H1) stays as `../r1/patches/ABANDONED-unqualified-partial-vs-r2.patch` (sha256 `c54c5211…`). It is **unqualified evidence only**.
- **Reviews used** (copied into `inputs/`): `claude-lease-index-design-review-1554.md`, `lease-index-kvm-review-1556.txt`.

**Chain of bases:**
1. r9 `release.git` `296a5833` (tree `90e4cdaa`);
2. + the frozen two-anchor r1 → `f22d554c`;
3. + r2 → `20d0d76a`;
4. + r3 (test-only) → `5f141c3f` (r3 SUMS `5ca6754e…`);
5. **+ `patches/writer-cold-recovery-r2-vs-two-anchor-r3.patch`** (sha256 `0e8c4cfd3bd4929aed25c8e4ec94be1b0b01073ebc4cba85f2abc9025e860aac`) → **`e903c224163a47186b96e7f94e5094c5a043c3b2`**.

- **Reproduction:** re-applied to a fresh `git archive` of r9 plus r1, r2 and r3, all four trees reproduce.
- **Scope:** prepared in scratch `/tmp/w4`. No tests, builds, `node` runs, network actions or commits. **Executed:** only `bash -n` on the job, sha256 sums and the scratch git tree computation.
- **Not duplicated:** the driver (owned by another agent). **Unchanged:** the vendored schedule reader `694f1297…`.

## Code hashes (sha256, two-anchor r3 → cold-recovery r2)
| file | r3 | r2 |
|---|---|---|
| network/derived-reader/backward-history.mjs | (new) | 96be88c42fe12241602950df552874da43a71570fac969854bf1150dfd2eae5f |
| network/derived-reader/provider.mjs | fb2301762dbcdbbe52cc27730f9ddac77127c8105dd5776850692bcf5b8eea83 | 76a72d05d27cac83b08ffc9e9b0771d3d5b2fae21ca4f4ba7a5d071e9041abce |
| network/derived-reader/coverage-store.mjs | 1e87de6b514dcc0e750c68025ef326c85fdf4bf8dd2b2e4ebb4086c692292d6a | ca9900f5195a6822cf92c3d434ef9e29d1baba16e35a2a6be280190e186ff411 |
| network/derived-reader/lifecycle.mjs | 0996e3edf949608118f4f1fa55c72a23bb60784d809f1f64108db517daca8669 | 798f897b5742391a1dcfccd23dca541c3aad7d98796b76db03a3d51c7d3546fc |
| relay/derived-writer-authority.mjs | 0fab45cbc3f54a9f133456642ae9d391550123f98f1eca1504f4fdf3e846318e | 3b040fb1af35d7e7defccf0d68aab9ce6ee93316bdc8538b1a5b53a025be59fa |
| test/derived-reader/backward-history.test.mjs | (new) | 9aa8090e69deb472e779c6a274dab778bd7274f204a71caeec335952a66ff9a8 |
| test/derived-writer-history.test.mjs | (new) | 1d97d3c1a0a758db62e960755d58294ac0f47167b9ff32db3d8162eecde43149 |

**Primitives reused as is** (pinned or audited, unchanged):
- `network/derived-reader/vendor/anchor-bootstrap.mjs` (`headerHash`; `authenticateAnchor` via the existing ASR seed);
- `network/op-receipts-root.mjs` (`verifyBlockReceipts`, `orderedTrieRoot`, `logsBloom`, `BASE_MAINNET`).

**KVM-owned files are changed:** `network/derived-reader/*`. KVM must review them via root.

## Expected counts
| suite | tests |
|---|---|
| backward-history | 10 |
| writer-history | 6 |
| two-anchor suites | 13 / 12 / 12 |
| KVM r3 suites | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

- **The `slice` total is 174.**
- **`check`** adds the r3 check set (r9 counts) unchanged.
