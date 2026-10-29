# Schema3 adapter integration root review

The explicit `independent-schema3-r1` adapter now passes 80 checks with zero remaining failures/skips: three pure checks, six actual linked-contract scenarios, and 71 unchanged independent/schema2 adapter, proof, runner and runtime regressions. First run78/80 passed; the affected9/9 rerun passed after two fixture-only repairs. Product generator/profile/linking source remained unchanged from the author delivery. No production contract, host, app, relay, grant or payment changed.

## Actual coverage

Owned isolated loopback Anvil8453 deployed the actual qualified schema3 ledger, accounting library, emergency controller, identity and prover. The linked library was deployed normally; its runtime self-address and ledger links were checked independently. No code-size override, shim, vm.etch, production RPC or real keys. Registry, USDC, catalog, recursive dependency surfaces, authority capability and recent-head source are labelled TEST doubles. Actual EVM execution/receipt validation is not proof of live Base derivation.

The same authenticated snapshot callback checks every recursive r6 binding/admin set and the linked schema3 pair; this does not replace the recursive graph with four primary roles. The new exact profile keeps both prior profiles, source-pins the compiler bundle, verifies runtime/immutable/self bindings, and reads the emergency cutoff at the same block. Actual prepare/submit/resolve/finalize, exact cutoff reconciliation, one-time settlement, reorg refusal and normal restart after settlement passed. Pending settlement denies funding/admission/transition and generated operational certificates; read/reconciliation remain usable. Retirement metadata no longer blocks the qualified schema3 ledger; actual owner controls remain.

The harness was corrected before execution to use the root-qualified runner75590c8e... after checking the original closure. This preserves the earlier monotonic host-local refusal repair. It is actual runner integration, not the complete installed Host/dispatch/runtime/scheduler. Whole-host capacity and independent registry-offline remain unqualified.

## Retained failures and repairs

`run-r1` is the complete first run. Pure generator assertion rejected `, offline, lastEmergency` because the text fragment did not itself contain `S3`; the actual declarations are explicitly conditional and null for old profiles. The corrected test checks those exact guarded declarations. The last actual-chain test stopped before its intended pending-authority assertion because earlier controlled Anvil warps advanced the runner clock but the TEST authority used wall-clock observation time. The schema3 fixture now uses the same controlled `chainNow()` for observations. No production freshness rule, permitted drift or assertion about service authority was weakened. `failure-source-r1` and `fixture-repairs.diff` retain both originals. Affected tests were rerun; the already-passing71 regressions were not repeated.

Both runs used shared512MiB/inner450/floor27648/oneCPU/noSwap. First peak383MiB outer319inner, minimum available34076MiB; rerun319outer261inner, minimum34317MiB. Exit statuses1 then0 reflect assertions, not resource stops. Owned sessions/Anvils/temporary trees ended and the main lane was released. Prior partial precheck is separately identified, not counted as contract tests.

## Review and portability limits

The immutable bundle SHA is now a literal pin in the root runner. It is also checked against retained compiler input/output and source hashes. Product candidate SHA and bundle SHA are in `qualification.json`. The review package intentionally depends on pinned sibling stages and local node_modules; it is evidence/source preparation, not a portable production installer. Author REPORT is historical source-only intent; this root review controls qualification claims.

## Remaining work toward the full goal

Per-app emergencyOffline does not mark a crashed host offline in the registry. The reviewed next task is a NEW canonical host registry with accepted owner/reporter revision stored together, graceful owner/operator shutdown and independent quorum reporting sharing a local-only Offline transition. Zero-ETH candidate registration is submitted by a sponsor after successful capacity test and fresh attestation; optional reimbursement cannot revert Offline. Host owner transfers invalidate old quorums atomically; legacy heartbeat cannot reactivate tombstones. The pinned plan is source-only, not implemented or deployed.

Residual ledger economics/bond/slash/import/proof-admin and external custody powers remain explicit independence gaps; merely displaying those blockers is not completion. Real host/registry/attestation/capacity/sponsor composition, protected independent reporter funding, automatic restricted refill and new contract grant authority, fenced migration, app recovery and positive live Base verification remain. The complete goal also requires removal of mandatory control/identity/artifact/indexer/DNS/custody authorities and demonstrated cold recovery/new-user deployment/storage failure/hosting under Enclave refusal. Existing grants and the two successful production payments must not be repeated or reinterpreted.
