# Root review qualification of `LEASE-OUTCOME-TRACE.md` (2026-10-25)

**The original finding stands as written:** `LEASE-OUTCOME-TRACE.md` §4 says "a benign receipt and label degradation, not a functional parity blocker in the traced code". It is preserved unchanged.

**Root does NOT accept that wording as general clearance.** The qualification, recorded here:

1. **Adverse conditions are the case that matters.** The > 256-block condition arises exactly under **outages, restarts, a delayed resolver or a stalled verifier**, not under normal polling. Production readiness must be judged under those adverse conditions, and the normal-flow argument (3 s poll, 2 confirmations) clears nothing.
2. **The 503-vs-200 difference is concrete.** On the owner-move route (`supervisor.js:8345-8366`), a deep resolution inside the 90 s answer window returns **503 `release_unconfirmed` (`leaseHeld:false`)** instead of **200 `released`**. Its API callers (site/mobile/dashboard and others) were **not traced** in the original trace. Until they are, the impact on those callers is **UNKNOWN**, not benign.
3. **Evidence loss is a loss.** `tx.released` and `success` are never recorded for a release that did land. Any audit, report or operator process that relies on that evidence is affected, whether or not runtime behaviour changes.
4. **No guard is relaxed.** The canonical gate keeps refusing deep `requireCanonical` reads. A fix, if one is needed, is an authenticated deep-ancestry path or an explicit reviewed config decision, never a weaker gate.
5. **Gate status:** the lease-consumer cutover remains **HOLD** until the cutover configuration is prepared and reviewed (`lease-consumer-cutover-prepared/`), the owner-move callers are classified, and the adverse-condition regression has been run by root.
