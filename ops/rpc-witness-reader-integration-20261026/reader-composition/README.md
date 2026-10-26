# reader-runtime-composition-stage: KVM's committed reader runtime composed into the current candidate (PREPARED; integration preparation only)

**Inputs (read-only):**
- `source/`, a worktree of `/home/steven/Projects/enclave`;
- base candidate **`64156dcd91ff1e769e74f9c26a846be19254c716`** (tree in `COMPOSITION.json`);
- KVM reader commit **`c66b087acca2bed00e0232f97f990a201852faea`** (64156dcd → 903f107b1 → cc8c9bd4f → c66b087ac).

Nothing in `source/`, the candidate or KVM's tree is mutated. The stage's private `git/` uses source's objects as read-only alternates and holds only the composed tree objects. No commit is made.

**Composed tree:** **`1df125598825fb5278fe6af96a50a69b46679a1c`** = base + exactly 27 additions (each is c66's blob):
- **reader** (21): `network/derived-reader/**`, including `vendor/` (KVM's vendored reader modules with `provenance.json`), `config.example.json` and `qualification.json`;
- **reader tests** (4): `test/derived-reader.test.mjs`, `test/derived-reader/{boundaries,provider}.test.mjs`, `helpers.mjs`;
- **lifecycle closure** (4): required by actual imports only, since the boundaries test and the optional `lifecycle.mjs` import them:
  - `network/lifecycle-finality-bridge.mjs` (cc8c9bd4);
  - `network/deployment-lifecycle-journal.mjs` (the consumer-exclusive journal interface; c66 = cc8 content);
  - its leaf `network/deployment-restart-policy.mjs` (903f107b);
  - the bridge's own tests `test/lifecycle-finality-bridge.test.mjs` (cc8c9bd4).

**Excluded:** the other 32 files changed in 64156dcd..c66b087, including the lifecycle docs, `deployment-journal-owner.mjs`, deployment scripts and tests, and every other lifecycle contract (listed in `COMPOSITION.json` `excludedFromC66Range`).

**Reused unchanged from the base** (blob-identical in c66): `lease-release-journal`, `runtime-lock`, `rpc-runtime`, `gossip-head-source`, `op-head-relay`, `verified-chain`, and `package.json`/`package-lock.json` (viem 2.53.1).

**`composition.patch`:** `git diff --binary --full-index 64156dcd c66b087 -- <the 27 paths>`. The job applies it to a clean base export and requires the composed tree byte-for-byte.

**Production defaults:** unchanged. No pre-existing file references the new modules (checked by the job). The reader is not started, configured or enabled anywhere. Existing admin controls, the relay writer (Claude50) and the paid-provider paths (Claude370) are untouched. No `node_modules`, binary or operator config is copied; the job links the candidate checkout's `node_modules` read-only after identity checks. The tests need no native binary (transport fixtures only).

**v3 follow-up slot (KVM reader V3 R2/R3, in progress separately):**
- A later composition replaces exactly the files under `network/derived-reader/**` (+ its tests) by the same mechanism: base = THIS composed tree, the listed blobs from the v3 commit.
- The v2 journal import (`network/derived-reader/journal.mjs` → `lease-release-journal.mjs`/`runtime-lock.mjs`) is preserved here unchanged. No v3 journal is added or duplicated.

**Qualification** (root): `jobs/root-reader-composition.sh` (tree reproduction, patch, defaults, module closure + syntax + import load, KVM's final 20 tests).
```
./jobs/q-exit-status.sh reader-composition-1 768 unshare -Urn bash reader-runtime-composition-stage/jobs/root-reader-composition.sh
```
**Not claimed:** no SNP, no positive Base derivation, no production activation.
