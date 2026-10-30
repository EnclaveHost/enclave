# reader-runtime-composition-stage: FINAL (integration preparation; offline composition qualification PASS; no SNP / positive-derivation / production claim)

**Stage:** `reader-runtime-composition-stage/`, `SHA256SUMS` **`902786cd2709c1b41716d9cac71b861a016bba06464dfba4dadae26b53da8853`**. The private `git/` (alternates only) and `logs/` are excluded from the sums.

**Read-only inputs:** `source/` (a worktree of `/home/steven/Projects/enclave`, HEAD 8594bc1ee255, tracked files clean) and `rpc-final-candidate-20261026/tree` (= 64156dcd, tracked files clean). Neither was written: the job uses `--no-optional-locks`, and git objects are read through alternates. No commit was made.

## Exact pins
| Item | Pin |
|---|---|
| base candidate | `64156dcd91ff1e769e74f9c26a846be19254c716` |
| KVM reader commit | `c66b087acca2bed00e0232f97f990a201852faea` (chain 64156dcd → 903f107b1 → cc8c9bd4f → c66b087ac) |
| **composed tree** | **`1df125598825fb5278fe6af96a50a69b46679a1c`** = base + exactly 27 additions (each c66's blob; listed with mode and origin in `COMPOSITION.json`) |
| `composition.patch` | `git diff --binary --full-index 64156dcd c66b087 -- <27 paths>`; applying it to a clean base export reproduces the tree byte-for-byte |
| node_modules | the candidate checkout's, LINKED (not copied); lock sha256 `9ada1611…` == the composed `package-lock.json`; viem 2.53.1; node v22.23.3 |

## Files (by actual imports)
- **Reader (21):** `network/derived-reader/**` from c66: `api`, `journal`, `l1-runtime`, `libraries`, `lifecycle`, `main`, `native`, `process`, `proof`, `provider`, `rpc`, `vendor/{a1-anchor,anchor-bootstrap,schedule-input-r2,schedule_reader}.mjs`, `vendor/provenance.json`, `config.example.json`, `qualification.json`, `README.md`.
- **Reader tests (4):** `test/derived-reader.test.mjs`, `test/derived-reader/{boundaries,provider}.test.mjs`, `helpers.mjs`.
- **Lifecycle closure (4)**, needed only because the boundaries test and the optional `lifecycle.mjs` import them:
  - `network/lifecycle-finality-bridge.mjs` (cc8c9bd4);
  - `network/deployment-lifecycle-journal.mjs` (consumer-exclusive journal interface; c66 = cc8 content);
  - `network/deployment-restart-policy.mjs` (903f107b, a leaf);
  - `test/lifecycle-finality-bridge.test.mjs` (cc8c9bd4; the 4 bridge tests).
- **Reused from the base, blob-identical:** `lease-release-journal`, `runtime-lock`, `rpc-runtime`, `gossip-head-source`, `op-head-relay`, `verified-chain`, `package.json`, `package-lock.json`.
- **Excluded (32 other files in 64156dcd..c66b087):** the lifecycle docs (`deploy/lifecycle/*`), `deployment-journal-owner.mjs`, the deployment scripts and tests, and other lifecycle contracts. They are listed in `COMPOSITION.json`.
- **Not added:** no native binary (the tests use transport fixtures: `process.execPath` as the fake L1, a `cat` echo native), no `node_modules` copy, no operator config.

## Qualification
- **Job:** `jobs/root-reader-composition.sh`, shared queue 768, `unshare -Urn`, run synchronously and finished.
- **Receipt:** `logs/claude-reader-composition-1.out` (sha `9a7d6f59…`, rc 0).
- **Results:**
  1. The composed tree is reproduced from the read-only source objects (`1df12559`).
  2. The patch on a clean base export equals the composed tree.
  3. **No pre-existing file references the new modules**, so production defaults are unchanged and nothing is enabled.
  4. Module closure: 109 imports in 23 modules all resolve inside the composed tree; the bare specifiers are only `node:*` or viem.
  5. `node --check` passes on every module, and the runtime import load passes (provider, lifecycle, api, bridge, journal).
  6. **KVM's final tests: 20/20** (TAP `# tests 20 # pass 20 # fail 0 # cancelled 0 # skipped 0 # todo 0`) = reader 16 + bridge 4.

**Root may re-run:** `./jobs/q-exit-status.sh reader-composition-1 768 unshare -Urn bash reader-runtime-composition-stage/jobs/root-reader-composition.sh`.

## Follow-up slot and boundaries
- **v3 (KVM reader V3 R2/R3):** the next composition replaces exactly `network/derived-reader/**` (+ its tests) on top of `1df12559`, by the same base+blobs mechanism. The v2 journal import (`journal.mjs` → `lease-release-journal`/`runtime-lock`) is preserved; no v3 journal is added or duplicated here.
- **Untouched:** admin controls, the relay writer (Claude50), the paid-provider paths (Claude370), and the production defaults and resource config.

## Remaining (not done here)
1. **Root review** of the composed tree / patch.
2. **The real candidate step:** materialising `1df12559` as root's new candidate, and committing it (root's decision).
3. **Reader v3 composition** when KVM's R2/R3 is ready.
4. **Live/positive work** is outside this stage: L1 schedule, native derivation, accepted-image/SNP qualification, and production activation and config.

No SSH, network, production, wallet, resource-config or commit action. No Claude background job is left running.
