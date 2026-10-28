# full-bench-prep revision 2 (source only)

Date: 2026-10-27/28. **Source only.** Nothing was executed, built, booted or tested. The offline tests were written but
**not run**. I read no credentials, configs or live state.
Inputs: `../FULL-ROOT-FACTS.txt`, `FULL.md`, `fullbench.py`, `test_fullbench.py`, `bench-harness/{resource_guard,benchlib}.py`,
PGI `isolation/m4/guestd/{pool.go,server.go,inference.go,control-client.mjs}`.
Labels: **[src]** read in source, **[root]** FULL-ROOT-FACTS, **[user]** stated by the user, **[est]** my inference.

**Readiness: NOT ready to execute.** The harness logic is revised, but the reviewed reservations file (§6) doesn't
exist yet, the offline tests haven't been run, and the inputs in §7 are missing. With no `--reservations`, the helper
stays in strict mode, which refuses on today's host: the GPUs have processes, and RAM is marginal.

## Files (all in `full-bench-prep/`)

| File | Change |
|---|---|
| `fullbench.py` | Rewritten execute path: exact-identity ownership, fail-closed cleanup, a watchdog that runs from start to finish, bounded waits and outputs, the shared-GPU option, the snapshot-RAM option, trust-file pins. The plan kind is now `shield-full-bench-plan/2`, so old plans are refused. `stage`, the argv shape and `qemu_violations` are unchanged |
| `guestd_commitments_probe.mjs` | New. Read-only guestd probe (§3) |
| `test_fullbench.py` | Old fixtures kept (adapted to the new signatures) plus 25 new cases (§5) |
| `FULL.md` | Revision banner, the floor correction, the file table |
| `REVISION.md` | This file |

## 1. Ownership, cleanup, watchdog (critical; done first)

- **Create.** `start_unit` first requires `systemctl show` to report `LoadState=not-found` for the unit name.
  - If the unit already exists, the helper stops with a `Stop` and never records or touches it.
  - Only after `systemd-run` does it capture `InvocationID`, `MainPID`, the PID start time (`/proc/<pid>/stat` field 22) and `ControlGroup`. The cgroup must end in `/<unit>`.
- **Ambiguous start.** A `systemd-run` that times out (`TimeoutExpired`) is treated as a failed start. The unit is claimed only on narrow proof:
  - its name was absent before the create and carries this run's random 64-bit id, **and**
  - its `ExecStart` has `path=<our planned binary>`.
  - Without that proof the record becomes `None`. Nothing is ever touched under that name, and cleanup fails with rings and bank kept.
  - The same proof is re-checked at cleanup, so a unit that appears late is still handled.
- **Stop.** `stop_owned` refuses names that aren't ours (unchanged). It now also:
  - refuses when the `InvocationID` differs from the recorded one, and touches nothing;
  - stops the unit, then waits up to 30 s for it to settle;
  - runs `reset-failed` only when the invocation still matches;
  - then **proves no live PID**: the recorded MainPID with the same start time is gone, and `cgroup.procs` is empty or the cgroup is gone.
- **Rings and bank** are unlinked only when the guest **and both workers** are proven gone (workers map the rings too).
- **Helper children.** Clients, fwd and the probe are reaped first (kill, then `wait(10)`); one that won't exit is a cleanup error.
- **Any cleanup error fails the receipt.** The arm becomes `outcome=cleanup_failed`, keeping `workload_outcome` and `cleanup_errors`. The run stops after that arm, the receipt gets `ok=false`, and the exit code is 1, even when the workload succeeded.
- **The watchdog runs throughout.** `wait_for` ticks the full `guard` every second during:
  - worker activation (≤120 s) and the worker settle (10 s);
  - fwd's first line (≤30 s, read from a file, not a blocking `readline`);
  - every request step.
- **What `guard` checks:**
  - the arm wall deadline;
  - the QEMU inventory;
  - each owned unit's `InvocationID` and that it is still active;
  - the guestd probe (snapshot/shared modes);
  - the GPU inventory every `poll_sec`, with the bench's own worker cgroup PIDs excluded;
  - the memory formula.
- **Bounds.**
  - Child stdout goes to new 0600 files, never pipes, so a chatty fwd or client can't block on a full pipe.
  - Reads are capped: client 1 MiB (over the cap means not ok), fwd first line 4 KiB, probe tail 64 KiB, serial 8 MiB.
  - Each step is bounded by `per_request_timeout_s`.
  - Each arm is bounded by `runtime_max_sec + 900`, and the whole run by the per-arm sum. systemd's `RuntimeMaxSec` stays as a backstop.

## 2. GPU policy: strict default, reviewed shared option

- **Default (no `gpu` section): strict.** Any compute process on a planned card that isn't one of the bench's own worker PIDs refuses at preflight and stops the run in the watchdog.
- **Shared option.** It exists only when the reviewed reservations file has a `gpu` section, and it needs the guestd snapshot.
  - **Bench workers.** Two new workers capped at `--vram-gb 16`. Preflight requires 16 GiB ≥ cap ≥ the 15.5 GiB manifest cap (500 milli × 33285996544 B = 16642998272 B [src `inference.go`, root]), so `--vram-gb` must be 16.
  - **Isolation.** Bench rings are `/dev/shm/fullbench-<run>`. Workers run with `PrivateNetwork=yes`, `--host 127.0.0.1`, and ports that must not be 9501/9502/9611 or ≤1024.
  - **Process inventory.** Every other process on the card must be a reviewed `{pid, start, used_mib_max}`, and pid plus start time must match (so a restarted production worker refuses). A `required` entry that is missing also refuses.
  - **Budget growth refuses:** a process above its reviewed `used_mib_max`, or card `memory.used` above the reviewed maxima + `unlisted_mib_max` (+ bench cap + context once the bench runs).
  - **Total VRAM.** The card's total VRAM must be ≥ bench cap + context headroom (≥512) + Σ reviewed maxima + unlisted + ⌈guestd `cardAllocatedBytes`⌉. This is conservative: committed allocation and observed worker usage are counted **separately**, even though the worker's usage probably already contains the allocation [est].
  - **guestd changes.** Any change to guestd's `cardAllocatedBytes`, `cardBudgetBytes`, held guests, instance or model floors yields.
  - **Production workers are never killed, restarted or reconfigured.**
- **Production-wins caveat (root decision).** The card can't hold the bench's ≈17 GiB plus guestd's full 31 GiB budget.
  - If guestd admits a new GPU guest during the slot, its worker allocates **before** the bench can see it: up to the probe interval, plus a GPU query of up to 30 s, plus a stop of up to 120 s.
  - That production allocation may then fail transiently. The watchdog can't prevent this, it can only shorten it.
  - Root should hold GPU-guest admission for the slot, or accept the risk.
- `PrivateNetwork=yes` is kept. CUDA inside the user-unit network namespace is **untested** [root]. Smoke it with no model before the slot.

## 3. RAM: strict default, reviewed guestd-snapshot option

- **Strict (no `memory` section).** Preflight is unchanged: `13 GiB + (G+768) + 2W + pending_extra + 18 GiB`.
  - **Fix:** the watchdog now also counts what the bench's own units may still draw: `18 GiB + pending_extra + bench remaining`.
  - The old watchdog let the guest grow into the floor.
- **Snapshot option.** The same formula is used at preflight and on every watchdog tick:
  ```
  MemAvailable >= 18 GiB
                + guestd pendingMiB (live; guestd's own pool.go pendingLocked: held guests' reservation minus
                  non-reclaimable current, starting/unread guests in full)
                + Σ other reviewed units (control, custodian): budget_mib − held, same algorithm
                + bench remaining: guest (G+768), w0, w1 (full until started, then cap − held)
                + helper_cap_mib (>= 256) + extra_headroom_mib (>= 512)
  ```
  - `held` = `memory.current − active_file − inactive_file`, floored at 0, `>> 20` (rounded DOWN). This is a line-by-line port of `readUnitMemMiB` [src `pool.go:190-253`].
  - An unreadable cgroup, or a `memory.stat` missing either key, counts the whole budget.
  - Control and custodian have `memory.max=max` [root], so their budget is a reviewed nominal + overhead, never a claimed hard cap. A unit holding **more** than its reviewed budget refuses, because the budget evidently doesn't bound it.
  - guestd must report a host floor > 0, otherwise `pendingMiB` isn't computed.
  - Guest size must be 51200–57344 MiB (50–56 GiB). The floor isn't lowered, and no production floor was changed.
  - The plan's `required_available_bytes` is a display value that uses full budgets. The live checks use the live cgroups.
- **Yield (watchdog), any of:**
  - a new, changed or removed guestd held/starting guest, even before its QEMU exists;
  - a changed guestd instance, GPU allocation, model floors or unread count;
  - a probe that is stale (no new line for 3×poll + 20 s) or that reports an error;
  - any change to the QEMU inventory;
  - the formula failing.
- **Probe.** `guestd_commitments_probe.mjs` reads the pinned `control-client.mjs`, checks its sha256, and imports **those exact bytes** through a `data:` URL.
  - It reads the key file **in its own process** from an explicit path, requires a loopback URL (`127.0.0.1` / `[::1]`), and sends only `GET /health` and `GET /vms`.
  - It prints sanitized numbers only: the instance identity and guest ids as sha256/16, statuses, reservations, pool numbers and GPU bytes.
  - Errors are a fixed word.
  - In the arm it runs as one long-lived session (`--every 5 --max-sec <arm wall>`) to avoid one guestd session per tick. At preflight it runs one-shot.
  - fullbench never opens the key file. Both the probe's sha256 and the client's sha256 are pinned in the plan.
- **Worked numbers from FULL-ROOT-FACTS, for orientation only [est].** Root must refresh every value live.
  - Inputs: MemAvailable 84081, guestd pending 1551, held image 6912.
  - Control budget, if root picks 4096+768: about 670 remaining at the 4194 MiB read (cache not subtracted). Custodian 3072+768: about 663.
  - W = 1024, helper 512, extra 1024.
  - At G = 51200 the need is **76868 MiB**, a margin of about 7.0 GiB. At G = 57344 it is **83012 MiB**, a margin of about 1.0 GiB, which is too thin to plan on.
- **Floor correction.** The installed source contract maps Qwen to 51200. **Live** guestd advertises `modelFloorsMiB` 73728.
  - The live 64281 request comes from the CPU-share clamp (`ShieldShareMemory` + admission marker) [root].
  - These are kept separate. 51200 is only this bench's lower bound, not a production claim. Reconcile before any rollout.
- **guestd's own admission** subtracts only its own `pending`, not the bench's future growth. So guestd could admit a guest that, together with the bench's growth, crosses the floor until the bench yields (≤ ~5 s to detect, then stop). Root should hold the queue for the slot.

## 4. Trust and baseline

- **Unchanged:** installed runtime/kernel/firmware pins from `release.json`, the whole-model private copy, the trusted default client, no `--lab-unsigned`, no `--t0-diagnostic`, fresh pad bank per arm, no plaintext on disk, no GPU security change.
- The plan now pins the sha256 of the VCEK, the AMD chain PEM and the min-TCB file, and preflight re-checks them.
- **Root-verified public paths [root]:**
  - `--vcek /home/steven/.cache/enclave-isolation/m3-clean/vcek.der`
  - `--amd-chain Turin=/home/steven/enclave-prod/iso-sdshield-1c3cdbb8/test/fixtures/amd/Turin-cert_chain.pem`. The `<Product>=` prefix is per FULL.md §3; the pin hashes the part after `=`.
- **min-TCB: open.** It needs root reconciliation against the current production policy. The Sept 24 canary floor (Turin fmc 1, bootloader 3, tee 2, snp 5, microcode 117) is historical and **not** automatically the current authority.

## 5. Offline tests added (not run)

| Requirement | Test(s) |
|---|---|
| startup watchdog | `Arms.test_startup_watchdog_yields_before_guest`: QEMU inventory changes during worker settle, the guest is never started, cleanup is clean |
| changed owned identity | `Ownership.test_changed_invocation_not_touched`, `test_unit_present_before_create_is_not_ours`, `test_ambiguous_timeout_claimed_only_with_proof` |
| cleanup fails after success | `Arms.test_cleanup_failure_after_success_fails_receipt`: `cleanup_failed`/`workload_outcome=success`, `arm_ok` false, rings kept |
| new held guest before QEMU | `Production.test_new_held_guest_before_qemu_yields` (+ `test_stale_probe_yields`, `test_reviewed_snapshot_passes`) |
| unknown GPU process / budget growth | `Gpu.test_unknown_process_refused`, `test_restarted_production_worker_refused`, `test_budget_growth_refused`, `test_insufficient_device_vram_refused`, `Production.test_gpu_allocation_change_detected`, `Gpu.test_strict_default_refuses_any_process`, `test_shared_reviewed_inventory_passes`, `test_bench_workers_excluded_by_owned_cgroup` |
| reclaimable cache excluded | `Resources.test_reclaimable_cache_excluded` (including the round-down) |
| missing cgroup data → full | `Resources.test_missing_cgroup_data_reserves_full`, `test_snapshot_floor_off_refused`, `test_unbounded_unit_over_budget_refused` |
| conservative extra headroom | `Resources.test_snapshot_formula_and_extra_headroom` (exact formula, headroom adds 1:1, <512 refused) |
| workload timeouts | `Arms.test_fwd_first_line_bounded`, `test_request_timeout_kills_clients`, `test_total_wall_deadline`; `Argv.test_probe_argv_is_loopback_and_bounded` |

Run: `cd full-bench-prep && timeout 300 python3 -m unittest -v test_fullbench`. Also re-run `bench-harness`, because `resource_guard`/`benchlib` are reused unchanged.

## 6. Reservations file (root writes and reviews; `plan --reservations FILE`)

```json
{"kind": "fullbench-reservations/1",
 "guestd": {"url": "http://127.0.0.1:<root-verified port>", "key_file": "<abs path, never read by fullbench>",
            "client": "<PGI>/isolation/m4/guestd/control-client.mjs", "client_sha256": "<hex>",
            "probe": "<H>/full-bench-prep/guestd_commitments_probe.mjs", "probe_sha256": "<hex>",
            "snapshot": <one-shot probe output line, reviewed>},
 "memory": {"other_units": [{"name": "control", "cgroup": "/user.slice/.../<control>.service", "budget_mib": <nominal+overhead>},
                            {"name": "custodian", "cgroup": "...", "budget_mib": <...>}],
            "helper_cap_mib": 512, "extra_headroom_mib": 1024},
 "gpu": {"context_headroom_mib": 1024,
         "cards": {"GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c": {"allowed": [
                      {"pid": 5685, "start": "<stat f22>", "required": true, "used_mib_max": <reviewed>},
                      {"pid": 355837, "start": "<stat f22>", "required": false, "used_mib_max": 64}],
                    "unlisted_mib_max": <reviewed>},
                   "GPU-042eb279-e6e6-9866-5823-015b8d26946a": {"allowed": [{"pid": 5683, ...}, {"pid": 355837, ...}], ...}}}}
```
Either `memory` or `gpu` may be omitted; that part then stays strict. Strict memory still needs `--pending-extra-mib`.

## 7. Missing inputs (fail closed until root supplies them)

1. The guestd loopback URL and the pairing-key path (root-verified), and the sha256 of `control-client.mjs` and of the probe.
2. The control and custodian cgroup paths and their reviewed budgets (nominal + overhead).
3. Worker host RAM under load, to set `--worker-memory-max-mib` (idle VmRSS is about 242 MiB [root]; load is unknown).
4. Per card: `memory.total`, the existing worker's and the desktop's PID start times and reviewed `used_mib_max`, and the unlisted (graphics) allowance.
5. Whether `nvidia-smi --query-compute-apps` lists PID 355837 at all (graphics-only contexts aren't listed). If it doesn't, `unlisted_mib_max` must cover it.
6. min-TCB reconciliation (§4), a CUDA-under-netns smoke, the CPU set (production QEMU floats over 0-31 [root], so contention is shared and must be reported), and the P6 bench bundle (FULL.md).
7. Root's decision on holding guestd admissions (RAM and GPU) for the slot.

## 8. Limitations

1. Nothing ran. Python and Node errors are possible.
2. Assumptions I couldn't check by running anything:
   - Node imports `node:crypto` from a `data:` URL module [est].
   - `GuestdControlError` has a `.kind` (if it doesn't, the error word falls back to `error`).
   - `systemctl show -p ExecStart` prints `{ path=<bin> ; ...`.
3. `nvidia-smi` runs inside a watchdog tick, so a slow query delays the tick by up to 30 s.
4. If SNP `guest_memfd` pages aren't charged to the unit's memcg, then `held` undercounts and the formula double-counts. That is conservative (spurious yields, never overcommit), and production pool.go has the same property.
5. fwd's output file grows for the arm's lifetime. Only its first 4 KiB is read.
6. The bench can't stop guestd from admitting during the slot. It yields after the fact (§2, §3).
