# Minimal node-only activation of 2afa (chain 3e9fae03 + host 4bebf7db): approach and exact changed constraints (INITIAL)

**Status.** Source only. Root decides; nothing was run live.

**Frozen.** helper 656d642a, runner a1c950f2, tests and evidence are unchanged. The candidate is a NEW file,
`node-activate-min/helper/node-pair-activate.ps1`. It is composed the same way, from the same verbatim df2e58f2
functions plus 656d's tested new functions.

## Why 656d can never run now

- **Live inputs** (identify receipt 23:03Z, public-health 23:19Z):
  - The running set is exactly ONE app, adapter `0x7ae476a3…`. Its zero-rate lease lasts ≤ 1800 s.
  - The tracked sweep also walks 4 claiming/failing ids. Completed pass 601 took ~602 s.
- **The 656d gate** is `full-return`, which needs `L ≥ F + (P + F) + M` with `F = 135 + 100 + S`. Every arm waits for
  a COMPLETED global pass (`inFlight=false`), and so does the return reserve.
  - With S = 660: 895 + 60 + 895 + 120 = 1970 > 1800, so it always refuses.
  - The nested completed-pass reserve was an assistant choice, not a user requirement.

## Approach (the smallest change; everything else is 656d)

Apply keeps the same pins, the exact running set (twice), CAS through bundle-swap 21d85c69, the proven stop, two proven
swaps with proven undo, UNKNOWN → no start / RECOVERY_REQUIRED, and a consistent-pair start. Nothing touches VMs,
manager, privacy agent, configs, the updater or admin. The post-checks, journal and lock are unchanged.

Three things change:

1. **Two separate milestones instead of one "completed pass":**
   - **M1 RESTARTED (on the verified pair).** A new cmd/agent identity whose parent is the pinned Task Scheduler. The new
     agent alone owns 127.0.0.1:9600. Its host-state answers with a lease-pass sequence started after the agent's start
     (its own tick loop runs). 9600 ownership is bracketed around the read. Bound: `lease.processUpSec`.
   - **M2 SERVING (per app, current pass).** Every expected id has a `ready` row in the SAME current sequence, which
     started after the new agent. The row is `observedAt ≥ startedAt`, `checkedAt ≤ now`, for our runner, with
     `leaseUntil` equal to the host-state row, which is `running` with `leaseUntil > now + margin`. 9600 ownership is
     bracketed.
     - The pass may still be `inFlight`: there is no wait for the irrelevant claim sweep or the post-loop
       domain/cert work.
     - Justification: in 2afa, `ready` requires `keeperEligible` (reconciled + served identity == row,
       host.mjs:2437-2448). So a `ready` row means the new process's 30-s keeper will renew this app between passes.
       This closes READINESS-REVIEW R1/R2.
     - Bound: `lease.startNodeSec` (= serve bound), measured floor **610** (pass 601 ≈ 602 s); 660 recommended.
2. **Rollback reserve = a restart, not a pass.**
   - `lease.revertSec` (R) must be ≥ `returnPinsSec + 135 + 100 + processUpSec`. That is one root rollback run: fresh
     pins, stop of the (possibly running) new node, reverse CAS, the old node up to M1.
   - Apply with R = 0 stays refused. `reserve: full-return / recovery-start / terminal-return` are gone from this
     variant.
   - The rollback run reserves nothing after itself. Its gate is `L ≥ 135 + 100 + processUpSec + margin`.
   - Its acceptance is M1. M2 is observed and reported, never waited for beyond its bound.
3. **Honest outcomes.** There is never a "complete" claim before serving and renewal.

   | final | meaning |
   |---|---|
   | `DONE:` | M1 + M2 inside the run, post-checks clean. Activation is still NOT complete until root's read-only poll sees the new process renew the adapter's lease (`leaseUntil` advances) |
   | `RESTARTED_NOT_SERVING_CHECK:` | M1 proven, M2 not (yet) seen when the run's forward time ended. The journal carries the per-id rows and **`rollbackBy`** (unix s = first lease end − margin − R): root's last launch time for a reserved rollback |
   | `NOT_READY` | M1 not proven, or the new agent lost 9600 during M2: a defect signal, so root rolls back |
   | `SWAP_REFUSED_OLD_PAIR_RESTARTED` / `RECOVERY_REQUIRED` / `REFUSED` | as in 656d |

   It is runner a1c950f2-compatible: same params keys plus `lease.processUpSec`, and the same final prefixes (`DONE:`,
   `*_CHECK:`).

## Exact changed constraints (old → new)

| constraint | 656d | new variant |
|---|---|---|
| acceptance after start | completed global pass (`inFlight=false`, completed < 5 s ago) after the agent start, every id ready | M1 (process) then M2 (per-id ready rows of the current pass; inFlight allowed) |
| serve bound floor | `startNodeSec ≥ 480` | `startNodeSec ≥ 610` (measured 602) |
| process-up bound | — (inside startNodeSec) | `lease.processUpSec ≥ 60` (unmeasured; root sets, 120 suggested) |
| apply lease gate | `L ≥ F + (P + F) + M` (full-return) or `F + (100 + S) + M` | `L ≥ F + R + M`, with `F = 135 + 100 + U + S` and `R ≥ P + 135 + 100 + U` |
| rollback lease gate | `L ≥ F + R' + M` (again a full pass), or terminal-return F + M | `L ≥ 135 + 100 + U + M`, R' = 0 (acceptance M1) |
| apply with R = 0 | refused | refused (unchanged) |
| global bound | must hold stop + swaps + S + post (≤ 1140) | must hold stop + swaps + U + post (≤ 1140); M2 is observed within what remains and the lease-capped forward time |

**Budget** (U = processUpSec, S = startNodeSec, P = returnPinsSec, M = margin; zero-rate L ≤ 1800):

| U | S | P | M | F | R | apply needs | zero-rate slack | rollback needs |
|---|---|---|---|---|---|---|---|---|
| 120 | 660 | 60 | 120 | 1015 | 415 | 1550 | 250 | 475 |
| 120 | 660 | 120 | 120 | 1015 | 475 | 1610 | 190 | 475 |
| 180 | 660 | 60 | 120 | 1075 | 475 | 1670 | 130 | 535 |
| 120 | 610 | 60 | 120 | 965 | 415 | 1500 | 300 | 475 |

The apply must reach its lease read within (1800 − needs) seconds of the adapter's renewal landing. It also needs the
updater's next run beyond the bound + R + 60 (hourly at :13:36, so launch in roughly :14 to :35).

## Outage and recovery (explicit)

- **During the window.** From the stop until M2, the node process does not run. Policy, renewal and adoption for every
  running app pause. The app VM is not touched, but whether its traffic is served while the node is down is not proven
  here. Treat stop → M2 (≤ F, ~17 min worst case) as a possible app outage.
- **`RESTARTED_NOT_SERVING_CHECK`.** Usually the first pass is still sweeping. Root polls read-only and either waits
  (the new keeper renews once the row is ready) or launches a rollback by `rollbackBy`.
- **If no process renews before `leaseUntil`, the lease lapses.** Nothing extends it, and no gate ignores it. The
  existing host/network logic applies: the host's next pass stops or reclaims, or another host claims.
  - A reclaim can relaunch the adapter VM: a new certificate (LE 5/168 h) and a cold start.
  - This is the same failure the 10-22 outage showed, and it recovers the same way.
- **A rollback after `rollbackBy`** is refused by its lease gate while the expired app still shows `running`. Root
  waits for the host to settle the app.
  - If NO app is running then, the runner (a1c950f2, `expectedIds` must be non-empty) cannot launch a rollback. That
    one-line runner change would be root's; I do not make it.
  - A crashed or absent node (no pinned identity) is manual, as in 656d.

## Tests planned (offline, through the queue at 512; no broad real-process suite)

- Compose plus provenance: verbatim df2e58f2, 656d-new reused byte-identical, the new and modified functions listed.
- **Scenarios** (mock with REAL bundle-swap children). The mock gains per-row in-flight passes, a slow sweep, a
  `not-ready` row and a lost listener.
  - mid-pass M2 accepted with inFlight true;
  - a row pending until the bound → `RESTARTED_NOT_SERVING_CHECK` with `rollbackBy`;
  - a row of an older sequence or a stale `startedAt` → not serving;
  - leaseUntil mismatch;
  - lost 9600 → NOT_READY;
  - the new launcher's parent is foreign → NOT_READY;
  - stopped-node CAS (a module or config changed while stopped);
  - partial swap with proven undo;
  - unknown swap / unknown task outcome → no start, no retry;
  - no VM / manager / privacy change (post);
  - lease and budget gates (the table rows at ±1 s);
  - rollback acceptance at M1.
