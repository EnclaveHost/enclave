# Ownership completion review: actual operations and parent state

Status: staged implementation, not installed. This is part of the full censorship-resistance goal. No production app, payment, controller, relay or RPC changes.

## Evidence and corrections

Claude r5 completed successfully on the verified required Max account (28 turns, 961189 ms), with 654 pinned inputs unchanged. Its frozen 44-file delivery is retained in author-snapshot. Root executed its 29 authored tests: all passed. Unchanged independent tests then failed all three raw-effect cases and one of two actual parent-journal cases. Passing authored R7 incorrectly expected ownership release after a request timeout, before the underlying allow operation finished; it was not an acceptable safety assertion.

The independent failures used actual generated gate/runtime, real file/flock ownership and the generated durable lifecycle journal, with explicit TEST manager/network/chain fixtures. A timed-out raw allow later reopened external access after a second owner could acquire. Readiness rejection left spawned compute behind. A raw released lock still appeared valid through inode metadata. A stale former parent wrapper archived an older record by overwriting a newer owner's pending record. These are isolated reproductions, not evidence of production duplicate payments or VM leaks.

Root r12 makes four narrow repairs: private held-lock capability validation; compute registration before readiness; tracking the underlying allow operation beyond its request timeout and acknowledging withdrawal after any late completion; and requiring a held physical owner for restrictive/reconciliation writes even when logical authority is withdrawn. Reads remain available. During withdrawal, cleanup and settlement writes remain possible while the lock is held. After release they must use the new owner, not cached state.

R12: 29 authored cases (R7 corrected to require exclusion until real completion), unchanged raw-effects 3 and actual-parent 2 all PASS, zero skipped/cancelled. Failed r11 evidence is preserved.

Root r13 replaces optional, detached parent-lock metadata with mandatory journalFile composition. The actual generated parent journal is opened only after its lock is acquired; caller-opened/cached parent objects and alternate lock paths are refused. All mutations require the private held parent capability; read-only reconciliation after release reopens current state. A second composition using different sidecars cannot evade the parent lock. Parent release exceptions return fenced completion rather than leaving an unhandled rejection.

R13: 31/32 composed cases plus raw-effects 3 and actual-parent 2 PASS. The sole failure was a new root test calling fence without its required generation, before the ownership assertion. R14 corrects that fixture to generation 0, adds a positive cleanup-during-withdrawal case and runs only the four affected ROOT13 cases: 4 PASS, zero skipped/cancelled. Product candidate files are byte-identical between r13 and r14. This yields 38 distinct passing relevant cases across the final product version (29 existing + 4 parent-composition + 3 raw-effects + 2 actual-parent), not 38 independently repeated in r14.

## Limits and next work

No hardware VM, real manager continuing-authorization implementation, live Base authority or production cutover was exercised. Readiness, runtime inventory and boundary effects are TEST fixtures. Earlier native 16, historical compatibility 101 and installed-manager HTTP 3 results qualify only their recorded source/version and scope, not this final candidate.

Remaining work includes real installed manager enforcement after controller death, actual ingress/storage/secrets composition, fresh-process persistence fault qualification, parent established-file loss/provenance and cross-process lock loss, broader changed-interface/native regressions and platform integration. The parent acquisition fix is not a claim of complete journal-loss recovery. Existing root-ownership-lifecycle tests still use the old caller-opened parent interface and require explicit adaptation, not a legacy fallback in the new composition.

Finite stale-work exclusion must not become a permanent recovery dead end: late completion must withdraw its effects and permit a clean owner takeover; a permanently unreachable manager requires a separately verified independent enforcement boundary. Protected canonical Offline reporting, capacity-test/attestation admission, verified paid-work/provisioner sponsorship, authorized automatic refill, actual app migration, independent authority/custody/artifact/DNS paths and full refusal/cold-recovery demonstrations remain required.

Drivers retain absolute input paths for their exact local provenance. Package snapshots alone are not a self-contained build distribution. REVIEW-PINS lists packaged bytes; per-run pins cover source inputs, and original generated-overlay hashes describe the actual executed trees. No immutable source or failed result was overwritten.
