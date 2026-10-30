# writer-cold-recovery-stage/r3 provenance (prepared; NOT run by Claude)

r3 = the frozen cold-recovery r2 (SHA256SUMS `73fae0c1046083bfbea8014e27efc33aa1b7788f664191962e20c3b59cc22f50`, tree `e903c224163a47186b96e7f94e5094c5a043c3b2`)
+ `patches/writer-cold-recovery-r3-vs-r2.patch` (sha256 `dbe2d1a65769af8aaf051c55dedc095087bfa73ebd4c751fa6c3f36435413f1d`) = tree **`a4dd62c303e2742dadc2b5fdf9d6d0023e5cd91a`**.

**What it repairs:**
- root 1571: the cache default `2 << 30` (= −2^31);
- review 1569: F1, F2/F4 (bounded concurrency, RAM resume, yields), F3, F5 and F6.

**Inputs** (copied): `inputs/claude-backward-history-review-1569.md`, `inputs/root-history-failure-1571.md`.

**Reproduction:** `git archive e903c224` + `git apply --index` of the patch reproduces `a4dd62c3` exactly (scratch `/tmp/w6-verify`).

**Scratch:** a private copy `/tmp/w6`. `/tmp/w4` (the r2 scratch) and `/tmp/w5` (Claude50's integration) were not modified.

**Not done:** no tests, builds, network, USB or live actions. **Executed:** `bash -n`, sha256 and scratch git trees only. An inadvertent `node --version` printed only a version string, and its output was discarded.

## Touched paths (r2 → r3, sha256)
| path | r2 | r3 |
|---|---|---|
| network/derived-reader/backward-history.mjs | 96be88c42fe12241602950df552874da43a71570fac969854bf1150dfd2eae5f | 789d67c9d3e307d15b225c5ab206c73886841239d7ab0edffdb2e8bf389e883b |
| network/derived-reader/provider.mjs | 76a72d05d27cac83b08ffc9e9b0771d3d5b2fae21ca4f4ba7a5d071e9041abce | dcf0f177433a1af378fd00166b46eb517c58a5330fa1b0c32e6108896fd7fcb6 |
| relay/derived-writer-authority.mjs | 3b040fb1af35d7e7defccf0d68aab9ce6ee93316bdc8538b1a5b53a025be59fa | 0e98e1b26995e10df9e38b9b31be40a8ac703b72dcd8ffb7c9b1d2e1e5839316 |
| test/derived-reader/backward-history.test.mjs | 9aa8090e69deb472e779c6a274dab778bd7274f204a71caeec335952a66ff9a8 | 33236d5cafd969aabfe34ca614764188dd25a78216a05b8921f3033cdce497e6 |
| test/derived-writer-history.test.mjs | 1d97d3c1a0a758db62e960755d58294ac0f47167b9ff32db3d8162eecde43149 | c065fb0c3152dffe112ebf3bd63dd4e5fda1b9c5cca3aaf1ada813a618dbb02f |

**Untouched:** `coverage-store.mjs` (`ca9900f5…`), `lifecycle.mjs` (`798f897b…`), and the pinned primitives `op-receipts-root.mjs` (`36c34dad…`) and `vendor/anchor-bootstrap.mjs` (`90a8afba…`).

## Expected counts
| suite | tests |
|---|---|
| backward-history | **13** (r2's 10, adapted, + 3) |
| writer-history | **9** (r2's 6 + 3) |
| everything else | unchanged from r2 |

The **`slice` total is 180** (r2: 174).

## Merge instructions (for the integrated stage; root coordinates)
1. Apply `patches/writer-cold-recovery-r3-vs-r2.patch` with `git apply --index` on top of any tree that contains the r2 versions of these five paths unchanged (`e903c224` contents).
2. If the integrated stage already edited any of them, merge by hand (`git apply --3way` against blob ids; the patch is `--full-index`).
3. The **policy format** is now `enclave-lease16-backward-history-policy/v2`, with two new required keys: `rawTransactions` (`debug` | `per-index`) and `receiptConcurrency` (1..8). Any template or test fixture that builds an r2 v1 policy must be updated; v1 is refused.
4. The header cache files are now `headers-<chunk>-<lo>.json` (lean). Old `headers-<lo>.json` files are ignored, never read; delete them manually.
