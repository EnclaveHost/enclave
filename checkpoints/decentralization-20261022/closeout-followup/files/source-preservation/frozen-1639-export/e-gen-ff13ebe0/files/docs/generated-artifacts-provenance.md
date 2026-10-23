# Generated site artifacts: provenance of the 2026-10-23 reconciliation

`site/js/gen/contract-artifacts.js` and `site/css/site.css` are generated: `scripts/build-site.mjs` regenerates both
before every bundle. Both were committed stale. This commit replaces them with exactly what the locked offline
production build regenerates from the reviewed source. No `.sol` source, no ABI file, no generator and no build script
changed.

## site/js/gen/contract-artifacts.js: two deploy bytecodes, metadata only

The `bytecode` of **EnclaveRegistry** and **EnclaveProofOfTime** was compiled from those contracts' sources as they
were before the authorized 2026-10-21 provider-name history rewrite, which changed only comment text.

**Commits and source.**
- Last regenerated in `87d6bbd0f` (2026-10-05).
- Neither `.sol` file changed in this history since then.
- Each old source is the old-history blob at `c2bc3cc6`: Registry sha256 `8cb2b52b…`, ProofOfTime `6ec89dc5…`. Under the
  rewrite each becomes the current source byte for byte: Registry `49dd6317…`, ProofOfTime `12d67d9a…`.
- Changed lines are comment text only: Registry lines 8, 77 and 406; ProofOfTime line 465.

**Compiler and settings** (the generator's own input):
- solc-js 0.8.35+commit.47b9dedd, evmVersion osaka, optimizer enabled with runs 200, metadata `bytecodeHash: ipfs`.
- ProofOfTime additionally uses viaIR.

**Classification:**
- The old-history source compiles to the old committed bytecode exactly. The current source compiles to the new
  bytecode exactly.
- Old and new differ in 32 bytes, all inside the trailing CBOR metadata, i.e. the IPFS multihash of the metadata JSON.
  The embedded `solc` field is 0.8.35 in both.
- With the metadata removed, the creation code (Registry 8107 bytes, ProofOfTime 6940 bytes) and the deployed runtime
  code (8079 and 6503 bytes) are identical.
- The metadata JSON differs only in the source keccak256 and URLs, and, for Registry, in NatSpec text that differs by
  the same rewrite.
- The ABI is identical across the old compile, the current compile and the tracked `contracts/<Name>.abi.json`:
  Registry 30 entries; ProofOfTime 23 entries.
- So are the artifact's selectors, events, constructor inputs, `runtimeBytes`, book key (`registry`, `proofOfTime`),
  schema fields and link references.
- The owner/admin surface is unchanged:
  - Registry: `setCaps`, `setMeasurement`, `setPayoutWallet`, `setPrices`, `setProofKey`.
  - ProofOfTime: `transferOwnership`, `acceptOwnership`, `setProofWindow`.
- The other 12 artifact entries are unchanged.

**What changes in practice:** a contract deployed from the admin console with the new bytecode carries metadata that
points at the current source text instead of the pre-rewrite text. Its executable code is the same. **Deployed
contracts are not affected and nothing is deployed by this change.**

## site/css/site.css: two rules

Two rules are inserted, and nothing else changes:
- `.enc-pool .ap-badge{…}`
- `.enc-main .enc-pool .ap-badge:before{content:none}`

Both come from `site/components/deployments/deployments.css` lines 99–100, added in reviewed commit `f2f0b3880`
(2026-10-17, the Live enclaves pool pills). `site/css/src/main.css` imports that file. No later regeneration of
`site.css` picked them up.

## Recipe (offline; nothing downloaded, uploaded or deployed)

```sh
git worktree add --detach ../gen-tree <commit>
cp -a node_modules ../gen-tree/      # the lockfile's installed tree; package-lock.json sha256 9ada1611…
cd ../gen-tree
npm_config_offline=true unshare -r -n node scripts/build-site.mjs
# the two files above are now the regenerated ones; a rebuild from this commit leaves `git status` clean
```

Evidence (checks, hashes, logs): `work/site-generated-artifacts-reconcile-20261023/` (RESULT, `logs/a1.out`,
`logs/verify1.out`).
