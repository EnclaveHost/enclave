# writer-integrated-stage/r5 provenance (prepared by Claude 1614; NOT run)

**What r5 is:** integrated r4 (SUMS `f5192215…`, tree `59a64a8d`: integrated r3 + the root 1612 optional-witnessUrl fix), composed on **history r5** (SUMS `e9fa8b37…`, tree `97c8a15a`: the retained-bytes bound).

**Chain:**
r9 → two-anchor r1–r3 → cold-recovery r2 `e903c224` → history r3 `a4dd62c3` → history r4 `571b5c84` → **history r5 `97c8a15a`** → driver r1 **`1119db5b799ff49bb435fa63823e4727da2cf1e7`**
→ **`patches/writer-integrated-r5-vs-cold-recovery-r5-plus-driver-r1.patch`** → **`939d8d08acf6b30d97b79cc842edc82e8919c472`**.

- **The integration diff is byte-identical to integrated r4's** (checked by `cmp` of the two diffs).
- **History r5 touches only** `network/derived-reader/backward-history.mjs` and `test/derived-reader/backward-history.test.mjs`, which are disjoint from the driver and integration files.
- **`release.git`:** branch `integrated-r5-source` = commit `d07179844aad45742a112fd384d6b306a6a9004a`, tree `939d8d08…`.
- **Scratch:** `/tmp/claude-int-r5-1614` (from my r4 scratch). Executed: sha256, scratch git, `bash -n`. No `node`, tests or builds.

## Expected counts
**slice = 211:**

| suite | tests |
|---|---|
| driver-integration | 10 |
| witness-placement | 5 |
| driver | 10 |
| backward-history | **19** |
| writer-history | 9 |
| two-anchor | 13 / 12 / 12 |
| KVM r3 | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

**check:** as in r3/r4.
