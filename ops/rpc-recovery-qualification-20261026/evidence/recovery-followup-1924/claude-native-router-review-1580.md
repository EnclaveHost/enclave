# Independent review 1580: KVM native-manager routing design (SOURCE/DESIGN ONLY)

**What was reviewed:** `/home/steven/Documents/Codex/2026-10-23/it/work/eyesoff-native-link-20261026/native-manager-routing-plan.txt` (15 lines). This review covers the design text only.
- I did not read or check any implementation, manager source or live configuration.
- I made no edits, ran nothing, and took no live action.

## Verdict: direction acceptable; **NOT ready to implement as written**
The design gets several things right:
- legacy 8091/8092 is unchanged;
- native IDs are separated by prefix, with no fallback routing;
- there is no additive advertised capacity;
- the inventory fails closed (503);
- a pending record is written before a mutating POST;
- there is no TLS termination;
- the activation preflight is bounded.

**Two required properties are not guaranteed by the text.**

### R1 (blocker): capacity admission is serialized only inside the router, not shared atomically by both managers and direct launchers
- **What the plan does:** "POST /vms serializes admission" and "sum of actual legacy+native … reservations against existing total pools". That makes the **router** the only atomic point.
- **Why that is not enough:** each manager still admits against its **own** view of the pools, and the running legacy manager cannot be changed ("no source modifications"). The legacy manager does not know about native reservations, and the native manager does not know about legacy ones.
- **What can bypass the router:** any mutation that does not pass through the router's critical section can overrun the shared pools. That includes:
  - any direct `POST` to 8091 or 8095 (operator CLI, scripts, other agents, a stale client still configured with the old port);
  - a manager-internal relaunch, restart or recovery of an existing VM.
- **The race:** the router reads the snapshots, decides, then POSTs. A launch that bypasses the router between those steps is invisible to that decision.

**Required design changes:**
1. **Enforce one admission path.** "Configured" is not enough; it has to be **enforced**.
   - 8091 and 8095 mutating endpoints must be reachable only by the router. Options:
     - unix sockets with owner-only permissions;
     - nftables `meta skuid` restricting the loopback ports to the router's uid;
     - an equivalent kernel-enforced mechanism.
   - Activation preflight must prove that no other client can reach them.
   - Then list every remaining **direct launcher** (agents, timers, operator tools) and route each one through the router's admission.
2. **Classify manager-internal launches.** Verify, from the legacy manager's actual source, whether a stopped, restarting or recovering VM **keeps** its memory, physical or GPU reservation.
   - If a stop releases it and a restart re-reserves it, the router must count every **defined** legacy VM's full reservation (not just the running ones). Otherwise a native admission can take capacity that a legacy restart later reclaims, and the pools overrun.
   - The same applies to the native manager.
3. **One durable, host-level reservation ledger and lock.**
   - **The lock:** the router's critical section is a single lock (e.g. a `flock` on a root-owned ledger file) that **every** admission path takes, not an in-process mutex. This covers router restarts and a second router instance.
   - **What it covers:** reading both snapshots, adding the pending entries, deciding, writing the pending record durably, issuing the POST, and waiting for the result or for uncertainty.
4. **GPU and physical devices are counted by device identity, not by count.** The two managers must not both consider the same device free. Either the native manager's device set is configured disjoint and checked at preflight, or the router checks the assigned device IDs from both snapshots.
5. **Activation preflight addition:** the lock and ledger exist, the direct-path enforcement is in place, and a probe from a non-router uid is refused.

### R2 (blocker): an uncertain launch is cleared on the response, not when the reservation is observed
- **What the plan does:** it clears the pending record on "explicit successful response or conclusive 4xx", and on uncertainty it sets a sticky block until an operator reconciles.
- **Required: the pending record stays durable and counted until the reservation is observed.**
  1. **Count every pending entry** in capacity at its full requested size (memory, physical and GPU devices), until it resolves. Merged utilization in `/health` must include pending entries.
  2. **A success response does not clear the entry.** It marks it `acknowledged`. The entry is **retained and counted** until a validated snapshot (matching epoch, exact ID) from that manager shows the reservation. Then it is converted, never double-counted and never dropped.
  3. **Legacy POSTs need an observable key.** Legacy IDs may be minted by the manager, so a lost response leaves nothing to observe. The router must send a key the snapshot will show (a router-chosen unique name, or a supplied ID if the legacy API allows it), recorded in the pending entry before the POST. Native `nd…` IDs are minted beforehand, which is fine.
  4. **"Conclusive 4xx" must be an exact allow-list** of codes that the pinned manager version returns **before any mutation** (validation or capacity refusal), taken from its source. Everything else counts as uncertain, including 409 if its meaning is ambiguous.
  5. **Absence is not proof.** A snapshot without the entry can precede a latent asynchronous launch. An uncertain entry may be cleared only when either:
     - the reservation is observed (then it is converted); or
     - the manager has provably no in-flight work: its epoch changed after a restart and the entry is still absent, or a manager-provided operation status is conclusive.
     The operator's reconcile action must require one of these and record it. It must not be a free "clear".
  6. **Durability:** the entry is written, fsynced and its directory fsynced **before** the POST.
     - A router crash between the write and the POST leaves an entry that blocks, which is safe.
     - An unreadable or corrupt ledger blocks admission (fail closed).
     - GET and DELETE of existing legacy VMs stay available, as the plan says.
  7. **DELETE:** capacity is released only when absence is observed, never on a DELETE response.

## Smaller points
- **Inventory:** "nd" collision is checked at install. After R1's enforcement, the router is the only legacy creator and refuses `nd` legacy IDs. Each merged snapshot must still re-validate that no legacy entry has an `nd` prefix (503 otherwise).
- **Epochs:** an epoch change of either manager during the critical section makes that admission uncertain, as in R2.5.
- **Data router:**
  - prefix routing without fallback, with the backend re-authorizing, is fine;
  - add tests for a slow-loris preamble, a 513-byte preamble, a missing terminator, the connection cap and backpressure.
- **Activation:** "stop admissions only" must also quiesce direct launchers, which R1 enforces. Also check that the ledger has no pending entries before the config swap.
- **Scope:** "Never restart Shield manager or NucBox" is kept, and I raise nothing that would require it.

## Tests needed (none exist yet; required before activation)
**Capacity:**
1. **Contending admissions:** concurrent legacy and native POSTs through the router (multiple router processes or instances included). The sum of reservations never exceeds the pools, at the exact boundary and one unit over.
2. **Direct launch is impossible:** a direct POST to 8091/8095 from a non-router uid is refused (the kernel enforcement), plus a fixture showing the overrun that would occur without it.
3. **Restarts and stopped VMs:** a legacy restart or recovery of a stopped VM after a native admission. The capacity check counts defined VMs per the verified manager semantics.
4. **GPU and physical identity:** the same device is never assignable through both managers.

**Uncertainty:**
5. A timeout, response loss, 5xx, a non-allow-listed 4xx, a connection reset after the body was sent, and a router crash before or after the POST. Each leaves a durable, **counted** pending entry that survives a router restart and blocks over-admission.
6. **Success without observation:** a 201 whose reservation is not yet in the snapshot. The entry is still counted, then converted exactly once when it is observed.
7. **A latent launch:** a fixture manager that shows absence, then materializes the VM later. It is never cleared by absence alone. A cleared entry requires a restart epoch or a conclusive status.
8. **Legacy correlation key:** an uncertain legacy POST is resolved by its router-chosen key.
9. **The ledger:** an fsync ordering test (the entry exists before the POST is sent); a corrupt or unreadable ledger means admission is refused while GET and DELETE still work.

**Routing:**
10. **Inventory merge:** duplicate IDs or names across managers, an `nd` legacy ID, an unknown epoch, or one manager down give a 503 for the full inventory and admission. A legacy GET or DELETE by ID still works when native is down.
11. **Data preamble limits and routing:** no fallback; the original bytes forwarded exactly.
12. **Activation preflight:** a dry run against fixtures. The nine legacy IDs and leases are preserved, and any failed precondition refuses.

**Not claimed:** feasibility on the actual managers. R1.2 and R2.3/R2.4 depend on legacy-manager behaviour that must be read from its pinned source.
