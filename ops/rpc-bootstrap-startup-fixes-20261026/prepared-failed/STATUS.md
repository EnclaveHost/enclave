# Preserved incomplete changes; NOT deployable

These immutable source snapshots and real failed qualification receipts preserve work while repairs continue in separate revisions. They are not approved for installation or activation.

Wiring v1 (ee7a1559 sums): existing installer18/integration17/reproof17/forward6/launcher28/reanchor25/r62two/forward8 passed. New bootstrap16 had four failures and one error. Real defects: A3 plan recheck wrongly treats the already-bound A2 capture as a replay; manifest switch idempotent return bypasses an interrupted open journal. Fixture defects: exception-vs-return assertion, stale state leaking between negative cases, absolute helper path expected as basename. Full run exit1, peak235MiB, host minimum17555MiB. Repairs belong in wiring r2, with the source-pinned original-game semantics and replay protections retained.

Composer v3: 18 tests, one error, exit1. Cross-overlay fixture omitted the base-hash alias that the production composer uses. Correct the fixture against that exact production mapping; do not weaken edge checks. Earlier v2 also had a circular qualification hash requirement; v3 moves qualification outside the frozen input. Neither snapshot is a completed production composition.

The production snapshot download and services were not changed by these offline tests. Next: qualify repairs, compose with the separately passing wrapper and cold-reader fixes, then actual guest canaries and final readiness/cutover.
