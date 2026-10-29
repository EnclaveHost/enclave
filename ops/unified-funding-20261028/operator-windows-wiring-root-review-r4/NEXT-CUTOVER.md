# Next cutover dependencies and execution order

The 140 passing portable checks do not qualify Windows. The next priority is a **disposable, isolated native qualification domain**, leaving all production apps and the old operator running. It must have no production signer, funds, assignments, configuration or journal access. A zero-balance deployment sharing the old operator account/journal is not an isolated domain. No global drain is required for testing an unrelated domain.

Before any native run, close the exact test's admission gaps: fresh available physical memory and commit, a conservative bound for every accepted/pending commitment P, independent observer allocation O and early setup E. Preserve at least the live 18,432 MiB floor or any higher fresh floor, plus the 256 MiB test allocation and P/O/E. The existing launcher's 17,408 MiB cutoff is insufficient. Proposed observer limits are not implemented enforcement. Unknown terms remain unknown. The peer is preparing concrete bounded observation/guard inputs only; no remote execution or new author is authorized by that preparation.

Reuse the pinned runtime, launcher and probe where compatible; any narrow guard change needs its own source review and qualification. Separate containment/owner-death and EXLOCK tests; no automatic follow-on, repeated attempt, broad cleanup or production writer activation. A private native test harness must not bypass SYSTEM CutoverUnqualified to start a production writer.

## Existing-domain transfer is a different boundary

The candidate agent resolves effective DIR at startup, but current health/state interfaces do not provide an authenticated process-incarnation-bound attestation of that directory. Existing loopback/bearer controls can host a bounded challenge-bound status interface. Report exact directory/runtime/source/config/domain and process identity without secrets. The already-running old process does not have this new interface; a candidate callback cannot prove its state.

The candidate chain's releaseOperatorEffects latches an in-memory effects fence, awaits the common chain transaction queue, then releases the owned store. That can prepare writer-only quiescence without directly stopping VMs. Current operatorEffectsStatus omits the in-memory fence when a store exists. Durable restart fencing, truthful in-flight/unknown status and actual effect-boundary checks would be needed. They must reuse the established owned journal, preserve unresolved records and reject incompatible old processes. No blank-store bootstrap or new lock backend is acceptable. Task/updater launch paths also need continuous exclusion; a dated stopped/disabled task snapshot cannot provide it.

The observed SYSTEM SID, stable listener PID/creation and configured task do not prove task-to-process ancestry or effective running NODE_DIR. A narrow observation could correlate task running instance and parent creation identities; matching an account alone is insufficient. No additional remote observation has occurred.

## Per-app handoff is separate again

The actual candidate host legacyHandoff voids renewals, waits for the legacy lease to expire and calls stopApp. Protected activation requires finalized quiescence; current adoption also fences/stops and requires inventory absence. These paths do not transfer a running VM without interruption. Do not enroll existing serving apps merely to qualify a new domain, remove stop/quiescence checks, or call this zero-downtime migration. An eventual running-instance transfer must bind the exact old/new assignments, host generation, manager epoch/instance, capacity, permits/routes and unresolved obligations. Agent SIGINT also retires owned compute, so it is not a writer-only drain shortcut.

The native isolated path takes priority over preparing the existing-domain control author. Preserve any already prepared control task, but do not launch both. The user has authorized migration; these remaining requirements are technical, not an additional general permission request.
