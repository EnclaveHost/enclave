# Windows manager r7 root review

Status: source partial, not deployable. Product source is UNCHANGED from the frozen169-file author delivery. No production, app, financial or Windows remote action occurred.

## Author provenance

One Max invocation2f5212f4d508411b914df268ce38581d finished rc0, session473a768b-38fe-4563-ab41-f2e0234cf295,610169ms.169files,7changes,0removed; manifestd11f2f60afbfff9bd7e4154057b86cd0a209c79337093ceb19d67b1e3c0b1c9c. All2668readonly pins unchanged. Read27/Grep18/Edit16/Write4; no unexpected tool, outside write or mutation replay discrepancy. Raw66user rows/38assistant IDs/configured55agentic rounds are distinct metrics, not a raised cap. Exact binary/cwd/known PIDs were checked terminal before freezing. Author outer peak357MiB/min available33023.

Chronology correction: author report and composite header claim composite was written first. The mutation audit shows runtime, supervisor and client changes followed by withdrawal and owner tests, with composite the third new test. This claim is retained as authored source but is NOT adopted by this review.

## Actual execution

| Run | Pass / fail / skip | Evidence |
| --- | --- | --- |
| focused | 38 / 1 / 0 | New supervisor/owner tests and carried direct/router/root regressions; composite failed renewal digest assertion |
| composite-owner | 1 / 2 / 0 | Corrected composite fixture + actual router TCP path passes; two new permit owner-loss cases fail |
| unknown-owner | 0 / 1 / 0 | Actual supervisor fails cleanup of a processed stage whose response was lost during owner loss |

All zero cancellations. Carried checks overlap previous runs; these are not additive unique coverage or a full-suite pass. Original failures and guard logs remain. The three earlier r6 failures now pass: observed Stop removes staged compute, late owned spawn is removed with acknowledged boundary, and accepted stage after owner release rejects and retires the exact instance. New tests also exercise Offline, Stop despite capability refusal, cold replay and failed writes with explicit TEST labels.

The initial composite failure was fixture composition: runtime sequence was read from a separate TEST memory journal while the gate persisted sequence to the real permit journal. The external root fixture reads permitJournal.read(id).sequence and asserts the second collected sequence increases exactly once. No product changes, sleeps to hide repetition, or weakened digest assertion. It also exercises actual router.dataServer TCP forwarding rather than the author's direct legacy dataplane shortcut. The corrected test passes through actual node isolation-lifecycle/supervisor/runtime/GuestdControl/MAC/router/snapshot/precheck/admission/two HTTP manager servers, readiness, permit renewal, useful router TCP, Stop/removal and ordinary-neighbor accounting.

Limits: native manager health carries a labeled TEST desktop descriptor with ready:false; no native workload runs. Hyper-V inventory/launcher, authority/witnesses, host headroom, lifecycle runtime bookkeeping and owner exclusion remain TEST interfaces. This is stronger control/data composition evidence, not real Windows/Hyper-V/Base or native workload qualification. The offchain serving-permit refresh is not an onchain heartbeat/renewal. The retirement exercised here does not itself record ledger Offline.

## Remaining reproduced failures

1. Physical obligation owner is checked before permit POST but not after its awaited success. In actual MAC/HTTP, releasing the owned log after manager processing and before delivery still returns serving. Both normal200 and lost-response/read-only-reconciliation variants fail the independent assertion. No new send/duplicate VM/payment is alleged.
2. Actual supervisor loses a processed stage response while its obligation owner is released. The durable/raw operation remains unknown (correct), but owner-loss reconciliation visits only retirements entries that require a known accepted instance ID. On the next real supervisor pass it leaves compute staged after500ms; the test expects exact removal. Cleanup explicitly removes only the test instance. This is not evidence of permanent survival past the existing staging deadline; it is a missing prompt owner-loss reconciliation path.

Required repair: verify physical owner across awaited stage/permit/reconciliation boundaries; latch failure, prevent serving and actively reconcile/cancel/retire every owned raw operation without asserting an unproved absence. Persistence failure must retain exact recovery identity. Closing a gate must not leave untracked accepted work behind.

## Still required implementation

Production composition.openRuntime/collect and host.isolationVerdict remain unwired. Native protected namespace/role routing and V8 handling remain incomplete. No per-workload integration progress was delivered for desktop/GPU/worker/egress/secrets/storage/ports/commands. Source/dependency closure is stale. Older boundary retry/clock/lifetime requirements and Windows ownership qualification remain. Full A/B/C/D and independence requirements are preserved; refusal-only behavior is not completion.

Regular tests used512MiB hard/450RSS/floor27648/CPU1/noSwap in an owned loopback network namespace. Inner peaks/minimum available: focused189/33223, composite-owner176/33306, unknown-owner176/33305 MiB. Units561c9fbf668844beab9a93a2f8fc0f93,bb041885d8254096ac6c0a0279229198,5ec65a0249d0408b94298014d36bed54 are inactive/Main0; owned temp files cleaned. No next author was launched by this review.
