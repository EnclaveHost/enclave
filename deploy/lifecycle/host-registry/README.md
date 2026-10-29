# Host lifecycle registry

A new compute-host registry stores canonical Online/Offline state, accepted ownership, reporter authority and protected offline funds together. Authenticated reports can mark a failed host offline without calling that host, an ownership service, token, oracle or payment recipient. Owner transfer and reporter changes take effect atomically. No periodic on-chain heartbeat or renewal is required.

**Local contract qualification only; not production activated.** The exact candidate passed 50 actual EVM tests (zero failures/skips) and fits EIP170: 23,968 runtime bytes, 608 bytes of remaining space. See [QUALIFICATION.md](QUALIFICATION.md), [the result](evidence/validation-result-r2/result.json), and [the repair review](candidate/REVIEW-REPAIRS.md). The preserved author report describes the earlier pre-validation stage. A normal-hook false positive on a public curve constant required one visibility-token change; [the qualifier review](QUALIFIER-REVIEW.md) records the subsequent identical-executable recheck.

The new contract preserves the thirteen-field schema5 `get/getPage` row, adds exact `hostLifecycleSchema()==1` and `registryFeature()` identity, and derives `active` from canonical lifecycle state. It replaces the separate authority store for its own hosts: a new authenticated profile must bind registry and accepted-ownership roles to this same contract. Merely swapping a registry address while reading old ownership is invalid. Existing deployed contracts/defaults are untouched.

Qualified listing requires payer-authorized immutable verifier policy, fresh intent-bound receipt signatures, explicit operator/owner consent, and reserved funds. An independent submitter can enroll a zero-ETH operator. Host proof-key changes require fresh qualified recovery; pricing/capability metadata is not verified spare capacity. Offline retries still authenticate the current revision and quorum/caller. Recovery cannot reduce the reserve below its authorized per-transition liability. Reimbursements are pulled separately and recipient failure preserves debt and Offline state.

**Fee limitation:** execution reimbursement is measured and bounded; actual Base L1 fees are not reimbursed by this version. The signed L1 ceiling is inert, no unproven allowance is paid, and no L1 debt is invented. A finite reserve does not guarantee inclusion.

**Admission limitation:** `protectedReserve >= perTransitionCap` preserves payer-defined accounting, not the affordability of a real transaction. The deliberate 1-wei fixture does not establish an economic minimum. Before production Online admission, qualification/sponsor policy must verify a conservative execution-plus-L1 fee envelope and a funded independent submitter. Low reimbursement must never block an already-authenticated Offline transition.

## Files and reproduction

- `candidate/contracts/EnclaveHostLifecycleRegistry.sol`: exact tested new source; no libraries or unresolved links.
- `candidate/test/`: exact 26 lifecycle, 16 budget and eight review tests.
- `evidence/`: original logs, ABI/storage, actual compiler artifact, source/tool/config manifest, guard results and review diff.
- `collection.json`: evidence digests using original staging-relative names; those files are under `evidence/` here.
- `foundry.toml`: portable repository-path configuration; no size override or FFI.

With Foundry, the pinned solc0.8.35 and the existing forge-std checkout available, run `forge test --root deploy/lifecycle/host-registry --offline --threads 1` from the repository under the project's approved memory guard. Use the exact compiler binary/version recorded in the evidence when reproducing qualification. No automatic deployment command is supplied.

Packaging copied contract/test bytes unchanged. The portable configuration changes filesystem/remapping roots; it has not been separately compiled. The preserved compiler artifact and manifest are the actual staging result, not a claim that different build-path metadata produces an identical runtime hash. Independently pin the deployed runtime and the complete profile before use.

## Integration still required

Real qualification/test/attestation services and verifier-policy operations; paid-work sponsor eligibility and verified-absence-only fallback; durable independent offline sender and receipt reconciliation; common verified capacity projection; recursive profiles and every serving/storage/secrets/routing consumer; and operational re-enrollment of existing hosts. A test that rejects the operator's own verifier key does not prove other EOAs are independent organizations. Relay-only listing needs an explicit separate path/profile decision. These unit tests do not complete production migration.
