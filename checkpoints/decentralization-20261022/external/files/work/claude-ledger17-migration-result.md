# Ledger rev 17 migration: tooling, dependent builds, fork rehearsal, unsigned plan

**Status:** the cutover tooling is implemented, every dependent contract is rebuilt from verified source and proven
against live Base, and a full fork rehearsal passes. An exact unsigned plan for owner signing is generated.

**Not done, by design:** nothing was signed, sent, deployed, funded, retired, repointed or sealed on Base. The
architecture is **not complete** until the owners actually activate it and an end-to-end proof on Base exists; this
rehearsal is evidence, not activation.

- **Frozen inputs, unchanged:** candidate source `7e86f781…0c1acb`; `work/lease-generation-interface.txt` `508e8263…`.
  No candidate defect was found, so the candidate was not changed.
- **Interface:** `work/ledger17-migration-interface.txt`.
- **Code:** `work/ledger17-migration/`.

## 1. What was built

| Piece | File | What it does |
|---|---|---|
| Live layer | `lib/live.mjs` | Allowlisted https endpoints only (`mainnet.base.org` and BlockPI for archive state, BlockPI and publicnode for logs). Read-method allowlist with no send or sign method. Chain id must be 8453. One pinned block, its number and hash agreed. Every state read must be byte-identical on both state endpoints (batched through Multicall3). |
| Fork layer | `lib/fork.mjs` | The only write path: its own loopback Anvil. Refuses unless the chain id is 31337 (so nothing signed there can replay on Base), the fork block equals the snapshot block, and the source is allowlisted. Uses public dev keys; impersonation is node-local. Every request has a hard timeout. |
| Gates | `lib/gates.mjs` | Retirement (G4), import only from a retired source, seal only at full parity, platform backing only after `sealImports`. Each refusal names the exact unmet condition. |
| State, import, parity | `lib/ledgerstate.mjs` | Batched record reader. A delta-resumable importer with the 16d engine's semantics (lease cleared, chunked by its calibrated gas model). Field-by-field parity including the DNS prefix reservation (slot 24). Old-ledger drift report. Per-record escrow conservation. |
| `snapshot` | `snapshot.mjs` | Read-only inventory at one agreed block (section 2). |
| `build` | `build.mjs` | Compiles every component with the pinned solc-js and proves it against live (section 3). |
| `rehearse` | `rehearse.mjs` | The whole cutover on the guarded fork (section 4). |
| `plan` | `plan.mjs` | The unsigned Base plan (section 5). |
| `verify` | `migrate-ledger-17.mjs verify` | Read-only: what of the plan exists on Base now, and whether the migrator's nonce has moved. |
| CLI | `migrate-ledger-17.mjs` | `snapshot`, `build`, `rehearse`, `plan`, `verify`, `status`. **There is no command that signs or sends to Base.** |

The tool builds on the authoritative 16d sources: `migrate-ledger-16d.mjs` at `4b7419bb`, with its import engine
`site/components/admin-console/migrate.js`. It keeps their ordering (the prover before the fee router, whose
constructor checks it), owner-parameter copy, import semantics and selector set.

It differs from 16d in one deliberate way. 16d imports during `prepare` and does a final delta later, but its engine
cannot update a record it has already imported, while renewals change balances continuously. rev 17 therefore
imports from **one final snapshot F taken after `retire()`**. It resumes by delta, and reports any owner edits made
on the old ledger after F as drift for the owners to re-apply.

## 2. Live inventory (snapshot block 52842154)

- Block hash `0xf830b937…`, snapshot digest `sha256:ab070277…`, 276 agreed reads.
- The reviewed authority profile digest `sha256:ee957827…` is checked first.
- Every profile contract's code hash equals the profile.

| Binding | Kind | Live state | Migration handling |
|---|---|---|---|
| Ledger rev16d `0xb178…` | — | 98 records: 27 active, 12 live leases, 13 holding escrow, 24 free. Holds **11.162250 USDC** = escrow 8.189446 + earnings 2.972804 + bonds 0 (**exact solvency**, so earnings-holder discovery is complete). Runtime balances total 65.64 USDC with a backing shortfall of 57.56 (inherited from earlier migrations). | Retired, then imported from F |
| Live bandwidth library `0x3dfe…` | stateless | Executable bytes equal the candidate's | **Reused** |
| ProofOfTime `0x6f46…` | immutable `deployments` | Owner: governance. 5,136 checkpoints. Window 900 s. | New prover, verified build |
| VerificationFees `0x87c7…` | immutable `ledger` | 2 fee wallets holding **5.959300 USDC**, bound immutably to the old ledger | New fee router; old wallets refunded via the payer's `revoke` (fork-checked) |
| Connectivity `0x5f8b…` | immutable `ledger`; **bound as the live bandwidth router** | 5 bandwidth splits; host/policy/attestation state | New connectivity with the live bootstrap signers, bound before sealing. Hosts and owners re-authorize on it (wallet actions). |
| PinnedSessionAuthority `0xf76a…` → pinned factory `0xec92…` | immutable `deployments` | 0 vaults created | New pinned factory, authority and implementation; live `SessionVaultLib` reused |
| SecretVaultV2 (pinned) `0x56b8…` | immutable `deploymentLedger` / book | No state (no events) | New vault: same `enclaveOwner`, **same `hostOwnership` `0xF5E9` kept** |
| Book: `reviews`, `hostReviews` | book-resolved `ledger()` | — | Follow the repoint (rehearsed) |
| Book: credit-vault factory; vault `0x081c…` (EIP-1167 clone, 23.93 USDC credit) | book-bound | Owns 1 inactive record | Follows the repoint |
| Legacy session factories v1 `0x00bB…` and v2 `0x1F5c…` | book-bound | 5 vaults. v1 ×4 hold 0 USDC. v2 vault `0xB794…` (owner governance) holds 0.42 USDC and owns 4 records. | Follow the repoint. Refunds pushed to the vault; its owner withdraws with its own signed operation. |
| Book-bound SecretVaultV2 `0xE486…` | book | 1 committee, 2 policies | Follows the repoint; deployment ids are preserved |
| Delegates (`isDelegate`, slot 23) | — | **0 live grants** (every `DelegateSet` pair and vault/owner pair read from storage) | None to re-grant at this snapshot; re-checked at F |
| Names (DNS label prefixes) | — | — | `importDeployments` reserves them: **99/99 verified in slot 24** |
| Operators | — | 3 hold earned6 on the old ledger; no bonds | Withdraw on old (never migrates, so never paid twice) |
| Owners | — | 9: 3 EOAs, 2 **EIP-7702-delegated EOAs** (`0x3977…`, 20 records; `0x271a…`, 2), 2 fee wallets, 1 session vault, 1 credit vault | All have a path. No record is owned by a contract unable to act. |
| Previous ledgers 15d `0x606C…` / pre-15d `0xb36D…` | retired | 4.667235 / 4.671277 USDC | Outside this migration; their own refund and withdraw paths remain |
| Availability (`EnclaveAvailability`) | — | Not deployed (absent from book and profile) | Nothing to migrate; would bind ledger17 if deployed |
| Host ownership `0xF5E9…` | registry-bound | — | Kept. **Wallet veto stays only on each owner's own hosts.** |

## 3. Builds proven against live (`build/`, one guarded job each, peaks 275–376 MiB)

| Component | Source | Proof |
|---|---|---|
| `ledger17` | Frozen candidate (sha checked); artifacts reused | Candidate report: baseline match, layout, ABI |
| `proofOfTime` | Manifest build at `44d5b928` (blob and sha256 checked) | Rebuilt with live immutables, hashes to the **live code hash**. The live deploy transaction `0xad6e2a…` = this initcode + args. |
| `verificationFees` | `28dd23c2` | Same proof; deploy transaction `0xd4b45c…` |
| `connectivity` | `4b7419bb` (connectivity + rev16d units) | Same proof; deploy transaction `0x6013fe…`; constructor signers decoded `[0x5714…848A, 0x033b…257B]` |
| `pinned` | Main sources (sha equal to `independent-authorities-base.json` at `d8fac3c4`) via main's `compileIndependentAuthorities` | Every live runtime matches (factory, authority, implementation, library, secret vault, host ownership) |
| `governanceSeal` | Main `contracts/GovernanceSeal.sol` | Not deployed anywhere; source hash recorded |

No new contract logic was needed. Every dependent is redeployed **byte-identical to its verified live build**, except
for the immutable slots that name the new ledger and prover.

## 4. Fork rehearsal (`rehearsal/52842154.json`)

- **Result: PASS.** 78 steps, exit 0. Peak tree RSS 517 MiB (Anvil 253 + Node 264); host minimum available
  17,590 MiB.
- **Fork:** BlockPI at block 52842154, chain 31337, loopback only.

**Prebuild and parameters**
- All new contracts deployed. Each runtime equals its verified artifact with exactly the expected immutables and links.
  The ledger is 24,314 bytes.
- All 11 owner parameters equal live. The prover, fee router and bandwidth router are bound.

**Race and retirement**
- Before retirement, an owner edit and a newly created record on the old ledger are both carried by F.
- `retire()` is impersonated. After it, renew reverts "retired".

**Import**
- F is taken at block 52842168 with 99 records.
- The import was interrupted after 10 of 21 batches. A seal at that point is refused (2 of 99 at parity).
- A replayed batch reverts "exists" and changes nothing.
- Resumed with 11 more batches: **99/99 field parity, 99/99 prefix reservations, 0 transactions left to plan**.
- An owner edit on the old ledger after F is reported as drift.

**Cutover**
- `sealImports`; ownership to governance and its acceptance.
- `book.setMany` repoints four keys; `reviews` and `hostReviews` now resolve ledger17.
- A release queued for an old lease lands after the cutover and leaves the new ledger unchanged.

**Escrow conservation**
- 13 settles and 4 refund pushes run as permissionless multicalls; owners receive **3.481152 USDC**.
- Governance sweeps **0.040068** to payout. Payout re-backs **0.004995** after the seal.
- An EOA owner moves its refunded 48,752 onto its own record, credited to it as owner escrow.
- Operators withdraw 2.974004 on the old ledger.
- **Net USDC change across all parties: 0.** No owner-refundable escrow on the new ledger beyond what the owner itself
  put in. Operator earnings on the new ledger: 0.

**Stuck escrow (measured, not assumed)**
- **4.667026 USDC** of the deployer's own non-refundable escrow (record `0x7c4149…`) cannot be recovered after
  retirement: `sweepEscrow` reverts "still fundable". This is a rev16d property.
- The plan's advisory gives the zero-loss option: serve that record out on the old ledger for about 10,101 s before
  retirement.

**Service and seal**
- A registered host (`nucbox-k11`) claims an imported record on ledger17 (generation 1) and calls
  `releaseLease(gen 1)`.
- `GovernanceSeal` is applied to ledger17 and prover17. `setLeaseSec`, `retire` and `setProofWindow` now revert
  "!owner". A deployment owner's `setConfig` and an operator's `setGuardedReleaseOnly` still succeed.

**Negative gates, all refused as designed**
- live write target;
- import before retirement;
- seal at partial parity;
- replayed import;
- stuck-escrow sweep;
- fork-guard tamper;
- **retirement refused without the client-readiness attestation**.

**Fee-wallet fork check** (`rehearsal/fee-wallets-52842154.json`): **PASS**, peak 287 MiB. After retirement the payer's
two `revoke` calls return **5.959300 USDC** to payout, and both wallets end at 0.

**Unit tests** (`test/migration.test.mjs`): **7/7 pass**, exit 0, peak 299 MiB. They cover:
- the endpoint and method guards;
- every gate;
- deterministic, resumable import chunking;
- parity catching every field;
- drift;
- conservation arithmetic;
- the fork guard refusing a non-fork node. Running this test caught and fixed a guard crash: the node was refused
  either way, but the guard now refuses explicitly.

The two earlier rehearsal hangs were caused by Anvil stalling on `mainnet.base.org` fork fetches. They were stopped,
and fixed by:
- the BlockPI fork source;
- hard timeouts;
- serialized reads;
- batched permissionless pushes.

## 5. Unsigned plan (`plans/52842154.plan.json`, sha256 `ca3b6936…2133`)

**Envelope**
- Chain 8453; `signedHere: false`, `sentHere: false`.
- 72 entries. Each records phase, signer role and address, to, data, value, target code hash or verified-build
  reference, preconditions, irreversible flag, rehearsal gas, a 1.3× gas limit, and an ETH upper bound (snapshot base
  fee 0.005 gwei + 0.001 gwei tip + `GasPriceOracle.getL1FeeUpperBound` at the snapshot block).
- Migrator chosen for the example: `0x120ba39e…` (the account that deployed live rev16d), live nonce 18. Every new
  address is predicted from it; `verify` showed nonce 18 still unchanged at block 52843742.

| Phase | Signer | Txs | Irreversible | Notes |
|---|---|---|---|---|
| P prebuild | migrator | 11 | 0 | Library, ledger17, prover, `setProver`, fees, `setFeeRouter`, connectivity, `setBandwidthRouter`, pinned factory, secret vault, `setProofRequiredFrom(live)` |
| A advisory | operational choice | 1 | — | The 4.667026 USDC stuck-escrow option |
| G1 | governance `0x0b2d…` | 1 | **`retire()`** | Pinned to old code hash `0x71d50076…`. Preconditions: G4 (verify, a fresh post-P rehearsal, client readiness, payout funds). |
| I import | migrator | 24 | `sealImports` | 21 import batches are **templates** regenerated from F after G1 (the tool refuses before retirement), then `sealImports`, `setOwner`, `transferOwnership` |
| G2 | governance / book owner | 3 | 0 | Two `acceptOwnership`; `book.setMany` (4 keys) |
| R | anyone | 2 | 0 | Settle ×13 and refund push ×4 multicalls, `notBefore` = leases lapsed + proof window |
| S | governance | 11 | 0 | `sweepEscrow` per sweepable record |
| B | payout | 7 | 0 | Approve **0.004995 USDC** + `fundEscrow`; precondition `importsSealed` |
| W wallet actions | payer / operators / owners / vault owner | 9 | 0 | 2 fee-wallet `revoke`s (5.9593 USDC to payout); 3 earnings withdrawals; 3 optional owner re-backs; the vault's own signed withdraw of its 3.4324 refund |
| X seal (optional) | governance / anyone | 3 | **`seal()`** | Seal calldata depends on the configuration hash at sealing time |

**Funds, from the snapshot:**
- **Migrator:** ≤ 0.000837 ETH.
- **Governance (all governance roles):** ≤ about 0.0151 ETH.
- **Payout:** 0.004995 USDC.

Full backing of every imported balance on the new ledger would need **42.678673 USDC**. This is reported, not assumed:
the old ledger is itself under-backed today, and the plan creates no subsidy.

## 6. What can be prebuilt, what needs wallets, what is unavailable

**Prebuild (reversible, migrator only):** every contract, parameter and one-shot binding in phase P. Nothing live
points at them until G2.

**Mandatory owner wallets:**
- **Governance, irreversible:** `retire`, `sealImports` (via the migrator) and the optional seal.
- **Governance:** the handoff accepts, the book repoint and `sweepEscrow`.
- **Payout:** the backing.
- **Fee payer:** the `revoke`s.
- **Operators:** their own earnings withdrawals.
- **Session-vault owner:** its own signed withdraw.
- **Connectivity hosts and owners:** re-qualify, `setHost` and `authorizeDirect` on connectivity17 (that state does
  not migrate).
- **Record owners:** optional re-backing; re-applying any post-F drift.
- **Delegates:** re-grant if any exist at F (none now).

**Inputs only their owners can give:**
- client readiness: supervisor and CLI follow the book and read rev 17 (the CLIcombined and measuredcontrol workstreams);
- the choice of migrator;
- the stuck-escrow choice;
- whether and when to seal.

**Genuinely unavailable:**
- 4.667026 USDC of escrow, if the old ledger is retired without first serving out that record;
- the old prover's checkpoint history and the old connectivity state, which are history only.

## 7. Remaining blockers before activation

1. The owners must decide the migrator, the stuck-escrow option and the sealing policy (the seal also freezes the ETH
   feed, payout, the proof kill switch and future `retire`).
2. Client readiness must be attested by the CLIcombined and measuredcontrol owners. G4 refuses retirement without it.
3. Phase P must actually be signed and executed, then a fresh snapshot and rehearsal run against the deployed
   addresses, before G1.
4. Snapshot F and the final import must be generated after a real `retire()`.
5. Independent pin updates follow: `contract-pins`, a new authority-profile digest, and source-verification manifest
   entries for the new addresses. **No source claim until the deployed bytes verify on Base.**
6. An end-to-end proof on Base after activation. Until then the decentralization goal is **not** complete.

## 8. Hash inventory (sha256)

Tools, libraries and tests:

```
87614e54bb3faa2929ef8b88027ce6135c626b81d2b174e295231c934d92125f migrate-ledger-17.mjs
c75d8c1ae58cee43fa3f16c14bd3fe1634e0b0e96d49a27a6c61e74fbbca0cb0 snapshot.mjs
02a8a0c8affe84aba687379430583837d7a335c979ca19ac1431194f3d7abfdf build.mjs
a9cfd9d31d3a84ddec3d4ddd3eddad9c803f93219d98640375e06ed468eab30f rehearse.mjs
2d1724a131d9a7d39fcc7a65ffb8cf5790f393fc8720dc1b530bc1f1209e4e64 plan.mjs
6d4636efe0b92f1af367e527e2e09cae97a1cdfdfe968b1498723854c297b8f4 lib/abis.mjs
3b98caf423708cf51d2d958b29b94279810a5eef2d7481bf2933b120fbea720a lib/fork.mjs
51b530ba7e268de2c9eee5a67dd0164c00acceda2899515477720404587c2213 lib/gates.mjs
f1383ec3cc20a70d477eb9cbab03ac4d3f46abf461b5afb25a908d4a9d503aac lib/ledgerstate.mjs
4bc113339c580e62f7f879cba2fdb51565c0836ea20b12c0dd3e6f72e8364ef6 lib/live.mjs
b65e3e39403d6bf6e911fabb47bad9fd27b891ad9b99cc3ca20df0ae4b2b40f0 test/fork-fee-wallets.mjs
05eac48d5de8aafef7454551cdbb80d3ca538b6c4739be385f46968c3f60ade6 test/migration.test.mjs
```

Builds:

```
57315481b2a298cb8c9e58452fb60b337ccd8ee769176c5de6af812ee58190c7 build/ledger17.json
84bec6ea880249b5c8359009c741f287a338a3b4d78f661fcd634857f3b90aee build/proofOfTime.json
31892caf8500b08d6d59301e0bfa8cfa2da59f9bdfd9ef689d8da5494370e1ca build/verificationFees.json
bcc1b35c714dcea826441a4d275ca10fcbff937bdb6b7bc4cd4b3b6ffe8d9dd8 build/connectivity.json
d1d8278736f24c0fec0bf5f2a56a96e05e70310ee6f06954a66d0b237c5cf0d3 build/pinned.json
7d1a7b934989f785f39b94b82859532f733b4a2ef77e49a27f51f47e8654ed94 build/governanceSeal.json
```

Snapshots, rehearsal and plan:

```
62d09d835677b1d1cac5b278bb2457d920dffb0d8dd8b76a546351e6c880bf4c snapshots/52841816.json (first; superseded)
9af072c39ca193bcdd45edc4b641ee0879cb7b0dc13fe835c8de51e4b14965a0 snapshots/52842154.json (digest sha256:ab070277…)
e33099fbb76efdd4b240a09d3be240d16f1bf2a2e084e0d1116012dd10903b1d rehearsal/52842154.json
a9986c9a6ba61bfdd75dbf8c6ff68fade511f96eb7808b5426fb21bda682114c rehearsal/fee-wallets-52842154.json
ca3b693690a2fbf329725660ab58f7f428b15174a626caed55e0ef8e9ffe2133 plans/52842154.plan.json
```

Frozen inputs:

```
7e86f7817f4646ddae6d7d4d44052a3897fbc9f9815187f946bc702fca0c1acb ../lease-generation-candidate/src/EnclaveDeployments.sol
508e8263383220ab525f59dd809f1d7e2272eb631c798653bf4f8c948889e68b ../lease-generation-interface.txt
```

**Kept:**
- Edits only in `work/ledger17-migration/` and the interface and result files.
- `work/enclave` and `/home/steven/Projects/enclave` were read only (verified public source; no configs or secrets).
- No commits.
- No Base writes. The only live calls were reads to allowlisted public endpoints.
- Fixture keys and impersonation stayed on the loopback fork.
- Jobs ran serially under the guard (≤ 768 MiB; host available ≥ 16.97 GiB).
- No processes of mine remain.
