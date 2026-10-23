# RESULT: the stale generated site artifacts reconciled with the reviewed source (E, 2026-10-23)

## Final source

| | Commit | Tree |
| --- | --- | --- |
| Base | `ae00cd9659e46e3dffe5407bdf34442416a9e69a` (root-reviewed) | `5159185616aa0600be92cb9d3308645ad59b4cf3` |
| Head | **`ff13ebe089f3c18a064892269c55ddca2b4409e9`** | **`1cece8e6571631ab23ca8403c706ee5166c69c64`** |

- **Location:** branch `site-generated-artifacts-reconcile` in `work/site-generated-artifacts-reconcile-20261023/repo`.
- **Identity:** SteveDeFacto (author and committer).
- **Scope:** one commit and three files, all expected; no other path changed.

| File | Before | After | Kind |
| --- | --- | --- | --- |
| `site/js/gen/contract-artifacts.js` | `032da2c9dce99a6f…` | `a7d54dd491b156c27bf9a40286870d36f5c048aeb85b63e5993cccc2a193fdc4` | generated |
| `site/css/site.css` | `623a302d5024e5f5…` | `ff2fef202094b87d8b0325614460e1d605d90dd689f740d4d8446c9f0e251bb7` | generated |
| `docs/generated-artifacts-provenance.md` | (new) | | report and recipe |

**Unchanged:** every `.sol` source, `contracts/*.abi.json`, the generator, build scripts, packages, lockfile and wallet
code.

**Not done:** no contract deployed, no on-chain action, no publish or upload.

**Preserved, immutable:** the earlier `ae00cd965` source, report `4beedc5`, its export and its build evidence in
`rpc-wallet-production-build-20261023/`.

**Read:** `effective-goal-requirements.txt`. Nothing in it bears on this scope.

**Root input:** none found in this workspace (no `ROOT-*.txt`).

## Classification of the two contract bytecodes: metadata only (`logs/a1.out`, 45/45 checks)

**Analysis method:**
- Compiled with exactly `scripts/build-contract-artifacts.mjs`'s solc input: solc-js `0.8.35+commit.47b9dedd` from the
  lockfile, evmVersion osaka, optimizer runs 200, `bytecodeHash: ipfs`; EnclaveProofOfTime also uses viaIR.
- Inputs: (a) the current source; (b) the old-history blob at `c2bc3cc6`, read-only from `work/enclave`.
- That blob is the only old version of each file whose authorized 2026-10-21 provider-name rewrite equals the current
  source byte for byte. Old sources: Registry `8cb2b52b…`, ProofOfTime `6ec89dc5…`. Current: `49dd6317…`, `12d67d9a…`.

**Results:**

| Check | EnclaveRegistry | EnclaveProofOfTime |
| --- | --- | --- |
| Changed source lines (all comment text, line count equal) | 8, 77, 406 | 465 |
| old-history source → **committed** bytecode, exactly | yes (8107 B) | yes (6940 B) |
| current source → **fresh build** bytecode, exactly | yes | yes |
| differing bytes, all inside the trailing CBOR metadata (ipfs multihash) | 32 | 32 |
| creation code without the metadata identical | yes | yes |
| runtime code without the metadata identical | yes (8079 B) | yes (6503 B) |
| embedded solc version | 0.8.35 both | 0.8.35 both |
| metadata JSON identical except source keccak256/URLs and NatSpec | yes; NatSpec differs only by the rewrite | yes; NatSpec unchanged |
| ABI: old compile = current compile = tracked `contracts/<Name>.abi.json` | 30 entries | 23 entries |
| artifact `sel`/`evt`/`ctor` exactly derived from that ABI | 22 fns, 8 events | 17 fns, 5 events |
| book key, schema, link refs, `runtimeBytes` unchanged | `registry` | `proofOfTime` |
| owner/admin/migration functions (state-changing) | `setCaps`, `setMeasurement`, `setPayoutWallet`, `setPrices`, `setProofKey` | `transferOwnership`, `acceptOwnership`, `setProofWindow` |

**The other 12 entries** are byte-for-byte unchanged, with the same names in the same order: AddressBook, AppCatalog,
Pay, Deployments, Connectivity, Availability, VerificationFees, Featured, Reviews, HostReviews, PaymentRouter and
CreditVaultFactory.

**Meaning:**
- The old artifacts carried metadata naming the pre-rewrite comment text.
- The new ones name the current reviewed text. The executable code, ABI and admin/ownership/migration controls are
  identical.
- **No new contract logic is blessed and no old source or brand text is restored.** The old text stays only in the
  gitignored `tmp/old-src/`. It appears nowhere in a commit, the report or `dist` (0 matches).
- These are console deploy inputs only. Deployed contracts and their on-chain code are untouched.

**"Name bindings":** each artifact key is the contract compiled from `contracts/<Name>.sol:<Name>` per the generator's
`DEFS`. The rebuild from the committed head reproduces the whole file byte for byte (`logs/verify1.out`), so every entry
equals fresh compiler output under its name.

## site.css (`logs/gen1-attempt2-script-checks.out`)

- **Only insertions:** exactly `.enc-pool .ap-badge{vertical-align:.1em;padding:.1em .45em;font-size:.6rem}` and
  `.enc-main .enc-pool .ap-badge:before{content:none}`.
- **Source:** `site/components/deployments/deployments.css` lines 99–100, from reviewed commit `f2f0b3880` (2026-10-17,
  Live enclaves pool pills). `main.css` imports that file.
- **Why the old file lacked them:** no later regeneration of `site.css` included them.

## Builds (the locked offline production build, `scripts/build-site.mjs` unchanged)

**Setup:**
- `unshare -r -n`: no network, so nothing could be downloaded or uploaded.
- npm cache in the workspace.
- Tooling: lockfile `9ada1611…`; esbuild 0.28.1; @tailwindcss/cli 4.3.2; solc 0.8.35; viem 2.53.1.
- Queue cap 768 MiB for all three jobs, against the measured 413 MiB peak.

**Generation from `ae00cd965`:**
- `gen1` attempt 1 failed before building: I had not yet copied the locked `node_modules` into this tree. Its log is
  kept.
- In `gen1` attempt 2 (peak 418 MiB) the build regenerated both files. Their bytes equal the previous `ae00` build-tree
  output and S's 349318a build.
- The same job's analysis reported 3 failures. All were mistakes in my checking script:
  - the generated artifact stores no `abi` field, only `sel`/`evt`/`ctor`;
  - Registry's `///` NatSpec text is part of the metadata JSON.
- With the script corrected, `a1` (peak 315 MiB) passed 45/45 against the saved generated file.

**Verification from the committed head `ff13ebe08` (`verify1`, peak 412 MiB):**
- The build leaves **both tracked files byte-identical**: `git status` is clean.
- `contracts/EnclaveRegistry.abi.json` `f7019cfa…` and `EnclaveProofOfTime.abi.json` `03d0e635…` are unchanged.
- The dashboard graph is still valid: 238 files, and `js/chunks/profile-broadcast-3WV7XJKR.js` is present.
- The footer stamp reads `ff13ebe0 · 2026-10-23`.
- No pre-rewrite literal anywhere in `dist`.

**dist compared with the reviewed `ae00cd965` dist:**
- The same 238 paths.
- 17 changed files, all HTML pages, each **only in the footer commit stamp**: `ae00cd96` became `ff13ebe0`; the date is
  the same.
- No JS, CSS, vendor, map, CSP or sitemap change. `csp-script-src.txt` (`b2373096…`) and `js/boot.js` (`3f98ea60…`) are
  identical. The previous dist already used the fresh generated outputs.

**Outputs:**

| Output | Value |
| --- | --- |
| `verify-tree/site/dist/` | the built site |
| `outputs/dist-manifest-ff13ebe0.sha256` | manifest, which names the actual head through the stamp; the manifest's own sha256 is `c8d289bb085b1edf9c2502c26e0a23295fef4bb7bfeaf39c5572bfee09c89669` |
| `outputs/site-dist-ff13ebe0.tar` | deterministic tar, sha256 `54a79ae673c93acf6675203be833bd41541c7cfb7097553146274a6b54f3613c` |

**Not rerun:**
- The 92-s built-browser behaviour test and other suites: per root, the wallet source is unchanged, and `dist` differs
  only in footer stamps.
- Go builds and image builds.

## Limits

- This is solc-js (Emscripten) only, with the generator's exact settings. It was not compared with forge/native solc
  outputs, which use other settings (`foundry.toml`) and are not what the console deploys.
- Old-history provenance relies on `work/enclave`'s object `c2bc3cc6`, read with `GIT_OPTIONAL_LOCKS=0`; that tree was
  not touched.
- The metadata IPFS multihash was not resolved over IPFS (no network). The JSON it hashes was compared structurally.

## Export for D (source only; `exports/`)

- `patches/0001-*.patch` (`git format-patch ae00cd965..ff13ebe08`).
- The bundle `ae00cd965..site-generated-artifacts-reconcile` (needs `ae00cd965`).
- `NOTE-FOR-D.txt`, with the apply and restore recipes, and `SHA256SUMS`.

The patch-apply tree check and the scans are in `logs/s1.out`.

**Restore (undo) recipe:**
`git checkout ae00cd965 -- site/js/gen/contract-artifacts.js site/css/site.css && git rm docs/generated-artifacts-provenance.md`

## Not duplicated (other owners)

- S: public RPC methods and TLS.
- P: the Alto bundler.
- A: the hosted credit-vault verifier.
- F: the Safe-startup fixture moderation (7/7, pending final).
- M: startup cleanup.

## Root activation (not performed)

1. Review `ff13ebe08` together with `ae00cd965`.
2. Integrate.
3. Rebuild offline on the release machine and compare against `outputs/dist-manifest-ff13ebe0.sha256`. Only the footer
   date can differ, if built on another day.
4. Publish through the reviewed site-release path with the owner's approval.

Admin-console contract deployments from the new artifacts are a separate admin action; none is implied.
