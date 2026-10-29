# Host-registry profile: repair r1 (`independent-host-registry-r1`)

Status: source only. I have not run anything: no tests, no compiler, no network, no Git, so there are no pass results. Root needs to review this and run the proposed harness. This profile is **not** complete or production-ready.

This repair finishes the original exact task (6ac70e91) and closes the generation-fencing gaps that root demonstrated in `host-registry-generation-preflight-r4`. The original stage, its first-write snapshots, the registry source (68310acc), the artifact (e8690734), the schema3 bundle and all Solidity are unchanged.

## What changed in the code

The host generation is no longer just a field. It is a **host incarnation context** that is carried through admission, the dispatcher, the runner effects, the durable journal and serving.

### 1. Generator bugs (`src/tools/generate-lifecycle-host-registry-host-candidate.mjs`)
- The profile input SHA was 63 hex characters. It is now `98e33cfeb1b7…9176`, and a module-load guard requires every pinned input hash to be exactly 64 hex characters.
- The marker is now `host-registry r2`. It occurs in all three outputs and is absent from all three inputs. Restoration and hash checks are unchanged.

### 2. Host incarnation (pure; profile-helper insertions)
- **What it binds:** `hostIncarnationOf(L, {hostId, registryCodeHash})` builds an exact context from the following fields. The digest is SHA-256 over every field except `status`.

  | Field group | Fields |
  |---|---|
  | Identity | profile, hostId, canonical registry address, registry runtime code hash |
  | Generation | the exact decimal uint64 string |
  | Status | `status` (not part of the digest) |
  | Qualification | qualificationDigest, trustAnchorId, hardwareId, resourceDigest, descriptorDigest |

  `status` is excluded so that Offline within the same generation keeps the same identity.
- **Exact integers:** `exactUint64` accepts only a bigint, a safe integer, or a canonical decimal string. It refuses anything that would need rounding.
- **Two generations kept apart:** the host generation is separate from the app assignment generation.
- **Adapter side** (`lifecycle-host-registry-profile.mjs`):
  - All uint64 values are exact strings.
  - The nested `hostLifecycle.verified` flag was removed and replaced by `codeConsistent`. Authority comes only from the snapshot's top-level `verified`, so an rpc-quorum snapshot is never admitted.
  - The artifact check now also refuses an ownership-style `registry()` getter.

### 3. Admission (authority insertions)
- `createSnapshotHostAdmission` takes an optional `hostRegistry`, which the composer passes.
- For this profile, the decision carries `hostIncarnation`. Its owner, revision and policy must equal the canonical registry's at the same block.
- An Offline host still produces a decision, as a refusal with the context attached. Offline does not depend on fresh qualification.
- Test 2 of root r4 now differs across generation 1→2, as root expects.

### 4. Durable journal (`src/network/lifecycle-host-incarnation-journal.mjs`, new)
- `withHostIncarnationJournal(journal, file)` adds three methods: `readHostIncarnation`, `acceptHostIncarnation` and `bindHostIncarnation`. The generated owned journal itself is not edited.
- Every write uses temp file, fsync, rename and directory fsync before it returns.
- What is stored:
  - **floor:** monotonic. A lower generation is refused as rollback, and the same generation with a different digest is refused as equivocation.
  - **genesis:** the first incarnation this file ever accepted.
  - **bound:** per deployment, the incarnation its app context started under or was adopted into.
- Binding is only allowed to the current floor.

### 5. Dispatch (dispatch insertions, all guarded by the exact profile)
- **Required journal methods:** the profile requires the three journal methods. Without them it is blocked, and there is no in-memory substitute.
- **Persist before use:** `checkDecision` persists the incarnation floor before the decision is used.
- **Generation change fences, it doesn't revoke:** at read time, a different incarnation while old work may exist sets "unknown". That fences serving and new starts. The runner keeps reconciling pending intents and revocations, and there is no automatic chain revocation, so the owner chooses between stop and adoption. Old work means:
  - not yet observed
  - physically present
  - reserved
  - a pending or mined Running intent
- **Recheck at every serve and start:** the same check is repeated at every serve and start effect and at ingress.
- **Unknown reads drop the cached decision:** a failed read deletes the cached decision, so a stale decision can't be used for ingress or adoption.
- **New starts:** a new start binds the current incarnation to the deployment and persists it before the start effect. Rebinding is only possible when no old work can exist (the old work was stopped or settled).
- **Submit boundary:** before a Running transition is broadcast, the dispatch takes a fresh authenticated read and decision. The adapter verifies code, schema, closure and immutables at that block. The dispatch then requires exact Online status, the durable floor and the app's binding.
  - If any of these fail, the send is refused on our side and nothing reaches the relay.
  - The journaled intent is kept for read-only resolution or finalization. It is never replayed or overwritten.
  - Revocations, stops and finalize are never gated by this.
- **Explicit adoption:** `dispatch.adoptHostIncarnation(id, {generation, digest})` is the box owner's path for keeping an existing app context under the new incarnation.
  - It takes its own fresh authenticated read, so an unknown chain refuses.
  - The caller must name the exact current Online generation (decimal string) and digest.
  - It needs an unrefused decision, the durable floor and no local hold. Adoption never releases a hold.
  - It fences before it rebinds.
  - It is never automatic and is not a platform veto over foreign hosts.
- **Serve and state:** `runtime.serve` receives the snapshot with `hostIncarnation` attached, and `state()` exposes it.

### 6. Composer
- The composer forwards the registry identity and `hostIncarnationGenesis`. That option defaults to `'activation'`: on the very first floor a journal ever accepts, already-running routes are adopted as the activation handoff. `'explicit'` requires adoption even at genesis.
- A nested `verified` without top-level authority is refused.

### 7. Fixture (`test/fixtures/host-registry-world.mjs`)
- Operator and owner are set to 0 wei before enrollment, and the fixture asserts both still hold 0 wei afterwards (`w.zeroEth`).
- The owner is funded only after enrollment. The operator metadata test funds the operator separately with `fund()`.
- The awaited destructuring is now plain sequential awaits.

## Tests

### `test/root-host-registry-profile.test.mjs` (16 tests, actual registry, Anvil 8453)
The tests use the real generated journal plus the durable incarnation section. They cover the original 11 cases updated, plus:
- Missed Offline followed by recovery: the old context is fenced with no Running effect. The fence survives restart. While the chain is unknown, the binding is not cleared and adoption refuses. Adoption with the wrong generation, or with a number instead of a string, is refused. Exact adoption resumes serving.
- A stale prepared Running transaction is refused before the sender. It is not broadcast, resent or overwritten.
- A pending Running transaction from the old context resolves canonically without a resend after missed Offline, recovery and restart, and is not served under generation 2.
- Offline works after the qualification expired, and the deployment owner can still stop.
- Durable journal rules: max uint64, rollback, equivocation, a digest that doesn't match its fields, binding only to the floor, reopen from disk, and the wrapper forwarding class-private methods.
- An rpc-quorum snapshot has no nested `verified` and is not admitted.

### Root r4 `test/host-generation.test.mjs`
The test file is byte-identical and pinned. In the harness it runs against the newly generated Host files. Its mock fixture is replaced by `test/helpers/lifecycle-fixture.mjs`, a labelled **superset** of the pinned r4 fixture (a5f599b7): every original line plus the three incarnation mock methods, with the same rules as the durable section.

By reading the code, I expect all 3 tests to pass. This has not been run. Root should decide whether the superset fixture is an acceptable stand-in for their pinned one. Without the incarnation methods, the profile correctly refuses to activate.

### Proposed harness
`run-host-registry-r1.sh` plus `.py`. Root must fill in `SCRIPT_SHA256`.
- It keeps the closure and provenance checks.
- It verifies the r4 `input-pins`.
- It requires the marker in every generated Host file.
- It expects 60 exact tests:

| Suite | Tests |
|---|---|
| host-registry | 16 |
| r4-generation | 3 |
| schema3-composition | 3 |
| root-schema3 | 6 |
| schema3-pure | 3 |
| independent-r3 | 5 |
| r5 (abi 5, policy 9, proof 10) | 24 |

- Guards: one CPU, `unshare -Urn`, 1408 MiB RSS, 27648 MiB floor, no swap, 1500 s.

## Assumptions root's run must confirm
- r6 `prepare(running)` refuses when `admitted` is false.
- The 75590c8e runner fences and holds when `serve` throws, and never resubmits when a submit is refused.
- The schema3 ledger and prover accept the new registry's row.
- Foundry omits empty `immutableReferences`.
- viem `sign({hash})` produces low-s 65-byte signatures.
- r4 `baseline.mjs` resolves the runner when it is loaded through `--import`.

## Known limits
- **Adoption entry point:** `adoptHostIncarnation` is a dispatch method. Wiring it to the Host's authenticated hosting-admin API is a Host integration step that is not done here.
- **Serving permit:** the frozen `deployment-serving-permit.mjs` is unchanged. It receives the context but does not sign it. The dispatch rechecks the context at every serve; the permit itself still lasts 20 s.
- **Genesis adoption:** with `'activation'`, a lost or new incarnation journal can't be told apart from a first activation.
- **Surface change on old profiles:** the dispatch object gains `adoptHostIncarnation` on every profile. It throws unless the profile is host-registry.
- **Not run:** the 93-check host-composition suite has not been re-run against the generated Host files.

## Still missing
- Real qualification verifiers and a prelisting capacity job.
- Sponsor selection and Stripe/paid-work liability checks.
- An independent, durable Offline submitter/reporter service.
- L1 fee reimbursement. The 10^15-wei fixture reserve is not production-admissible.
- Verified capacity display and scheduler use of `resourceDigest`.
- Serving permits that sign the host generation.
- Positive Base authority.
- Fenced production funding/custody migration.

Registry reporter permission never grants app-ledger permission.
