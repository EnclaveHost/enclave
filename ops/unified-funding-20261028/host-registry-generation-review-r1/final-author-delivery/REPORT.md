# Host-registry profile r2: `independent-host-registry-r1`

Status: source only. Nothing has been executed, compiled, tested, deployed or signed. I have no pass results to report. Root has to review this and run the proposed harness. This is not production-ready and not a completion claim.

## What it does

`independent-host-registry-r1` is a new explicit profile. It is the qualified `independent-schema3-r1` adapter with one change: a single canonical EnclaveHostLifecycleRegistry fills both the `registry` and the `hostOwnership` role. That means one address and one runtime (artifact e8690734, source 68310acc). All of the following come from that one contract, read at the adapter's one authenticated block:

- the schema-5 row and its derived `active` flag
- Online/Offline status and generation
- the qualification, resource, hardware and descriptor digests
- the qualification expiry
- the accepted owner, revision and policy hash
- the reporter policy

The old separate EnclaveHostOwnership authority is no longer consulted for this profile. The `default`, `independent-r1` and `independent-schema3-r1` profiles are unchanged: every new insertion is guarded by an exact match on the new profile, and the generators prove byte-for-byte restoration of their inputs.

## Files (all under `candidate/`)

| File | Role |
|---|---|
| `src/network/lifecycle-host-registry-profile.mjs` | New pure module. Validates the artifact: SHA-256; solc 0.8.35/viaIR/prague/runs 1/ipfs; exact compilation target and single source; source SHA-256 plus metadata keccak; no links, immutables, constructor, fallback or receive; runtime 23968 / init 23994; creation code ends with the runtime; exact ABI names, types and order for the 13-field `get`/`getPage`, `authority`, `hostState`, `reporterPolicy` and the schema constants; legacy writers absent. Also contains `prepareHostRegistry` (registry and hostOwnership must be the same address and code hash, equal to the artifact runtime hash, and no other pin may reuse that address), the same-block `verifyHostRegistryAtBlock` (code, `registrySchema == 5`, `hostLifecycleSchema == 1`, feature id, status constants), `readHostLifecycle`, `hostLifecycleState` (throws, meaning state unknown, on any status/generation/row-active/authority-tuple/reporter-revision inconsistency) and the blockers list. |
| `src/tools/generate-lifecycle-host-registry-adapter-candidate.mjs` | 12 insertions into the qualified schema3 adapter 07d02fca. Here HR implies S3, so every schema-3 bundle, link, immutable, self-address, closure, admin and monotonic check still runs. The registry is verified inside the same `pinned()` snapshot. New admission additionally requires canonical Online. Nothing is ever submitted to the registry. |
| `src/tools/generate-lifecycle-host-registry-host-candidate.mjs` | Insertions into the three pinned Host files: profile 98e33cfe, authority 6baf5b55, dispatch 3e826b74. Adds the exact profile and the artifact identity. The composer refuses separate or legacy ownership pins and checks the adapter's registry address, runtime and artifact. Bindings and finite route manifests carry `hostRegistry`, `hostRegistryCodeHash` and `hostRegistryArtifactSha256`, and there is no fallback to another profile. Snapshot admission requires `hostLifecycle.owner/revision/policyHash` to equal `hostAuthority`, and when the host is not Online it returns a refusal (`canonical host registry is offline`). |
| `test/fixtures/host-registry-world.mjs` | Anvil 8453 world. Deploys the actual artifact with its normal (empty) constructor. Enrollment goes only through the registry's qualified path: the payer funds and reserves, the operator and accepted owner consent, and a fixture verifier quorum signs the receipt. Operator and owner send zero ETH. Every immutable dependency is rebound to the new registry: ledger/prover/connectivity `registry` and secretVaultV2 `hostRegistry` + `hostOwnership`. There is no TestRegistry or TestHostOwnership. Owner, operator, payer, verifiers, reporters, submitter and the next owner are separate generated TEST keys. |
| `test/root-host-registry-profile.test.mjs` | 11 tests, listed below. |
| `run-host-registry-r1.sh`, `run-host-registry-r1.py` | Proposed bounded root harness (details below). |

The 11 tests cover:

1. Artifact and source provenance, plus mutation refusal.
2. Generator restoration, with the overlays equal to the generated outputs.
3. Profile helper, route and binding exactness.
4. Same-block enrollment snapshot.
5. Composer start, serve and stop, then journal reopen.
6. Lost reply, then restart without a resend.
7. Owner Offline with the operator absent: no serving or start; the deployment owner can still stop.
8. Reporter quorum Offline. Rejected: the old quorum after a policy change, the old owner after a transfer, the previous-revision quorum, and a quorum below threshold.
9. No heartbeat, register or setActive selectors. Metadata edits keep the host Offline, and only a recovery with a new qualified generation returns it to Online.
10. Pin refusals: a second real registry used as hostOwnership (internally consistent hash), a wrong code hash, a wrong or missing artifact pin, the wrong composer profile, and a route without the registry identity.
11. A block before the registry existed is unknown state, and a stale ledger pin is refused.

## Proposed harness

- `run-host-registry-r1.sh` keeps the closure and provenance section of run-chain-r2.sh.
- It cross-checks the registry artifact metadata against the r2 `result.json` (50 passed, runtime equal to r1).
- It keeps 07d02fca as the pinned generator input, generates the adapter and Host files into the owned temporary tree, and runs 52 exact checks: the 11 new tests plus these regressions:

  | Suite | Tests |
  |---|---|
  | schema3-composition | 3 |
  | root-schema3 | 6 |
  | schema3-pure | 3 |
  | independent-r3 | 5 |
  | r5-abi | 5 |
  | r5-policy | 9 |
  | r5-proof | 10 |

  These regressions run on the newly generated adapter and composer.
- `run-host-registry-r1.py` adds the guards: one CPU, `unshare -Urn`, inner RSS 1408 MiB, MemAvailable floor 27648 MiB, no swap, 1500 s.
- Root must fill in `SCRIPT_SHA256` after review.

## Security boundaries

- **Pins are identity, not authority.** Profile labels and runtime pins never authenticate state. The injected finality authority remains the only judge of block qualification, and there is still no positive Base authority.
- **Offline denies; it never authorises.** Canonical Offline only denies new admission (the adapter's `admitted` and the Host's refusal). It never authorises any other contract's transition. Reads, reconciliation, queue/stop and owner or independent app-stop paths stay available. There is no implicit Online on metadata changes, and nothing calls heartbeat or renew.
- **Qualification expiry is reported, not enforced.** `qualificationExpiry` and `qualificationExpired` are exposed as evidence only, not as a lease.
- **No global veto.** Catalog, publisher or platform denial still cannot block foreign hosts. Content integrity and the deployment owner's controls are kept.

## Assumptions root must confirm by running

These are untested and some could fail:

- r6 `prepare(running)` refuses when `admitted` is false.
- The 75590c8e runner and dispatch never serve after an admission refusal, and either revoke the deployment or leave it for the owner to stop.
- The schema-3 ledger and prover accept the new registry's schema-5 row: `lifecycleOperator`, `rateFor`, and the self-host rate with `payoutWallet` equal to the owner.
- Foundry omits empty `immutableReferences`.
- viem `LocalAccount.sign({hash})` produces 65-byte low-s signatures that the registry accepts.
- The r3 `precompile-test-doubles.py` covers the doubles used here.

## Still missing (not implemented here)

- Real qualification verifiers and a prelisting test/capacity job (the fixture anchor is TEST keys only).
- Sponsor selection and Stripe/paid-work liability checks (`sourceEvidence` is opaque).
- An independent, durable Offline submitter/reporter service.
- L1 fee reimbursement (`l1FeeAllowance` is inert). The 10^15-wei protected reserve is not production-admissible: matching the protected cap does not prove there is enough execution + L1 gas or an independently funded sender.
- Verified capacity display, scheduler use of `resourceDigest`, and serving permits bound to the generation.
- Production positive Base authority.
- Fenced funding/custody migration.
- A deployed registry, reporters, or address/book changes. No factory, book or global address was rewritten.
- `availability/witness.mjs` still requires the old active registry and accepts a missing `lastAudit`. That is not prelisting proof, and it is not integrated or treated as bootstrap here.
- The 93-check host-composition suite from lifecycle-schema3-host-composition-r1 should also be rerun against the generated Host files. It is not in this harness.

The original stages, the registry source and artifact, the pins and the runner inputs were only read, never written.
