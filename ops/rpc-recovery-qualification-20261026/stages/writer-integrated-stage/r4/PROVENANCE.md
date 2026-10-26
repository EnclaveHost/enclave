# writer-integrated-stage/r4 provenance (prepared by Claude 1614; NOT run)

**Chain** (identical to r3 up to the last patch):
r9 → two-anchor r1–r3 → cold-recovery r2 `e903c224` → history r3 `a4dd62c3` → history r4 `571b5c84` (SUMS `9fa22972…`; root 1606: 183 PASS) → driver r1 **`cff4690a`**
→ **`patches/writer-integrated-r4-vs-cold-recovery-r4-plus-driver-r1.patch`** → **`59a64a8d6e10d1e9556cfbd132ad339164083793`**.

- **r4 = integrated r3** (`24636147…`, tree `8a616194`; frozen and preserved) **+ the root 1612 fix only:** `patches/INFO-integrated-r4-vs-r3-delta.patch` (2 files; informational, not applied by the job).
- **Verification:** the patch was verified from a fresh `cff4690a` checkout. The `e903c224` → `cff4690a` chain is unchanged from r3, which was verified then, and root's job re-asserts it from r9.
- **`release.git`:** branch `integrated-r4-source` = commit `a8165f254a66f41a75fa49147f232361d1deb1d3`, tree `59a64a8d…`, parent = the r3 commit `a560f978`.
- **Scratch:** `/tmp/claude-int-r4-1614` (cloned from r3's `release.git`, read-only). No other agent's scratch was touched.
- **Executed by me:** sha256, scratch git, `bash -n` on the job, Python text edits. No `node`, tests or builds.
- **History r5** (`claude-history-r5-retained-budget-1609.md`) is **not frozen** (EARLY). It is not included; it is the next composition.

| file | r3 sha256 | r4 sha256 |
|---|---|---|
| metal/guest/measured-control.mjs | a6fd2d5b01393fa731930d3e6c2e7fa3bb73e550a95c8aa709e799b5dedab020 | 530f826e4b4454a416a0bd5051d0c05b83888814f9e30f1336537d50c402c35a |
| test/witness-placement.test.mjs | 395af4c0f5a813247911774fc172958c290c3f79c5b4e9fd72f9c77a4b5ef978 | e28692b7036ddd66210b7d6512d55b4b3738ebc52c97fb3144a344091b9c7525 |

**All other files are byte-identical to r3** (source tree diff: these 2 paths only).

## Expected counts (unchanged from r3)
**slice = 208:**

| suite | tests |
|---|---|
| driver-integration | 10 |
| witness-placement | 5 |
| driver | 10 |
| backward-history | 16 |
| writer-history | 9 |
| two-anchor | 13 / 12 / 12 |
| KVM r3 | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

**check:** as in r3.
