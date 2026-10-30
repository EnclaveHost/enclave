# Maintenance resource admission — source-only preparation

Production recovery is authorized. This document identifies technical requirements; it does not require another general user approval. No VM, probe, test, remote read, or runtime change was executed for this review. Root owns activation and fresh observations.

The immediate target is an OS-only maintenance VM: 8192 MiB guest, 10240 MiB cgroup cap, swap disabled, no Base/L1 disks. Its purpose is to disable unsafe autostarts before the smaller RPC configuration is qualified. It is not the full-stack RPC migration or proof that the funded DNS/KVM apps are Running.

## Existing authenticated interface

`source/isolation/m4/guestd/server.go:302` routes authenticated `GET /health` and `GET /vms` through guestd-control/1. `pool.go:281` exposes `pool.host.floorMiB`, `memAvailableMiB`, `pendingMiB`, and `unreadUnits`, plus pool budget, allocated reservations, and guest count. Use the pinned `control-client.mjs`; do not fall back to unauthenticated lab requests. Root must identify the installed manager, matching client and credentials without displaying keys. These source bytes alone do not attest the installed daemon.

`pool.go:153` defines pending commitments: starting guests count their whole reservation; running and unreclaimed guests count reservation minus memory already held. Held memory is `max(0, memory.current - active_file - inactive_file)`, converted to MiB by rounding down. Unread units count their full reservation. Do not subtract reclaimable file cache from pending, or treat total RSS as committed memory.

The existing `full-bench-prep/guestd_commitments_probe.mjs` already pins/imports the exact client bytes, keeps the key private, reads authenticated health/vms, checks reservation totals, and emits sanitized data. It supports repeated reads. It does not reserve maintenance memory or enforce a stop. Its two endpoint reads are not an atomic snapshot; a mismatch must fail closed. Its benchmark-specific inference fields and two-card checks in `fullbench.py` need not become requirements of an OS-only VM.

Current floor 18432 MiB is root-provided and corroborated by historical FULL.md; it must be refreshed from the installed authenticated manager. Do not reduce it to the old maintenance script's 16384 MiB.

## Minimum admission and continuous enforcement

Before allocation require, in MiB:

`fresh MemAvailable >= max(18432, live guestd floor) + guestd pending + other pending + 10240 + helper allowance + safety margin`.

During allocation, boot, guest script, powerdown, and cleanup replace 10240 with maintenance remaining: `max(0, 10240 - nonreclaimable held MiB)`. This prevents double-counting resident memory while preserving the whole cap. Other pending includes all reviewed non-guestd jobs' remaining budgets; do not count the same guest twice. Unknown/unbounded jobs cannot be represented as zero. Root must choose and record helper and reaction headroom; they are not free space.

Use fresh local MemAvailable and cgroup reads continuously, and authenticated guestd snapshots with monotonic sequence/receipt age, fixed maximum staleness, and bounded requests. Check the same formula immediately before starting QEMU, before `cont`, and throughout blocking SSH/QMP waits. A separate guard is required because these calls block the controller. Every invalid/stale snapshot, lost probe, changed daemon identity, new/changed reservation, unread accounting regression, or failed floor check must prevent start or stop this maintenance invocation. Report the specific reason. Do not stop serving apps.

The guard must own the exact transient unit name plus InvocationID and recorded process identity; verify before stopping. It must remain effective when the controller errors, is killed, or times out. Tie controller/guard/VM lifetimes together using reviewed systemd dependencies or another verified mechanism. Confirm `memory.max=10737418240`, `memory.swap.max=0`, no restart, and terminal MainPID=0. Existing graceful shutdown may take 120 seconds and is not a demonstrated memory-pressure reaction bound; root must specify a bounded pressure-stop path for this owned unit while preserving the OS backup.

## Concurrency limitation

Authenticated GET snapshots are observations, not a reservation. The guestd mutex protects guestd creates only; the external QEMU launcher does not hold it. The test queue lock does not cover guestd creates. Polling and an 18 GiB threshold alone cannot prove race-free admission against a new large guest between samples. Do not claim atomicity from two identical observations or from QEMU preallocation.

The smallest existing-interface route is a continuously guarded, identity-bound, yield-on-change maintenance invocation **only if root also establishes that competing admission cannot exhaust its reaction headroom**. If no shared admission exclusion/reservation interface exists, a conservative sufficient alternative is to account for all additional capacity guestd could admit (free pool budget as well as pending), plus bounded other launches; this may refuse the run. Otherwise an actual shared admission reservation/exclusion is needed. Neither case requires killing current apps or lowering their floors. A new source change is not implemented by this review.

### Conservative fixed-pool envelope requested by root

For a configured, unchanged guestd memory budget B and allocated reservation sum A, use `guestd envelope = pendingMiB + max(0, B - A)`. By the source definitions this equals `max(B,A) - credited held memory`. This reserves all remaining pool capacity even before a future create appears. CPU and GPU limits can only restrict creates further; do not discount this bound using them. An overcommitted recovered pool has free=0, so existing A rather than smaller B remains covered.

The same `!reclaimed` predicate defines A and pending. Accepted starting guests are inserted under the admission mutex; failed or ended guests continue counting until reclaim finishes; recovered verified guests count regardless of budget. Never remove failed/ending reservations based on status alone. **Caveat:** server.go reclaim ignores the backend Stop error, removes the work directory, then marks reclaimed. Source intent is that the unit has stopped, but this call site does not prove it. Independently inventory QEMU/cgroups and charge surviving unaccounted units; guestd totals alone cannot exclude failed-stop orphans.

Do not freeze a credit for resident memory after its unit disappears or changes identity. Refresh pending/budget/allocated coherently and continuously; root must also bound observation age. With incomplete or stale accounting, use the full known reservation envelope with no resident credit, or yield. A fixed envelope that reserves the entire pool without resident credits is stronger but often cannot fit. New creates within the verified fixed budget are covered by the free-budget term; unexpected budget changes, manager changes, adopted guests, or unbounded non-guestd launches are not. Preserve a guard reaction margin and do not claim polling is instantaneous.

Root's historical snapshot B=98304, A=65049 gives free=33255 MiB before adding pending, maintenance, or the host floor; that envelope cannot fit approximately 33.5 GiB MemAvailable. These numbers are historical, not fresh admission evidence.

The reviewed server routes expose no admission-only pause or external reservation endpoint. main.go configures Budget/HostFloor from startup flags and registers SIGTERM/SIGINT, not a live budget reload. No currently reviewed source interface provides an atomic external memory reservation. If fresh conservative accounting still fails, a narrow admission mechanism or a separately reviewed bounded offline OS-mask operation is needed; neither is already implemented or qualified by this report.

## Existing gaps and reuse

The frozen QMP repair still sets HOST_FLOOR=16 GiB. Its `guard()` is called only in `wait_ssh`; `run_guest`, powerdown, and cleanup have no continuous pending-commitment check. Passing QMP tests does not qualify resource enforcement.

`memory-guard.mjs` samples its own descendant tree every 250 ms and kills that tree on violation. A service started by user systemd is a sibling, so the outer 512 MiB guard is not a VM guard. `claude-test-queue.py` has a 4096 MiB maximum job allocation and a 16384 MiB floor; its locks and bounds do not reserve this 10240 MiB VM. Do not widen that general queue just to describe this run.

The full-benchmark source contains a useful model for live pending accounting, stale probes, and yielding when production allocations change. Reuse its interface and accounting semantics only; importing an unrelated benchmark executor would broaden this maintenance task.

The original production `provision_vm.py` has a useful lifecycle pattern: VM Requires/BindsTo/After its guard, guard PartOf the VM, notify readiness and a systemd watchdog. Its actual guard enforces disk capacity; it is not an already-qualified continuous memory guard for this maintenance boot.

## Root activation evidence to collect

Record the installed daemon/client identities, fresh authenticated pool and held-guest snapshot, local memory/cgroup readings, all pending allowances, concurrency protection, guard lifetime/stop bound, exact VM unit/invocation, and before/after serving-app state. Root already reported the fresh backup verified with qemu-img zero check errors. This report does not redo that backup or replace its evidence. After OS maintenance, separately qualify the reduced full-stack RPC's sync, finality, required historical receipts/logs/state/proofs, and independence before migrating consumers.
