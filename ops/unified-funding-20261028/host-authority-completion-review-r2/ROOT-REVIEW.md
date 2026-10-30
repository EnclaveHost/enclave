# Host authority completion: partial qualification, ownership repair required

Status: NOT deployable. No production, app, financial, controller or RPC changes. This feature remains the highest priority within completely decentralizing Enclave for censorship resistance.

Claude on the verified required Max account completed the source-only run with rc0, 35 turns, no input drift across141 pins. Its37 final files are frozen in author-snapshot; root preserved the original failed evidence. A successful author exit is not a test result. Root-candidate contains only the files that supersede that snapshot, not a separate full tree.

## What changed and what passed

The candidate binds signed serving permits and the actual adapter/runtime to host generation and owner authority; records same-generation Offline denial; refuses v1 serving for the new profile; and connects explicit host-incarnation adoption to the v2 runtime. Old pending intents are retained and reconciled without resending. Root added the final readiness-window comparison after the awaited post-signature read. Root also corrected a synthetic gen2 fixture to confirm actual runtime.stop before presenting a fresh Queued origin.

| Evidence | Result | Scope and limits |
| --- | --- | --- |
| Focused protocol + independent integration + final-await tests | 23 PASS, 0 skip | Real signatures, protocol classes and file journals; TEST authority, readiness, manager and transport. |
| Final layered canonical registry suite, root native-r8 | 16 PASS, 0 skip | Actual registry/schema3 contracts on owned Anvil8453; final generated adapter/composer/dispatcher and real permit runtime. TEST finality, manager, readiness and boundary acknowledgments. |
| Final-send adapter suite in native-r3 | 7 PASS, 0 skip | Actual local-chain sends and lost-response recovery; no live Base claim. |
| Relocated original host subset / final subset / explicit-origin | 42 / 42 / 3 PASS, 0 skip | Mock-chain/runtime composition; not the entire prior101 suite. |
| Original denial boundary | 5 PASS, 0 skip | Actual repaired sidecar, owned TEST files, synthetic contexts. Does not cover owner replacement after fsync failure. |
| Other full-harness suites | See native-r3/summary.txt | Individual protocol, runtime, schema3 and r5 cases passed; do not sum overlapping cases or call the whole harness passing. |

The full author harness had incorrect relocated paths and an incorrect101 expectation. Correcting LIFECYCLE_REVIEW_R2 enabled the host subsets. Its pristine full selection collected48 and failed one generator fixture because a relative r6 input path did not exist; it did not run the original101 checks. The next harness must select the actual prior93 plus root8 and preserve pins.

## Native recovery fixture corrections and retained failures

The original native16 test compared total transaction count to prove no Running action. Root r4 decoded the extra transaction: controller.transition target1 (Queued), the legitimate revocation. Root r5 requires exactly that controller/app/target and the actual Queued chain state; the final assertion requires exactly [1,2] (Queued then Running), two transitions total.

Subsequent assertions initially failed at local restart backoff (r5) and canonical generation startAfter (r6). Root r7 advanced only TEST wall/chain time, correctly triggering the permit gate's unchanged monotonic-clock guard. Root r8 instead waits bounded real elapsed time past the maximum of the actual journal nextAt and canonical startAfter, then mines. It never clears crash state, sets resume flags or changes policy. This passes the actual explicit adoption, gate binding and fresh Running/serving path. All prior logs remain. The native fixture's mock runtime-manager and readiness do not prove installed guest enforcement.

## Confirmed remaining failures

Six independent real file/flock requirements fail in BOTH authority journals: an old released handle can still read, an old released handle can still write while a new writer owns the lock, and reopening after failed directory fsync forgets the uncertainty. The current process's latch works; owner replacement is the missing boundary. No production journal was touched.

A separate actual generated-dispatch test passes unchanged-authority adoption but fails owner-change refusal during awaited runtime.adoptHostAuthority. Logs confirm the hook ran, owner/revision changed, and the old digest was durably bound. Chain/runtime here are explicit mocks; this is a staged source defect, not a production incident. The initial r1 test setup failed generator import from node stdin and accidentally tested the old dispatch; its output is NOT qualification. r2 uses the final generated dispatcher; r3 additionally asserts hook entry before requiring refusal.

Additional source-review requirements remain: owner release must withdraw installed gate grants/resources and cancel in-flight witness signing, not merely wrap journal methods; actual entry factories must enforce ownership and established-journal coupling. Missing sidecar plus marker must not be repopulated by handoff before the established-state check. These composition concerns are not yet executed failures beyond the six journal cases and adoption race.

NEXT-SOURCE-TASK.txt gives the bounded same-session Claude continuation: durable intent/recovery across reopen, actual owner-lifetime coupling, fresh canonical authority after runtime handoff, retained financial evidence and corrected full harness. Do not activate this candidate merely because the16 native tests pass.

## Reproducibility, resources and cleanup

RAW-FILE-HASHES.json record exact copied sources and raw evidence before publication whitespace normalization. Published diff evidence uses zero-context hunks with named paths to avoid whitespace-only diff headers; exact raw originals/hashes remain retained. Per-run pins retain exact original absolute input paths; this is a reproducible staged review, not a portable standalone package. Scripts are retained for review, not authorization to blindly rerun prior units or overwrite output paths. Every test uses an exclusive owned output directory and test namespace.

Native-r8 unit enclave-host-completion-native-r8-20261029 invocation2c66095e3c694946bbdfce4b2d902439 completed exit0/MainPID0. Bound512MiB/noSwap/450RSS/floor27648/oneCPU; compiler exits before Anvil. Inner peak299MiB/minavailable33936; outer peak360MiB/min33944. The owned scratch tree is removed and no owned child remains. All root test units are terminal. No code-size override, signature shim, external RPC or actual funds.

Full production requirements still include independent Base authority, actual guest/ingress/storage/secrets enforcement, prelisting capacity and fresh attestation, paid-work/fallback sponsorship with protected independent Offline gas, automatic refill within real grants, fenced per-app migration, and cold/recovery/refusal demonstrations. None is replaced by this local-chain result.
