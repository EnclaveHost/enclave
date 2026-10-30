# Shared allocation owner r1: source slice report

Status: **SOURCE ONLY. Authored, not run.** No command, test, build, network, remote, native, live or finance action was taken in this invocation. Nothing here is installed, activated in a resident process, or natively qualified. Root may run the new tests locally; the 140 existing tests were not edited.

## What was implemented (positive behaviour)

1. **One owned, bounded, durable allocation ledger** (`control/windows/vbslike/manager/allocation-owner.mjs`), distinct from the permit/guard/operator journals (purpose `enclave-shared-allocation/1`). There are two stores, and both use the existing primitives unchanged:
   - `owned-log`: `win-durable.mjs` `openOwnedLog` / `initializeOwnedLog`, with `WINDOWS_EXCLUSION` or the qualified-numeric `win-exclusion.mjs` adapter, plus `checkWindowsStorage`.
   - `owned-durable-state`: `owned-durable-state.mjs` `openOwnedLock` + `openDurableState` (Linux flock).

   Establishment is a separate explicit step (`establishLogDomain` / `establishDurableDomain`, or `allocation-owner-main.mjs --establish-isolated-domain`). It requires `isolated: true` and refuses any existing ledger. A normal open never creates, clears or reinitializes anything. It refuses a ledger that is missing, foreign-purpose, unestablished, torn, quarantined, uncertain, or belongs to another domain id. A pure reducer (`applyEvent`) is used for both replay and live commits. On open, the owner persists an `owner-open` event that sets a new owner incarnation and generation. Every event has a contiguous domain sequence. Bounds:
   - at most 128 unresolved records;
   - evidence at most 2 KiB;
   - reason text at most 512 characters;
   - a 64-entry settled tail in the snapshot store;
   - the win-durable 7/8 MiB admission and size caps on the log.

   Replay keeps every unresolved reservation, including those from earlier owner and manager incarnations.
2. **Serialized acquire / enter (validate) / observe (release) / register / status.** Each acquire runs inside the owner's serial chain:
   - The owner calls its **own** sampler after the lock is taken. The sample must be fresh (`at >= lock time`, younger than `maxSampleAgeMs`) and finite.
   - It also calls its own coverage function. All eight coverage terms (request buffering, component fetch, PowerShell, relay, Hyper-V overhead, observer, creator, other host) must be present for both physical and commit. A missing term refuses; nothing defaults to zero, and no caller Boolean is accepted.
   - The floor is `max(18432, domain floor, live floor)`.
   - Unreflected physical and commit are counted in full for every held record, whatever its kind (VM, baseline, qualification, uncertain, entered). A reflected record is treated as already in a sample only if that sample was taken after the reflection.
   - The commit term for a VM is its physical size plus the domain's stated `vmCommitOverheadMiB`.
   - The full terms are persisted **before** the grant, so later requests from either role see them.
   - A qualification hold consumes the same capacity and is released only by its holder.
   - New admissions are held until every configured role has registered with **this** owner incarnation, and while any baseline record has an unknown physical size.
   - `enter` checks the exact role, manager incarnation, owner continuity, request identity, partition memory equal to the reserved size, state order (define, then start with the VM Id), and expiry. It persists the entry before answering.
   - Release happens only on exact evidence:
     - the owner's own record that no boundary was ever entered (expired, or the owner incarnation ended);
     - the launcher's exact cleanup or stop removal by VM Id;
     - define not invoked after a recorded entry;
     - a successful identity survey after the launch settled, with no unattributed VM;
     - an explicit qualification end by its holder.

   Expiry only refuses further boundary entries. Timeouts, client loss and RPC/PID status never release a reservation. Uncertain outcomes are kept durably with their reason. A persistence failure or lost ownership closes the owner to every new admission.
3. **One owner, two independently configured clients, over an authenticated local path** (`allocation-service.mjs`). The path is guestd-control/1, unchanged:
   - The server is `control.mjs` `ControlServer`, with one instance per role and a distinct key per role. The role is therefore bound by the authenticating key; a body `role` that disagrees gets 403.
   - The client is the existing `GuestdControl`, and requests are never repeated on an unknown outcome.
   - The listener is loopback-only. Request size (64 KiB, checked on both declared and streamed length), response size (64 KiB), connection count and timeouts are all bounded.
   - Entry module: `allocation-owner-main.mjs`. It takes a pinned config, its own OS sampler (Windows `Win32_OperatingSystem` or Linux `/proc/meminfo`, both labelled unqualified), owner-declared coverage terms, and explicit establishment only.
4. **In-place integration** (`allocation-integration.mjs`, plus `backend.interposeAllocation` and `WmiHyperVLauncher.installAllocationGate`):
   - In one synchronous segment it captures the baseline (every record, including already-entered starts), interposes the **actual** `backend.launch`, and gates each WMI launcher's final define (before `New-CustomVM`) and start (before `Start-VM`/`startAndRead`). `launch` and `stop` then become non-writable. Replacing `backend.launcher` does not reach `start`. Calling a launcher's `start` directly without the live token is refused before define.
   - The same Manager, epoch, `domains` Map, records, handles, `judging`, `removedIds`, `onReclaim`, relays and journal owners are kept. Installation makes no survey, stop, recover, reclaim or teardown call.
   - Already-entered starts are accounted in full in the baseline and pass the gate. Only new admissions are held.
   - Per launch:
     1. Acquire.
     2. Re-check the exact record, epoch and token after the await.
     3. Call the **original** launch with the token.
     4. Enter each WMI boundary through the owner, re-checking after each await.
     5. Settle: reflect on an exact `Running` result at the reserved size; on failure use `never-entered`, `define-not-invoked` or `cleanup-removed`, or record the outcome as uncertain.
   - Explicit Stop runs the original stop first. Its result is returned unchanged, and only an exact `removed` / `already gone` result for the same VM Id settles the reservation.
   - Settlements that cannot be delivered are queued. `reconcile()` retries them, follows an owner restart (it re-registers, and the owner deduplicates by role and record id), reflects completed baseline launches, and settles absent records only from a successful survey with no unattributed VM.
   - `health().allocation` reports `nativeQualified: false` and the scope.
5. **Wiring:**
   - `compose.mjs` adds `validateAllocationConfig` and `composeSharedAllocation`.
   - `main.mjs` reads `ENCLAVE_ALLOCATION_CONFIG` + `_SHA256` (pinned; the role must be explicit). It registers every constructed `WmiHyperVLauncher` (legacy, Shield GPU, native desktop). It installs after `startManager` and before any listener exists, and runs `reconcile` every 15 s.
   - If the extension is configured but no client can be composed, admissions stay **closed**; there is no fallback to unowned admission.
   - The unconfigured legacy mode is byte-for-byte the previous path: nothing is interposed and nothing claims shared coverage.

## Actual consumer paths covered

- Direct 8091/8095 `POST /vms` → `Manager.spawn` (local checks, then synchronous record insertion) → `backend.start` → interposed `backend.launch` → original closure → `WmiHyperVLauncher.start` → define gate → `New-CustomVM` script → start gate → `startAndRead` script.
- `ProtectedManager.spawnProtectedInternal` (protected raw stage) and the `applyNativeRole` wrappers reach the same `Manager.spawn`.
- `DELETE /vms/:id` → `Manager.remove` → interposed `backend.stop` → original stop → exact removal evidence.

## Changed files

New:
- `control/windows/vbslike/manager/allocation-owner.mjs`
- `control/windows/vbslike/manager/allocation-service.mjs`
- `control/windows/vbslike/manager/allocation-integration.mjs`
- `control/windows/vbslike/manager/allocation-owner-main.mjs` (the one entry module)
- `test/windows-permit/allocation-owner.test.mjs`
- `test/windows-permit/allocation-integration.test.mjs`
- `test/windows-permit/helpers/alloc-fixture.mjs`
- `REPORT-SHARED-ALLOCATION-R1.md`
- `RELEASE-CLOSURE-SHARED-ALLOCATION-R1.json`

Edited (narrow):
- `backend.mjs`: `interposeAllocation`.
- `wmi-launcher.mjs`: the `#allocationGate` field, `installAllocationGate`/`allocationGated`, an `allocation` option on `start`, and two gate calls.
- `compose.mjs`: two exports.
- `main.mjs`: config read, the launcher list, composition after inventory.

**`server.mjs` was not edited.** Its reservation segment is unchanged; the post-await re-check lives in the integration. No lock, durable-state, win-durable, win-exclusion, control-auth or control-client primitive was edited. The permit/custody/namespace/image/Stop rules, the chain79771 quarantine, the r12 repairs, the shipped clients and bundles, lifecycle/lease/adoption, the native creator and R4 `CutoverUnqualified` are all untouched.

## Tests authored, not run

`allocation-owner.test.mjs` (9 cases):
- establishment and refusals (missing, foreign, unestablished, torn and not truncated, other domain);
- serialized cross-role acquire with coverage gating and persisted terms;
- unknown or stale sample, a missing coverage term, and a higher live floor;
- restart retention, stale incarnation refusal and continuity;
- authentication and size bounds and role binding;
- the qualification hold;
- expiry not releasing an entered reservation;
- persistence-failure owner loss;
- the Linux owned-durable-state store (real flock, explicitly not Windows).

`allocation-integration.test.mjs` (9 cases), using two actual Manager/HTTP/backend/`WmiHyperVLauncher` consumers:
- the positive path from reservation through actual define/start to reflection, with Stop settling and the other role then allocating;
- concurrent cross-role direct requests;
- the protected raw stage;
- the bypass attempts (non-writable `launch`, a replaced `launcher`, a direct `launcher.start`, a forged token);
- expiry with an in-flight start;
- in-place installation over serving and in-flight records with identity assertions and no PowerShell calls;
- runtime owner loss with Stop still working;
- owner restart with re-registration;
- unchanged legacy mode.

TEST-only components are labelled: in-process journal exclusion, the inert PowerShell host, the sampler/coverage numbers and the readiness judge. No pass count is claimed.

## Retained obligations and gaps (not proven here)

- **Installed-process activation: none.** No resident 8091/8095 process has this code or a hook to load it. Reaching existing processes needs a proven activation path or a restart under this source. This slice provides neither.
- **Physical/commit truth.** The relationship between the sampler readings (Windows `FreePhysicalMemory`/`FreeVirtualMemory`, Linux `/proc/meminfo`) and real Hyper-V partition commit is unqualified. So is `vmCommitOverheadMiB`.
- **Non-VM host work.** Request buffering, component fetches before reservation, PowerShell, relays, kernel/worker overhead, creator E and observer O enter only as **owner-declared** coverage terms. They are not measured or enforced, and parent E/O remains unknown. VM-pool or owner capacity is **not** complete host safety.
- **Native storage.** Windows EXLOCK exclusion, NTFS flush/crash behaviour and storage ACLs for the ledger file are unqualified. The TEST exclusion is not evidence.
- **Atomicity.** The JavaScript gate before each PowerShell call does not make the operating system's create/start atomic. Another administrative allocator on the host remains uncovered.
- **Earlier baselines.** VMs recovered after a manager restart (unknown size) hold all new admissions until they are reconciled. Records counted conservatively in a baseline can over-reserve until they are reflected.
- The conservative complete-pool bound alternative remains valid if independently proven; it was not used or claimed here.
