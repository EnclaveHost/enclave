# Lease-generation ledger (rev 17): deployable candidate, tests and migration plan

**Status.** A deployable reviewed-source candidate is implemented and tested in the isolated
`work/lease-generation-candidate/`.

- **Not deployed:** no chain writes, no funding, no real keys, no commits.
- **No shared source edited:** no shared contracts, CLI, supervisor or browser file was touched.
- **Not yet claimable:** nothing here may be called "live" or "verified on chain" until it has actually been
  deployed and independently source-verified.

Interface for the JS work: `work/lease-generation-interface.txt`.

**Main repo HEAD:** observed as `abe862628e5d6cef1d64b08bd3d7ffdfd473eab3`, not the `45801c22` named in the
request. Main's `contracts/` were clean.

## 1. Authoritative source

| Item | Value |
|---|---|
| Live ledger | `0xb1783b61…117b`, runtime 24,368 B, codeHash `0x71d50076…6682` (source-verification manifest) |
| Source | commit `4b7419bb0955…`, `contracts/EnclaveDeployments.sol`, git blob `3f3d2c3ac155…`, sha256 `2771a5248ed7…1cd1` |
| Origin | `git cat-file` from the full local clone `/home/steven/Projects/enclave` (read-only; `work/enclave` is shallow and lacks it). Blob id and sha256 both re-checked. |
| Compiler | solc-js 0.8.35 (`node_modules/solc/soljson.js`, sha256 `fa4345d6…` = manifest), optimizer runs 1, viaIR, unit `EnclaveDeployments.sol` |
| Baseline | `scripts/build.mjs` rebuilds rev 16d and, with the manifest's immutables and library link filled in, hashes to the **live codeHash**. The library also matches its live codeHash (`0x28a6f461…`). The pipeline reproduces the deployed bytes exactly. |
| `deploy/ledger/EnclaveDeployments.sol` | sha256 `9ad2bd38…`, blob `1cacbaa3`: **not** rev 16d (the older rev-15d-plus-delegates source). Not used. |

### Inventory: main vs live vs candidate

- **Main's ledger** (`work/enclave/contracts/EnclaveDeployments.sol`, blob `75d117cb`) is byte-identical to
  `0c8c0990b` (TUNA dual-signed settlement), the parent of 16d.
  - It **lacks** live 16d's owner-approved delegates (`setDelegate`, `isDelegate` at slot 23, the delegate path
    in owner-gated calls and in `refund`).
  - It lacks 16d's EIP-170 moves of `refundableOf` and `ethCredit` into the library.
  - It has **no ledger feature that 16d lacks**: `git log c2bc3cc6 -- contracts/EnclaveDeployments.sol` ends at
    `0c8c0990b`, and `c2bc3cc6` is only the shallow-clone boundary.
- **The candidate** is rev 16d plus the lease surface. Every rev-16d function, event and slot is kept.
- **Main's newer decentralization and sealing work** (`GovernanceSeal`, sealing via
  `owner`/`pendingOwner`/`acceptOwnership`, wallet sessions through delegates) passes against the candidate
  (section 4).
- **No owner power was added.** `setGuardedReleaseOnly` is per-operator, about the operator itself. There is no
  new Enclave-wide veto; authority veto stays with wallet-owned hosts only.

## 2. Design

The mapping-based generation design follows `work/lease-epoch-proposal.txt`. The struct, `get()`/`getPage()`
tuple, `Claimed`, `Renewed` and `Released` are unchanged. `deploymentsSchema` is 17.

| Piece | Where | Behaviour |
|---|---|---|
| `_leaseGen` (slot 26), `_guardedReleaseOnly` (slot 27) | ledger state, declared after `importsSealed` | All 26 rev-16d variables keep their slot and offset; `isDelegate` stays at 23. Checked by `build.mjs` against the compiler layout. |
| `claim()` | ledger | `unchecked { ++_leaseGen[id] }` (2^64 claims is unreachable), then `emit LeaseOpened(id, enclaveId, g)` right after `Claimed`, so earlier logs keep their positions. |
| `release(bytes32)` | ledger-declared forwarder → library | rev-16d body, unchanged, unless the caller opted in: then reverts "guarded release only". |
| `releaseLease(id, runner, generation)` | library, via `fallback()` | Same body, only if caller == runnerOperator ("not runner") and runner and generation are current ("not this lease"). |
| `leaseOf(id)`, `guardedReleaseOnly(op)`, `setGuardedReleaseOnly(bool)` | library, via `fallback()` | One-block lease identity; the operator's own opt-in, with an event. |
| `fallback()` | ledger | DELEGATECALLs the **link-time** `EnclaveLeaseGeneration` address. No setter, admin or upgrade; non-payable. An unknown selector reverts with empty data, as in rev 16d. |
| `EnclaveLeaseGeneration` | new linked library (2,095 B) | Stateless. Explicit storage layout through constants (`_deployments`=12, `_exists`=13, `_earn`=15, `earned6`=17, `provenUntil`=19, generation=26, guard=27), each checked against the compiler layout; a wrong slot fails the build (verified by mutant). Credits through `EnclaveLedgerBandwidth.credit`. Reads `proofRequired()` by STATICCALL to the ledger itself. Direct CALLs are refused by the viaIR library guard (tested). |
| `EnclaveLedgerBandwidth` | unchanged source | Executable bytes (CBOR excluded) equal the **live** library's, so the deployed `0x3dfee18b…` could be linked as-is. |

**Why the fallback.** Measured byte costs on the first, inline candidate (24,927 B, 351 over the limit):

| Piece | Bytes |
|---|---|
| `releaseLease` entry point | 220 |
| guard setter + getter | 215 |
| `leaseOf` | 129 |
| `LeaseOpened` in `claim` | 72 |

Moving the whole lease-release surface, including the old release body (344 B), behind one fallback into a
linked library gives a ledger smaller than rev 16d.

**Source compatibility.** `release(bytes32)` stays ledger-declared so Solidity callers typed
`EnclaveDeployments`, and the solc ABI, keep it. The other four functions are reached through
`IEnclaveDeploymentsLeases` or the combined ABI `out/EnclaveDeployments.external-abi.json` (128 entries).

### Sizes (soljson 0.8.35, runs 1, viaIR)

| Contract | Runtime | Initcode |
|---|---|---|
| Live rev 16d ledger | 24,368 (208 headroom) | 25,305 |
| **Candidate ledger** | **24,314 (262 headroom)** | 25,251 (EIP-3860 limit 49,152) |
| `EnclaveLeaseGeneration` (new) | 2,095 | 2,127 |
| `EnclaveLedgerBandwidth` (unchanged) | 3,710 | 3,742 |

- Compile peak: 328–342 MiB under `memory-guard`.
- Unlinked runtime keccak: ledger `0xfe3d52c8…6347`, generation library `0xc75dd080…0444`, bandwidth library
  `0x5fdd2235…4ab2`.
- On Anvil, the linked ledger's codeHash was `0xbb07e50b…8a52` (address-specific).

### Gas (forge, identical state, rev 16d → candidate)

| Path | rev 16d | Candidate | Delta |
|---|---|---|---|
| First claim (new generation slot + log) | 106,128 | 128,345 | +22,217 |
| Re-claim | 81,409 | 83,745 | +2,336 |
| Renew | 33,417 | 33,348 | −69 |
| `release` vs `releaseLease` (fallback/library hop) | 9,010 | 12,844 | +3,834 |
| Legacy `release(id)` | — | 11,670 | — |

Anvil receipts: claim 209,141 and `releaseLease` 58,539 (cold, end to end).

## 3. Test evidence

Every heavy job ran in the foreground under `work/enclave/test/helpers/memory-guard.mjs` (768 MiB tree cap,
16 GiB floor), one at a time.

- Logs: `lease-generation-candidate/out/forge/*.log`, `out/forge/summary.txt`, `out/forge/guard.log`.
- Peaks: 294–652 MiB. Host minimum available: ≥ 16,970 MiB.
- Compilation runs per test file, so each import closure stays under the cap. A whole-project compile needs more
  than 768 MiB (728 MiB solc alone, stopped by the guard); that run was not attempted under a higher cap.

| Suite (project) | What | Result |
|---|---|---|
| `scripts/build.mjs` | Live-bytes baseline, sizes, storage layout, explicit slots, ABI superset, selector collisions, library identity | **exit 0**: baseline match (ledger and library), 0 slots moved, delegates at 23, no ABI entry missing |
| `EnclaveDeployments.leaseGeneration.t.sol` (new) | Monotonic generations, renew stability, wrong runner/generation/caller/id, same-block re-claim at identical `leaseUntil`, duplicate and delayed releases, opt-in incl. multicall, tail refund and credit, imports start at 0, fallback reach, library guard, lapsed lease | **12/12 pass** |
| `EnclaveDeployments.rev16dDifferential.t.sol` (new) | Live rev 16d vs candidate side by side, identical calls: success, return/revert data, every log (except additive `LeaseOpened`), ETH and token flows, every deployment view, earnings, bonds, globals after **every step**. Fixed scenarios plus `testFuzz` (256 runs × 40 random steps over 22 ops), a coverage test proving every op really succeeds, and gas deltas | **9/9 pass** |
| `4b7419bb` authoritative suites vs candidate (13 files: 11 ledger, VerificationFees, Connectivity) | Unchanged tests from the live build's commit | **201/204 pass** — see note below |
| `SessionVaultDelegate16d.t.sol` (4b7419bb, `forge-sessions`) | Wallet sessions through ledger delegates; reads `isDelegate` from **slot 23** | **6/6 pass**. Only change: `SessionRig` extracted verbatim from `SessionVault.t.sol` and imported from there (782 MiB otherwise) |
| Main `GovernanceSeal.t.sol` + `GovernanceSeal.hosting.t.sol` (`forge-main`, main sources) | Sealing the ledger's governance; real registry and prover | **6/6 + 1/1 pass**. `GovernanceSeal.liveFork.t.sol` not run (needs a public RPC fork) |
| `scripts/anvil-smoke.mjs` (Anvil 1.7.1, **default 24,576-byte limit**) | See below | **pass** (`out/anvil-smoke.json`) |
| Mutants (scratch copy in /tmp, deleted afterwards) | Tail not refunded; generation unchecked; guard ignored; wrong explicit slot; credit after clear | **5/5 killed**; the wrong slot is also refused by `build.mjs` |

**The three failing authoritative tests** (`test_schemaIsThirteen`, `test_schemaMarksTheFreeHostingSurface`,
`test_schemaMarksTheTransferSurface`) are exactly `assertEq(deploymentsSchema(), 16)`. The schema bump to 17 is
intended, and clients gate on `>=`. Nothing else failed.

**The Anvil smoke run:**
- the node refuses a 24,577-byte runtime and accepts 24,576;
- the ledger and both libraries deploy, and the ledger's on-chain code equals the soljson artifact with exactly
  its links and two immutables filled in;
- **one mined block** holds claim (generation 1), `releaseLease(1)`, re-claim (generation 2, identical
  `leaseUntil` 1792473924) and the stale `releaseLease(1)`: success/success/success/**reverted "not this
  lease"**, and lease 2 survives;
- after opting in, the legacy `release` reverts "guarded release only", the named release succeeds, and another
  key is unaffected.

**Measured caveat:** `forge test` does **not** enforce EIP-170 (a 24,577-byte runtime deploys in its EVM). The
forge suites therefore assert `code.length <= 24576`, and the real-limit deployment proof is the Anvil run.

**Not covered:**
- `fundWithAuthorization` (`MockUSDC` has no EIP-3009);
- a Base-fork rehearsal against live state;
- the remaining `SessionVault.t.sol` suites (only the rig was compiled);
- main's own copies of the ledger tests (the `4b7419bb` copies ran instead; main's ledger is a subset).

## 4. Migration plan

A new ledger is **not an in-place upgrade**. Repointing the address book alone does **not** migrate independent
clients, immutably bound contracts, balances or grants.

### 4a. Immutable dependents (from the reviewed authority profile)

Each binds `0xb1783b61…` and needs a **new deployment** bound to the new ledger, a new profile entry and
independent review:

| Dependent | Binding | Consequence |
|---|---|---|
| `proofOfTime` `0x6f462d77…` | `immutable.deployments` | New `EnclaveProofOfTime(newLedger, registry)`; `newLedger.setProver(new)` (one-shot). Checkpoint history stays with the old pair. |
| `verificationFees` `0x87c72665…` | `immutable.ledger` (+ proof) | New fees contract; `newLedger.setFeeRouter(new)` (one-shot). Per-payer `VerificationFeeWallet` balances remain on the old instance (controller-only); list and settle them there. |
| `connectivity` `0x5f8b636e…` | `immutable.ledger` | New connectivity; `newLedger.setBandwidthRouter(new)` (one-shot). It can stay unset at cutover (billing off), as the 16d plan did. |
| `pinnedSessionAuthority` `0xf76a138c…` | `immutable.deployments` | New authority, and therefore a **new `sessionVaultFactory`** (`0xec9277a3…`, `immutable.authorityPins`); the authority and factory pin each other (deploy with predicted addresses). Owners create **new vault clones**; old vault balances leave by **owner-wallet** withdrawal. |
| `secretVaultV2` `0x56b81b39…` | `immutable.deploymentLedger` | New vault; secret and custody records re-established by their owners/custody flow on the new instance. |
| `legacySessionVaultFactory` / implementation | mutable `EnclaveAddressBook` | Follows the book repoint, but its delegate grants do not exist on the new ledger (4b). |
| Pins: `contract-pins-base.json`, `independent-authorities-base.json`, `network-profile-base.json` (new digest), `source-verification-base.json` (new `ledger-rev17` build) | — | Reviewed pin changes. Independent hosts and CLIs adopt them only after their own source check. **No source claim before the deployed bytes verify.** |

`appCatalog`, `registry`, `hostOwnership`, `paymentRouter`, `enclavePay`, `keyAttestations` and `usdc` do not
bind the ledger and stay.

### 4b. State that does not move by itself

| State | Path |
|---|---|
| Records (owner, appRef, shares, rate, balance6, spent6) | `importDeployments` verbatim (leases reset), plus `importFees` / `importEarn` / `importCaps`, then `sealImports` — the admin-console migration engine (`site/components/admin-console/migrate.js`), as `migrate-ledger-16d.mjs` does. Generations start at 0. Tested on the candidate vs 16d. |
| Runner escrow (real USDC) | Stays in the old ledger. After `retire()`, a **permissionless** `refund` sweep returns each record's owner escrow. Re-backing on the new ledger is `fundEscrow` while imports are open (credits `ownerEscrow6`) and needs **real USDC from the migrator**: a funding step, not done here. |
| `earned6` (operators) | Stays withdrawable on the old ledger forever (`withdrawEarnings`). |
| Bonds | Old: `requestBondExit` / `withdrawBond` (not blocked by retire). New: operators re-post if a bond is required. |
| Delegates (`isDelegate`, slot 23) | **Not importable by design.** An admin import would assert authority over users' delegates. Each owner re-signs `setDelegate(vault, true)` on the new ledger. Until then their wallet sessions cannot act on wallet records there. |
| Job-rate offers | Not migrated; operators re-offer (offers expire anyway). |
| `provenUntil`, meters | Reset (leases do not migrate). |
| `guardedReleaseOnly` | Starts false; each operator opts in after its whole fleet runs a rev-17-aware supervisor. |
| Ledger ownership | New ledger deployer → governance (`setOwner` / `acceptOwnership`) → optionally `GovernanceSeal` with a full getter set (tested sealable). |

### 4c. Reversible preparation vs final activation

| Phase | Actions | Reversible? |
|---|---|---|
| **Prepare** (migrator key, no live effect) | Deploy `EnclaveLeaseGeneration` (link the **existing** verified bandwidth library `0x3dfee18b…` — identical executable — or deploy a fresh one), the ledger, prover, fee router, connectivity, pinned authority and factory, new secret vault; copy owner parameters; import plus delta import; field-by-field verify; publish the source-verification build and candidate profile for **independent pin review**. | Yes: abandon the new contracts; the live ledger is untouched. |
| **Governance activation** (wallet-signed) | Old `retire()` (**one-way**); final delta import; `sealImports` (one-way); `setProver` / `setFeeRouter` / `setBandwidthRouter` (one-shot each); ownership to governance or seal; address-book repoint; new profile digest published. | No. |
| **Per-wallet activation** | Owners re-grant delegates, create new vaults and move vault funds; operators upgrade supervisors, then `setGuardedReleaseOnly(true)`; anyone may run the permissionless old-ledger refund sweep. | Each wallet's own. |
| **Clients** | Supervisor and CLI feature-detect `deploymentsSchema >= 17` (interface §5–6). Independent clients switch only via their reviewed pin change. | — |

## 5. Remaining blockers (exact)

1. **A `migrate-ledger-17` tool does not exist.** It would adapt `scripts/migrate-ledger-16d.mjs` (4b7419bb):
   link two libraries, refuse a build whose slots 23/26/27 differ or whose schema ≠ 17, and deploy the dependent
   set in 4a. No fork rehearsal against Base state has been run.
2. **No dependent-contract builds exist** for prover, fees, connectivity, pinned authority/factory and secret
   vault v2 bound to a new ledger address, and no review entries for them.
3. **Supervisor and CLI changes** (interface §5–6) are owned by the move worker.
4. **Unknown readers of the solc ABI JSON:** any reader using the ledger's solc ABI JSON must switch to the
   combined external ABI for `releaseLease`, `leaseOf` and the guard; the generated site and CLI artifacts are
   not updated.
5. **Deployment, funding (escrow re-backing), governance signatures, wallet re-grants and independent pin review**
   all need live wallets and chain writes: out of scope here, and not done.
6. **The three schema-equality authoritative tests** need their expected value updated to 17 when the candidate
   lands in shared source; the owner of `contracts/foundry/test` does that.

## 6. Constraints kept

- Only `work/lease-generation-candidate/`, `work/lease-generation-interface.txt` and this report were written.
- The shared tree was only read; `node_modules` and the full clone were used read-only.
- No commits, deployments, funding, real keys, SSH, GUI or Wine.
- Anvil used its public dev mnemonic and was stopped. The other Anvil processes on the host belong to other
  workers and were left alone.
- No background work remains.
- The host-onboarding files from the previous task were left frozen.

## 7. Hash inventory (sha256)

```
2771a5248ed7a68f5521b08dbde466603b02c29ccd961d55fd9eceabe1d11cd1  authoritative/EnclaveDeployments.rev16d.sol (blob 3f3d2c3a)
7e86f7817f4646ddae6d7d4d44052a3897fbc9f9815187f946bc702fca0c1acb  src/EnclaveDeployments.sol (blob 10a76bf5)  <- the tested source
80b43f25c0bf5e2b4aa610e57528412eb1f901320fde257610e983fc688c5186  scripts/build.mjs
53a50978b1dbc21f78d47f3cce5d1574975e2c54bc6dc552816e0b5884b9894a  scripts/anvil-smoke.mjs
a474aba7ec750eeb872daf31666eb6adf0c547685bc50b92e196e2d56649255e  scripts/forge-groups.sh
a35f9ec3cf8829ac376dbf6f6901a4bfb96e56f76787477641e5dff50f6acd19  scripts/size.mjs
24748acc9e6b6ab8b0b29f823bbec3bea33f2598af1ded8a67b4fcf8426598c2  forge/foundry.toml
418311185e6d2a2a8da3e398ca193660a1dfb2e213aed431b78f2eb76a00c7c3  forge-sessions/foundry.toml
a9caa3d019220482e6fbff3dfa0f4feb7c389a0bc57f42b70f2b65ab3b69f9a6  forge-main/foundry.toml
44a2614ebbc5029ec1749e0390314941a7c7e47e124e76759a815eba86079c00  forge/contracts/foundry/test/EnclaveDeployments.leaseGeneration.t.sol
a7dda5684a0f8922a3e44cf3ad2ce718b69016821cfb6e813fd10194341ffc81  forge/contracts/foundry/test/EnclaveDeployments.rev16dDifferential.t.sol
dc91baa93990c09e54d821d8d1a6e0bee9d98241fa251db4b7a1ae2f6ddb64c4  forge/contracts/foundry/test/LeaseRig.sol
c2cd4501ffe6d1512a1919f3fc452d754f98b1ef5f5eaa596ab606fcb1627fe2  forge-sessions/contracts/foundry/test/SessionRig.sol
3989ddffd2253ad4306d92223f0ed32b50d01feb1d6fd3dc98571644d20a698d  forge-sessions/contracts/foundry/test/SessionVaultDelegate16d.t.sol (import line only)
e9eeae71c032d18e01ecca7204c64b64ce7ad52b66778bb06912b841fc53bce0  forge-main/contracts/foundry/test/SessionRig.sol
40b788b0f17edf88db04fe4516129ec07a3b027a185af0f5fe16444049c3b06b  forge-main/contracts/foundry/test/GovernanceSeal.t.sol (import line only)
83b43f9ee309365177862b48e918121b296909d335d465ad4ee87641d89ba780  out/build-report.json
bf22cf17b75f622ecb1d6a5060e6d28597ae94944e0560f8dfedb8195624b0aa  out/EnclaveDeployments.json
b40eca47aa4b11ad75c0af0bac5dff0cfef6b6407c2a15b30ccb9d41f8639e65  out/EnclaveLeaseGeneration.json
eabd3966d9ccddec4a1ebbe37058ddebcc8c949b2e0e76dbf356af7b768792c7  out/EnclaveLedgerBandwidth.json
06bf3de7faf679be6d44f18b63115066a227872f074c58e79c4f047a354754a5  out/IEnclaveDeploymentsLeases.json
761a16ea6d110a8926ad98495fdce47f7c31d6162e663302b3922194cbfc9c6f  out/EnclaveDeployments.external-abi.json
df664004b358992e0e7891fbf56fe2568c824639b4534c96dc4073efceb55931  out/anvil-smoke.json
```

All paths above are relative to `work/lease-generation-candidate/`.

- The other `forge/contracts/*.sol` files and the authoritative tests are verbatim copies from commit `4b7419bb`
  (`git archive`); in `forge-main`, they are copies of main at `abe86262`.
- The candidate ledger and rev 16d enter each project by symlink to the two source files above.
