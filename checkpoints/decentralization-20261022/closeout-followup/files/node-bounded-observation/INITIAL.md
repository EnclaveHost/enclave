# Bounded M2 observation for the node-only activation (INITIAL; source only, root decides)

**Base:** helper 7ac1d873 (`node-activate-min`, frozen and not edited). The candidate is a NEW file in
`node-bounded-observation/`. The runner a1c950f2, 656d, and the 2afa/829a candidates are untouched.

## Is the 610 s floor needed?

**No, not for safety.**
- In 7ac1, `startNodeSec` (S) bounds the M2 observation. Its expiry already ends as `*_NOT_SERVING_CHECK` with
  `rollbackBy`, never as success.
  - A late read cannot count: WaitServing re-checks the deadline after the host-state read and again at the bracketing
    9600 read.
  - The node is never stopped or rolled back automatically.
- The 610 floor ("measured completed pass 602 s") was a **promised-success duration**. It made a success inside the run
  likely; it protected nothing.
- With serving-first 829a881c, running apps are reconciled before the queued-claim sweep. The per-app row time is
  shorter but **unmeasured**, so no success duration is promised either way.

## The gap found in 7ac1 (it matters once S is small)

- **Post is outside the lease gate.** 7ac1's lease gate is `LeaseLeft ≥ forwardMinSec`, with
  `forwardMinSec ≥ 135 + 100 + U + S` for an apply. The post-checks after M2 (POST_WORST 120 s) are NOT in it.
- **Effect.** A run could end up to 120 s after `rollbackBy`, eating the reserved rollback.
- **Root's formula includes post.** Here it is added.

## Change (top-level script only; every function stays byte-identical to 7ac1)

1. **The S floor** becomes an observation floor: `MIN_OBSERVE = 60` (two 30-s ticks), replacing `MIN_START_NODE = 610`.
   The `startNodeSec` key stays, so the runner schema is unchanged. Its meaning is now "the M2 observation bound".
2. **The apply forward includes post:** `forwardMinSec ≥ 135 + 100 + U + S + 120`.
   - The rollback forward stays `135 + 100 + U`, because nothing follows a rollback's post.
   - `R ≥ P + 135 + 100 + U` and R ≠ 0 for an apply are unchanged. A rollback keeps R = 0.
3. **The not-serving final** says the bounded observation ended: NOT success and NOT a failure verdict.
   - **The pins journal** records the budget terms and the formula.

## Budget (U processUpSec, S observation, P returnPinsSec, M margin)

- **Apply:** `L_min ≥ (135 + 100 + U + S + 120) + (P + 135 + 100 + U) + M`.
- **Rollback:** `L_min ≥ 135 + 100 + U + M`.

| U | S | P | M | apply needs |
|---|---|---|---|---|
| 120 | 180 | 60 | 120 | 1190 |
| 120 | 120 | 60 | 120 | 1130 |
| 60 | 60 | 60 | 60 | 890 (floors) |

7ac1 at S 610 needed 1500 on paper, and 1620 with post counted honestly.

## Honest feasibility warning (to quantify in RESULT)

`L_min` is the MINIMUM over ALL running leases. With 9 independently phased zero-rate leases (renewed to now + 1800
inside the last ≤ 285 s), a minimum ≥ ~900 s occurs rarely. This change shrinks the requirement but may not make windows
common. RESULT gives the arithmetic and the exact live check.

## Tests (existing offline fixtures, queue 512)

These reuse the 7ac1 mock, plus one mock scenario, `late-ready`, where a host-state read takes simulated time:
- early success with S 120;
- M1-only, ending in a not-serving check at exactly S (no success), with `rollbackBy` ≥ run end + R + M;
- not-ready rows;
- lost listener;
- a read that completes after the deadline does not count, checked at the right layer;
- the budget boundary (need / need − 1) with post included;
- the S floor of 60;
- a rollback with a small S;
- mutants on the floor, the post term and the deadline check.
