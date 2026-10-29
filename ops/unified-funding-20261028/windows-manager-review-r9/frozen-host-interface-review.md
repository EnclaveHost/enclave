# Frozen r9 host interface review

Read-only source review of `author-delivery` manifest `ebf5b6a6fe485ab88fe5b92367d96ddfc9a7f5983ade967a367542bd399477f9`. No source edits, execution, tests or builds. These are concrete source-path findings; execution and reproduction belong to the coordinator. Line numbers refer to the frozen files below.

## 1. Publisher veto precedes independent authority and withdrawal

`control/windows/node/host.mjs:2873` introduces `#protectedLaunch`. It resolves the legacy catalog at line2879 and returns held on `v.yanked` at line2880. There is no owner-elected policy condition and no integrity comparison here. An unchanged owner-authorized deployment is therefore withheld on publisher metadata alone.

The same early return also prevents `#isolationReconcile` (line2884) from reaching `ProtectedSupervisor.reconcile`, whose authenticated snapshot/Stop/Offline logic is at `protected-supervisor.mjs:118`. A catalog exception or yanked result does not call fence/stop in this path. Existing permit timers remain a separate defense; this finding does not claim perpetual serving. It does mean these invocations cannot consume canonical withdrawal evidence before catalog admission, contrary to the required reconciliation order.

Suggested actual-host regression: after a protected app is established, make publisher metadata yanked while bytes/pins and owner authority remain unchanged; verify independent operation remains possible. Separately return canonical Offline while catalog lookup refuses; verify authority reconciliation and exact compute removal still happen.

## 2. Old ledger/book remain mandatory after handoff

`host.mjs:2876` reads `chain.readDeployment` on every protected launch; line2879 resolves its appRef through `chain.resolveAppRef`. Both failures return before the owned snapshot is read. Its old row supplies configCid, appRef, resource shares, owner and public flag (lines2877–2883), which feed the launch plan. Calling these configuration inputs does not remove their availability or integrity authority over the launched workload. The new authenticated snapshot is not the source of this configuration.

The caller `#tickOnce` is also gated by `chainReady` (line2549), awaits `followBook` (line2553), refreshes owners/registration and awaits legacy ledger scanning before reaching the protected loop (line2582). A failure or hang earlier in the sequence can prevent this loop. Cold recovery therefore still needs old discovery/ledger services, and protected withdrawal shares their scheduling delays.

Suggested regression: activate a route, then make old-book/old-ledger/catalog reads unavailable while the independently authenticated new-ledger configuration and authority remain available. Require useful recovery plus Stop/Offline without consulting the retired sources. Keep optional owner-chosen policy separate from immutable content integrity.

## 3. Broken enrollment is excluded inconsistently

`protected-supervisor.mjs:229` returns `undefined` when enrollment loading/hash verification fails. `host.mjs:708` correctly excludes `!== false` from new legacy claims, and line1262 similarly skips legacy isolation presteps. But line2233 permits renewal whenever enrollment `!== true`; `#reconcileTracked` at line2378 and `#giveUp` at line2626 divert only when enrollment `=== true`. Thus unknown enrollment can still enter existing tracked legacy reconcile/renew/release code. `#renewKeep` line2256 has no enrollment check in its fresh pre-send fence, so the due-list filter is not a complete final boundary either. `enrolledDeployments` returns an empty list on failure, so no compensating protected loop runs.

Suggested regression: cold-load malformed/hash-mismatched enrollment with a previously tracked eligible record; drive the actual host renewal/reconcile/give-up interfaces with inert signed-send spies. Require no new legacy claim/renew/release on unknown policy while retaining exact cleanup and unresolved obligations. This review has not executed that reproduction or claimed a transaction actually occurred.

## 4. Capacity recovery/accounting is bypassed

The factory attaches/activates dispatch but never drives its reconciliation (`protected-authority-factory.mjs:210–233`). Its `handoff.newWorkRefusal` at line225 checks only the owner's paused state. The supervisor then directly calls the owned runtime's stage/serve at `protected-supervisor.mjs:162–174`.

Real dispatch learns authenticated resource shares in `lifecycle-host-dispatch.mjs:237` through `boundChain.read` line402, observes journal/inventory commitments at line245 via reconcile line464, and enforces unresolved allocation/headroom at lines265–277. None is driven by activate alone. `capacityUnresolved()` line653 is not consumed by this host path. Consequently the designed authenticated allocation reservation and recovery checks are not part of the new start boundary.

There are still manager prechecks and `Host.#spawnCapHold` (line1500); this is not a claim that every physical cap vanished. But that host check bypasses on an existing `rec.isolation`/relaunch and returns null on inventory error, relying on later reconciliation to hold. The new supervisor handoff does not supply the missing dispatch capacity decision. `#protectedLaunch` overwrites shares from the old row at line2881 rather than retaining the maximum authenticated physical/pending commitment. `Host.occupies` line2970 ignores lifecycleAllocated/lifecycleCapacity flags; `shareUse` line3078 only sums records it considers occupied. Thus merely publishing a lifecycle commitment does not ensure accounting for a held/recovered route without an instance id.

Suggested regression: restore an unresolved or pending route beside an ordinary neighbor; attempt a new protected and a legacy start. Both must remain held until inventory and authenticated resource commitments resolve; preserve the higher old allocation during shrink/unknown state and apply configured headroom. Then require a real positive start after resolution.

## Coverage limits of the new positive test

`test/windows-permit/r9-real-owned-factory.test.mjs` genuinely imports the real owned factory, journals, gate/runtime and dispatch. Its host view, chain, manager, finality and quiescence modules are TEST fixtures; it asserts zero chain/VM/permit calls. It can establish constructor/activation/owner-release repair, not the actual Host paths above or useful stage/serve/Stop. Existing composite uses a TEST pre-activated handoff. No native-manager/per-workload implementation was added in r9. These limitations are also admitted in the author's report.
