# Schema3 chain-adapter composition r1: author report

2026-10-29. **SOURCE ONLY. Nothing here was run.** I did not run any test, generator, syntax check, compile, Anvil, shell or network command. Every test below is **UNRUN**. I wrote files only in this directory. No original, peer or repo file changed. No Solidity changed.

## Deliverables (this directory)

| File | Role |
| --- | --- |
| `src/tools/generate-lifecycle-schema3-adapter-candidate.mjs` | Strict additive generator. Input is the frozen r6 adapter (SHA `330a9082…`, run through the r3 generator by absolute path) or the reviewed r3 candidate (`8e666ed6…`). Either way the r3 output must hash to exactly `8e666ed6…`. It then applies 21 named insertions (insertions only, self-restoring) with marker `SCHEMA3_PROFILE`. It also checks the bundle: source SHAs, compiler, settings, the 5 artifacts and EIP-170. It embeds the bundle SHA. It never overwrites a file. CLI: `<r6\|r3> <bundle.json> <out> [expected bundle sha]`. |
| `src/tools/insertion-patch.mjs` | Verbatim copy of r3's `insertion-patch.mjs`. |
| `src/network/lifecycle-schema3-profile.mjs` | New pure module: profile constant, bundle validation and cache, static link/immutable/self-binding proof (`prepareSchema3`), in-snapshot verification (`verifySchema3AtBlock`), the offline-tuple interpreter (`schema3Emergency`), snapshot fields and blockers. |
| `test/schema3-pure.test.mjs` | 3 pure tests: generator equivalence/restoration/guards/`node --check`; static pin negatives; emergency-tuple consistency. |
| `test/fixtures/schema3-world.mjs` | Owned Anvil world with the **actual** schema-3 contracts from the precompiled bundle, plus the same r5 TEST doubles. |
| `test/root-schema3-adapter.test.mjs` | 6 Anvil tests (listed below). |
| `run-schema3-adapter-r1.sh`, `run-schema3-adapter-r1.py` | Root harness. It is r3 `run-adapter-r4.sh` with the r6 closure reconstruction and provenance lines unchanged, plus the schema-3 pins and overlay, plus 80 counted tests in 10 suites. |

## Exact input dependencies

- r6 stage `lifecycle-chain-adapter-stage/r6` (SHA256SUMS-verified; adapter `330a9082…`), and the r3 generator at `lifecycle-independent-composition-review-r3/src/tools/` (output must be `8e666ed6…`).
- r3 `src/network/lifecycle-independent-admission.mjs`, `test/root-independent-adapter.test.mjs` and `precompile-test-doubles.py`, all used unchanged.
- Qualified sources, pinned in the harness:
  - `EnclaveDeployments.sol` `c720f1bf…`
  - `EnclaveProofOfTime.sol` `946f0b90…`
  - `EnclaveDeploymentLifecycleEmergency.sol` `ac4023b9…`
  - `EnclaveSelfHostingIdentity.sol` `f8dae9ab…`
- `lifecycle-linked-artifacts.mjs` `d9ad5264…`, unchanged. Its `resolveRuntime`/`verifyLinkedLifecycleCode` are reused, not reimplemented.
- `library-import-size-feedback/compiler/bundle.json`. **I could not compute its SHA without running a tool.** The harness first checks the bundle against `compiler-input.json` and `compiler-output.json` (sources, settings, ABIs, templates, link and immutable references, EIP-170). It then writes `run-r1/bundle.sha256` and passes that value to the generator as the expected SHA. **Root should review this value and then pin it as a constant.**
- The rest as in r4: source-r1/runtime-expiry/host-admission/closures, node_modules viem/solc, and Anvil, all pinned.

Outputs, all under `run-r1/` once root runs the harness: `generator.json` (candidate SHA, manifest, bundle SHA), `bundle.sha256`, `overlay.sha256`, per-suite `.tap` files, `summary.txt`, `RESULT`, `cleanup.txt`, and the doubles precompile records.

## Changed semantics (only when `pins.profile === 'independent-schema3-r1'`)

**Profile selection and inertness**
- No defaults, environment flags or schema-based inference select this profile.
- Legacy default and `independent-r1`: every insertion is guarded by `S3`, or is an inert declaration (`R6_ABIS`, the import, the bundle SHA constant). With the profile absent, the r3 bytes and behaviour are retained exactly. Those two profiles still pin schema 2, so they refuse a schema-3 ledger (tested).
- An unknown profile still throws.
- The new profile inherits all `independent-r1` rules: the address book is discovery-only, and r3 host-scoped moderation applies.

**Contract ABIs**
- The controller and ledger ABIs come from the hash-pinned bundle, not the schema-2 artifacts. A function-scoped `LIFECYCLE_ABI`/`LEDGER_ABI` shadows the module constants.

**Static checks at construction**
- `pins.schema3.immutables` must name, per role, exactly the compiler's AST immutable ids.
- The targets must be exactly these:
  - ledger: `{registry, usdc}`
  - controller: `{ledger, l1Oracle}`
  - prover: `{ledger, lifecycle, registry, uint64:<n>}`
  - identity and library: none
- `accountingLibrary` must be a pure code pin.
- The role mapping is fixed in code.
- For all five contracts, the runtime is re-resolved from the template, using the pinned library address, the concrete immutable values and the library's own address at `library_deploy_address` (7/32). The result must hash to `pins.contracts.<role>.codeHash`.

**Checks inside the one authenticated snapshot**
- The whole r6 recursive closure, admin sets, identity factory slots, controller/ledger/identity/registry/oracle bindings and receipt/fee/domain logic are kept unchanged.
- Added to the same `pinned()` read at the same `client`/`blockNumber`:
  - `verifyLinkedLifecycleCode`: deployed code for all 5 contracts, registry code, ledger↔controller↔prover↔registry pair, `lifecycleSchema 3`, `lifecycleProofSchema 2`
  - `prover.proofSchema == 2`
  - `controller.ledger == ledger`
- The schema gate becomes `S3 ? 3n : 2n`.

**Emergency offline handling**
- The controller's `offline(id)` and `lastEmergency(id)` are read in the same block, in `read`, `submit`, `resolve` and `finalize`.
- A pending record must be the revoked previous generation with its stop flag, and the state must be queued or stopped. Anything else throws (state unknown).
- While pending:
  - `funded = false`, `admitted = false`, `fundedUntil = blockSec`, so the generation anchor also gets `funded = false` and `hostAdmission.admitted = false`
  - `prepare` refuses every target
  - `submit` re-reads and refuses
  - reads, `resolve` and `finalize` keep working and report `emergency`
- `enabled` stays the owner's own state. An emergency does not cancel the deployment.

**Snapshot fields**
- `profile`, `lifecycleSchema: 3`, `lifecycleProofSchema: 2`, `emergency{scope:'deployment', pending, runGeneration, cutoff, stopped, host, operator, lastEmergency, settlement, newAdmission}`.
- `hostOffline{registryOffline:'not-implemented'}`, keeping per-app emergency offline separate from host registry offline.
- `ledgerState.retirement: metadata-only`.
- Schema-3 blockers. The r3 "retire() stops independent deployments on every host" claim is not repeated, because the qualified schema-3 `retire()` is metadata only. The other blockers stay.
- The snapshot `schema` stays 2 (runner format compatibility).

**Not changed:** receipt/header/transaction/log proof, fee bounds, digest/domain, actor/quorum rules, ledger owner/pendingOwner admin denial, the other admin sets, `outcomeOf`, and the generation anchor shape. This task adds no reporter transactions, host sponsorship, capacity, grants or authority.

## Tests prepared (all UNRUN)

`root-schema3-adapter.test.mjs`, 6 tests:
1. Positive run on the actual pair: library self-address embedded, plus read, queue, start (`lifecycleStart`), resolve, finalize, and requeue (`lifecycleEndAt`).
2. Fail-closed cases:
   - an absent library
   - a second library instance, which differs only by its self address
   - a library self-address/code-hash swap
   - swapped or wrong ledger immutables, and missing immutable ids
   - no `schema3` block
   - a same-code second prover, controller or ledger at the wrong address
   - a stale recursive dependency
   - wrong profiles: the legacy and `independent-r1` profiles fail on schema 2, an unknown profile throws, and adding an address book throws
3. `retire()` is metadata only and a start still works afterwards. A `setOwner` admin change denies new starts but leaves reads, emergency, reconcile and stop working.
4. Pending cutoff:
   - the exact tuple, read at the pinned block and compared with the block before
   - `lifecycleFunded` is false while the ledger still names the revoked run
   - prepare and submit are refused; a stale intent fences
   - reconcile works once; a retry returns false
   - after the fence, a restart works
5. A stopped-target emergency and its final settlement. A previously confirmed start is never upgraded (`inconsistent`, no proof). A reorged-away emergency is not retained. The finalize reorg refusal on schema 3.
6. Actual runner:
   - a pending run is held, never served or staged, and sends no transaction
   - the generated snapshot's anchor refuses service
   - `verifyGenerationChain` refuses `[]` and a forged restart certificate
   - `LIFECYCLE_DENIED` persists across the pending period and is restored only after settlement

The harness also runs `schema3-pure` (3), r3 `independent-r3` (5) and the legacy regressions on the new candidate: `r5-abi` 5, `r5-policy` 9, `r5-proof` 10, `kvm-generation` 15, `kvm-boundary` 9, `kvm-runner` 11, `runtime-expiry` 7. Total 80.

**Resources.** The node heap/young-generation flags, the 512/450 MiB root guard, the 27648 MiB floor and the single CPU are unchanged. The schema-3 contracts are precompiled, so this adds no compiler; the TEST doubles still use r3's child precompile. `root-schema3` has a 300 s per-suite limit, and the outer timeout was raised to 1500 s because there are about 19 more Anvil tests than r4. Root may change these.

## Risks I could not check without running

- **Anchor uniqueness.** I hand-derived the anchors from the r6 text plus the r3 insertion texts. If any anchor is wrong, the generator refuses and setup fails closed; it does not produce a partial file.
- **Fixture immutables.** The fixture assumes the ledger has exactly two immutables, the controller two and the prover four (`usdc`/`registry`, `ledger`/`l1Oracle`, `deployments`/`registry`/`lifecycle`/`maxProofWindowSec`). Any other immutable makes the fixture throw with a named message, and the adapter's multiset table would then need review.
- **Registry struct decode.** The TEST double `TestRegistry` `Enclave` struct has extra trailing fields. The schema-2 ledger decoded it; I did not confirm the schema-3 ledger does.
- **Timing.** The generation test relies on Anvil block timestamps not running more than 2 s ahead of wall clock (as the r6 F2 test already does), and on gas limits of 28M for the ledger and 12M for the controller under Anvil's default block limit.
- The schema-2 error text ("ledger is not lifecycle schema 2") is kept for byte-equivalence. S3 adds its own schema-3 errors through the helper.

## Remaining gaps (honest blockers retained)

- **Ledger owner powers stay:** `setClaimBond`/`slashBond`, `setProofRequiredFrom`, `setEthUsdFeed`, `setPayout`, `setRunnerBps`, `setMaxGpuMilli`/`setMaxFee`, the import window, and owner transfer. A prover owner can change `setProofWindow` (within its immutable maximum). `secretVaultV2.enclaveOwner` remains an external custody address. All of these are reported; none are removed, and contract gates are not bypassed.
- **Emergency limits:** host-wide registry offline does not exist yet (peer is auditing it). This adapter does not submit `emergencyOffline`/`reconcileOffline` or sponsor reporters. The L1 reimbursement component is unpriced.
- **Ownership and payout:** a registry payout wallet is never treated as host owner. Host ownership comes only from `EnclaveHostOwnership`. Registry writer authority is not qualified.
- **No heartbeat:** there is no recurring on-chain renew/heartbeat. Proof-of-time checkpoint accounting is separate and is not performed here.
- **Liveness gap:** if a start's relay response is lost and the start is revoked before it is resolved, it reads as `inconsistent` and needs operator recovery. No proof is synthesized.
- **During pending,** `funded=false` makes the runner try a global `stopped` transition. `prepare` refuses it and the runner holds, fenced. That is safe but noisy; review whether a dedicated runner state is wanted.
- **Out of scope:** no production pins, bundle-SHA constant, live Base authority, migration/escrow conservation, capacity, sponsorship, funded-app or grant changes. The existing grants stay bound to their original adapter. This is not deployable and must not be copied over a live host.
