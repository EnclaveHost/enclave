# Frozen r11 send and admission review

Read-only source review of exact author-delivery manifest `1eeb9a4f5ccf3dadb83350f463a59bf7de64244c6a28ce2723dd600ef17a6e62`. No tests, builds, module execution, source mutations, signing, network or production operations performed here. These are source findings requiring coordinator executable qualification, not observed stale starts, double sends or over-allocation. R11 is NOT DEPLOYABLE.

## Direct unknown sends do not survive restart

`control/windows/node/chain.mjs:223` initializes `ambiguousWrite = null`. The only assignment on unknown write outcome is line263; no file/journal persistence or restore path exists. A process restart loses this fence, even if the earlier write reached an RPC but its response was lost. `nextNonce` also starts null. A pending-count read alone does not preserve the exact earlier request/uncertain outcome across RPC disagreement. Same-process test at `test/windows-permit/r11-policy-send-boundary.test.mjs:143` does not exercise a restart. Required regression: first actual sender instance reaches an inert ambiguous write, second fresh process/module with the same durable store and stale pending count must refuse another side effect until exact recorded outcome is reconciled. Persist identity/intent/nonce before the first irreversible effect, not only after its rejection. Do not grant replacement/cancellation/nonce jump.

The latch clears on any mined nonce consumption (lines226-230), correctly commenting that it is not proof this request succeeded. Later callers still need exact outcome reconciliation. The new code avoids retry within the same job after writeContract throws; this is a useful improvement but not cold recovery.

## Sponsored tests do not execute the shipped sender; obligations remain volatile

The shipped minified bundle is unchanged. `chain.mjs:314` passes a gated account/fetch to its actual configuredLeaseSender; this can be a valid consumed-boundary strategy without editing a bundle, but it must be tested using that exact bundle. The new sponsored tests explicitly replace the lease client with a TEST emulator (test file header and lines180 onward). They cannot establish actual propagation, refusal handling, reconciliation or retries inside the bundle.

`chain.mjs:365` exports an in-memory `withheldLeaseSignatures` array; line385 appends claim/renew signatures. Only release gets a durable onSigned journal (lines376-379). `leaseOp` and posted/refused state disappear at line403 and on restart. For a prior POST followed by permission refusal, lines389-391 report pending/unknown but no durable non-release record is created. A transient policy refusal detected after signing at line352 only appends a withheld entry; it does not latch `op.refused` there, so a later restored predicate can still pass the POST check. Qualify intended epoch semantics explicitly. The retained array is also unbounded and contains signature material; do not make long-lived in-memory accumulation the final recovery design.

Read-only receipt/nonce recovery must continue when new signatures/POSTs are refused. A gate refusal must not escape into another relay signature. Tests should cover actual bundle EIP-7702 signing, lease signing, durable onSigned, POST, next relay, permission changing during signing, prior ambiguous POST, and process restart, with unchanged-permission positive controls. No real signatures/network needed: stub only external account/RPC/HTTP.

## Policy revalidation still precedes awaited protected effects

Dynamic policy predicates now re-read/hash the pinned file and preserve established routes for withdrawal. However `protected-supervisor.mjs:195` checks policy before calling `owned.runtime.ensureStaged` at199; factory then awaits dispatch admission, and runtime awaits fence, plan capability and inventory before actual spawn. The policy predicate is not passed into these lower start boundaries. Similarly line207 precedes `runtime.serve`, whose permit collection and control path have further awaits. Source inspection does not establish final protected-effect exclusion if the file changes during those waits. Add actual delayed lower-boundary policy mutation tests; initial/queue-entry policy tests alone are insufficient. Keep authenticated Stop/Offline independent.

## Fresh snapshot comparison does not bind the actual launch body

`protected-supervisor.mjs:166` caches the caller's body in `this.plans`, then line169 obtains a newer authority snapshot. `runtimeAdapters` uses `planOf(id)` from that map. `protected-isolation.mjs:495-497` plans.read accepts only id, ignores the snapshot supplied by runtime, awaits capability, and calls the cached body verified solely on capability/name. Runtime line167 passes snapshot but this adapter ignores it; line180 eventually spawns plan.body.

R11 `lifecycle-host-dispatch.mjs:294-302,704-706` compares the supervisor's newer snapshot with a subsequent fresh read, not the snapshot/config/content/resources used to build the earlier Host body. If A produced the body, B was read by reconcile, and admission also sees B, the comparison can succeed while the body is still from A. This is a source path, not an executed stale-spawn claim. Require actual Host plan A -> changed authenticated B -> admission B -> no stale body effect, plus identical-context positive. Bind body/content/config/resources and authority to an immutable identity checked at the actual start boundary. Preserve actual precheck integrity as well.

## Terminal reservation discharge checks journal/unknown state only before await

`lifecycle-host-dispatch.mjs:729-733` checks admission/rawUnknown and the journal before `await inventory.findByName(id)` at737. Afterward it checks only token identity and view, then line741 clears reserved/physical/**commitment**. The report's claim that all evidence is rechecked after the await is broader than the source. A journal pending/mined running intent or unknown-stage state can change while inventory is held without changing the admission token. Need post-await rechecks/version binding of exact obligation and journal state before clearing. Test this with the real dispatch, not the added TEST dispatch in admittedRuntime coverage. Preserve unknown/committed allocations; require positive terminal absence to restore usable capacity.

## Per-route plan improvement leaves shared unknown-operation wait to qualify

Host per-route work and authority lanes remove the old single plan guard. Supervisor `#authorityOnce` reads withdrawal before `#resolveUnknown` (lines142-155), which helps a Stop already present at that read. But all active routes then join one global `#resolving` promise (lines115-118); while a route is awaiting it, its authority lane cannot read a later Stop. Host's 15-second caller bound retains/joins the raw lane. A hung shared resolveUnknown can therefore hold several active route lanes and delay later Stop reads. This is not a claim that permits remain indefinitely valid; expiry is a separate defense. Add actual route A unknown raw operation held -> route B initially active -> later authenticated Stop -> bounded exact removal test. Do not forget unknown operations or issue duplicate starts to get progress.

## Required evidence still absent

Author report correctly states the full actual Host + factory/journals/runtime + client/manager/router queued -> Running -> TCP -> off-chain permit refresh -> Stop/Offline positive is not delivered. Native protected roles/workload boundaries are untouched. Real-dispatch fresh/terminal tests are absent. These omissions remain unfinished scope. New helper/emulator tests must not be presented as end-to-end or native qualification. No periodic on-chain renewal/heartbeat for enrolled event-driven apps.
