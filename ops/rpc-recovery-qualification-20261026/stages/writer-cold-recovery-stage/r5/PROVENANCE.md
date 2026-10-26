# writer-cold-recovery-stage/r5 provenance (prepared; NOT run by Claude)

r5 = frozen **history r4** (SHA256SUMS `9fa22972da017bc563064336ce50985a27690391a50a3144e364442a6b40a54c`, tree `571b5c84a8ffe3e6bc9c21ca4184a5b4a7ebb1af`;
root 1606: 183 PASS) + `patches/writer-cold-recovery-r5-vs-r4.patch` = tree **`97c8a15a30a0b8859645b5c92e1477de0bb6f602`**.

**Defect fixed (root 1606 code review):** r4 bounded in-flight bytes only; full header and per-index raw-transaction replies were retained per batch.

**Reproduction:** `git archive 571b5c84` + `git apply --index` of the patch reproduces `97c8a15a` (scratch `/tmp/claude-hist-r5-1609`, verified in `/tmp/claude-hist-r5-1609-verify`).

**Not done:** no tests, builds, `node`, network, USB or live actions.

**Scratch incident:** `/tmp/w8` (the r4 author's scratch) was mistakenly written and then restored. Its index tree is again `571b5c84` and my copy was removed. See `logs/claude-history-r5-retained-budget-1609.md`.

## Touched paths (r4 → r5, sha256)
| path | r4 | r5 |
|---|---|---|
| network/derived-reader/backward-history.mjs | 49e834d555d4cf199589ea1900ff5d088f918846ff1d2b6de3e30789f492cd7d | 0977bcdb386ae607107b9dbafead0f5dd2ee8074db9c0efeb3290036e817b4b9 |
| test/derived-reader/backward-history.test.mjs | 21334a25266002f44893760986cec90aaf350e964de8b2cd881961aac02d0b20 | 30bc227b957f81169fb34703babcae4ceab12035fb00670218d38b98ad99a4f3 |

**Unchanged:** `provider.mjs`, the writer authority, the pinned primitives and the v2 policy.

## Expected counts
| suite | tests |
|---|---|
| backward-history | **19** (r4's 16 + 3) |
| writer-history | 9 |
| everything else | unchanged from r4 |

**The `slice` total is 186** (r4: 183).

## Merge
Apply the patch with `git apply --index` (or `--3way`) on any tree that holds the r4 blobs of the two paths. It touches only `backward-history.mjs` and its test.
