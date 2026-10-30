# REPORT-WINDOWS-PERMIT-R3 — Windows protected manager integration r3 (SOURCE ONLY, PARTIAL)

Author pass: one Claude session, Read/Grep/Write only. **Nothing was executed**: no tests, builds, network,
services, Git or financial operations. Every test mentioned here is **AUTHORED, NOT RUN**. No passing result,
Windows/Hyper-V/Base evidence or production completion is claimed. The migration is **NOT complete**; production
protected capability must stay unavailable.

Seed: frozen r2 149-file author delivery + narrow live-v13 health merge in `router/control.mjs` (not touched in
this pass).

## Status by stage (acceptance = all of Stages 1–4; nothing below is optional)

| Stage | Item | Status |
|---|---|---|
| 1 | register/renew deadline crossing a durable write (root race 1+2) | implemented-source + authored-test (unqualified) |
| 1 | journal fault suppressing guard withdrawal (root race 3) | implemented-source + authored-test (unqualified) |
| 1 | guard-loss + hung removeRecord/raw launch → independent exact removal | implemented-source (enforcement) + authored-test; **entry wiring of `computeRemover` missing** |
| 1 | semantic replay: same-seq digest change, permit reset, removal schema, denial-restoration provenance, guard reg rules | implemented-source; positive full-lifecycle reopen test authored; more corrupt-row tests missing |
| 1 | retryable gate close without reopening admissions | implemented-source (`PermitEnforcement.retryRelease`); test missing |
| 1 | test74 obsolete fixture; TEST lifetime handle; short IPC dir | test74 fixture updated; **lifetime handle / IPC dir in helpers NOT done** |
| 2 | node-side protected client over the existing GuestdControl | implemented-source (`control/windows/node/protected-isolation.mjs`); unwired; no test |
| 2 | supervisor allow/hold boundary in host.mjs | **missing** |
| 2 | 8091 general + native wrapper shared enforcement in `main.mjs` | **missing** (current seed composes native pins only when `!permitConfig`) |
| 2 | direct + composite real-TCP tests | **missing** |
| 3 | workload boundaries (desktop/GPU/worker/egress/secrets/volumes/ports/command) | generic boundary API implemented-source; **no actual path wired**; all kinds still refused unless an adapter is composed |
| 4 | genuine authority construction (pinned r18 adapter, read(id) only) | **missing**; `authority-chain-reader.mjs` unchanged and must stay unavailable |
| 4 | Windows EXLOCK qualification | **missing** (no Windows evidence; fail-closed retained) |
| 4 | release closure manifest | **missing**; `source-manifest.json` hashes are historical and DO NOT describe the edited files |

## Changes in this pass

### `control/windows/vbslike/guard/guard-core.mjs` (Stage 1, root races 1/2)
- `#deadline()` fixes the **absolute** `{wallUntil, monoDeadline}` BEFORE the synchronous durable write;
  `#arm()` takes the absolute deadline (a slow flush consumes budget, never resets it).
- `#recheck()` after the write and again after timer installation: if either the wall or monotonic deadline
  passed, or the session ended, the possibly-landed armed record is expired (`removing`, removal owned) and the
  call throws, so nothing is acknowledged. Covers forward wall jumps (wall check), backward wall (monotonic
  check), and suspend (wall check).
- `bindVm` refuses to acknowledge when the live deadline has passed.
- `checkReg` (replay and every live write): exact `confirmed {by:"survey", at, bound}` consistent with the GUID,
  `confirmed` only on `removed`, first record must be an unbound staging arm, `appId` immutable, serving needs a
  digest and GUID, the digest never resets, and digest/deadline never change once withdrawal began.

### `control/windows/vbslike/manager/permit-enforcement.mjs` (Stages 1/3)
- `withdraw()` no longer touches the journal before acting: serving entry dropped → data plane closed → every
  registered workload boundary closed → **guard withdraw asked** → only then the journal is read (a fault is
  `JOURNAL_UNKNOWN`, never absence). Gate hold uses the trusted in-memory mapping `known` (recorded at stage and
  at GUID bind) if the journal is unreadable. Nothing is invented and teardown is not broadened.
- `#remove()` runs entirely in `try`. A journal fault means **absence cannot be durably recorded**, so the attempt
  fails and retry stays owned. If the guard is down and the raw launch or installed removal is hung (or a survey
  still finds the identity), `#independentRemove()` uses an injected `computeRemover` (exact GUID whose Notes
  name this id; a GUID with another identity is never touched) instead of polling the same hung promise. The
  original hung reason stays in the error, so the r2 tests' `/still in flight|still running/` still match.
- stage/permit fix the absolute wall+monotonic deadlines before durable writes and guard calls, and re-check them
  after each await and before acknowledging. A durable `serving` write or guard renew that fails withdraws the
  instance.
- `permit()` also checks the trusted stage/bind mapping, image equality, and that the sequence is not below the
  instance's accepted permit.
- `recoverAtStartup()`: a durable terminal record does not erase the obligation to remove a protected VM that
  is still present.
- `retryRelease()`: clears the gate's recorded failures only through `gate.withdrawalProven()` with the proof it
  requires (durable survey-confirmed `removed` + acknowledged ingress/boundary hold). It drops only the memoized
  **rejected** close completion (the gate stays `closed`, admissions stay revoked), then retries `journal.release`.
  The r18 gate file is not modified.
- Stage 3 groundwork: `WORKLOAD_KINDS`, `workloadsOf(spawn)` (derived from the launch spec, never a request
  flag), optional config `workloads`, `adapters`, and `boundary(instanceId, kind, close)`. The boundary asserts the
  current grant (or the finite staging window, for desktop/gpu/worker boot needs only) and registers a close.
  Withdrawal closes every boundary synchronously and records `closed`/`failed`/`pending` acks. `hold()` reports
  them truthfully: secrets released before a hold are reported as **disclosed, not erased**.
- `viewOf()` exposes the exact durable identity (`instanceId`, `vmId`, `managerEpoch`, `appId`, `runtimeId`,
  `image`, ...) in the MAC'd protected view, so a controller can build the attachment from authenticated data.

### `control/windows/vbslike/manager/permit-journal.mjs` (Stage 1 replay)
- `checkInst`: no permit reset to null, no digest change at the same sequence, no deadline extension for the same
  digest, no permit in staging/staged, and exact `confirmed {by:"survey", at, vmId}` with `vmId` equal to the
  bound GUID (`confirmed` is refused on any other state).
- `checkLc` + new `restore` provenance record: a row that clears a denial must immediately follow its `restore`
  record (same deployment, the cleared denial's block, `restoredAt >=` that block). `restoreDenial` writes the
  provenance first. A denial cannot be rewritten at the same block (`deny` keeps the existing one).
- **Known defect introduced (fix before running):** `checkInst` also refuses `n.at < prev.at`. A backwards wall
  clock would then make withdrawal-direction writes throw. Enforcement still fails closed, but durable removal
  recording stalls until the clock passes the old `at`. Remove that line (or clamp `at` in enforcement) before
  qualification.

### `control/windows/node/protected-isolation.mjs` (Stage 2, new, unwired)
- `ProtectedIsolationClient` over the existing `GuestdControl`: request MAC and response-MAC verification
  come from the existing client.
- `stage` is non-idempotent and reconciles by name; an unknown outcome is kept in `unknownStages` and
  `resolveUnknown` holds any unwanted pp instance found later.
- `permit` reconciles from the MAC'd view's `permitDigest`.
- `hold`/`stop` are idempotent (withdrawal direction).
- `ProtectedIsolationClient.attachment(view, …)` builds the attachment only from the MAC'd `protected` view plus
  the node-computed digest and `validUntil`.
- Limit: when `resolveUnknown` finds no instance, it drops the record. A later raw stage is still removed by the
  manager's own staging deadline and the guard, but the node itself does not see it.

### Tests (AUTHORED, NOT RUN)
- `test/windows-permit/root-races.test.mjs`: the root's three race tests (import paths adapted only), plus two r3
  tests: "journal fault never records absence" and "guard down + hung removal uses the independent remover only
  for the exact identity". The Notes fixture string must match `wmi-launcher.parseNotes`' real marker; root
  should adjust it.
- `test/windows-permit/win-durable.test.mjs`: test 74's obsolete instance fixture replaced by a full legal
  lifecycle (staging → staged → serving → removing → removed with full confirmation). It adds same-sequence
  equivocation, deadline extension, permit-reset and confirmation-schema negatives, plus a positive cold reopen,
  and keeps the floor/no-revival/immutable-identity assertions.
- `test/windows-permit/r2-repairs.test.mjs` is **not updated**: its `removed` rows need the new
  `confirmed.vmId`. The positive cold-reopen row (line 128) will now fail until `vmId: GUIDV` is added to its
  `confirmed`, and the "instance revived" corrupt row (line 156) is still refused, but now for the confirmation
  schema rather than revival. Root must update both rows before running.

## Root regressions addressed (source only, unexecuted)
- races-fixed 0/3: register/renew crossing the deadline → `#recheck` in guard-core; journal read fault → guard
  withdraw first in `withdraw()`.
- test74 obsolete fixture → updated.
- 13 cancellations from the unref'd retry timer → **not addressed in helpers in this pass**. The fix must be a
  TEST-owned lifetime handle in `helpers/world.mjs`/`manager-child.mjs` that the test clears in `t.after`, plus
  a short owned IPC directory (Unix 108-byte limit) separate from the persistent ext journal directory. No
  production keepalive.

## Remaining A/D composition (precise)
1. Supervisor allow/hold boundary in `host.mjs` (4410 lines, not edited) using `ProtectedIsolationClient`:
   event-driven only (no periodic chain heartbeat), triggered by the node's own owner-selected reader/witness
   verdicts. It must keep raw stage/permit/hold that outlive a request timeout owned.
2. `main.mjs`: select role explicitly (`general` 8091 vs `native` 8095 with its 17-line pin wrapper, applied
   whenever native, independent of `permitConfig`). Compose `computeRemover = windowsBackend(powershellRunner(...))`
   from `guard-main.mjs` and pass it, with `adapters`, to `PermitEnforcement`.
3. Tests: a real installed `createProtectedServer` + `GuestdControl` over TCP, both direct and through the
   composite router. Include forged MAC, replay, attachment mismatch, late completion, truthful hold, manager
   death with guard removal, legacy neighbour, and router 503 health.

## Workload boundaries (Stage 3) — only the shared API exists
None of the actual paths is wired: `desktop-worker-transport.mjs`, `desktop-media.mjs`, `egress.mjs`,
`node/secrets.mjs`/`shield-secrets.mjs`, `model-volumes.mjs`, port/firewall and the config/command socket. Each
must call `enforcement.boundary(id, kind, close)` at every session/stream/late dial and supply an adapter
(`admit`). Until then `stage()` refuses those workloads (KVMBoxNative desktop/GPU included), which is safe
interim behaviour but an **unfinished migration**.

## Authority (Stage 4) — unchanged, unavailable
`authority-chain-reader.mjs` still trusts caller qualification JSON and must not be promoted. The genuine
construction still to write:
- the pinned r18 `deployment-chain-adapter` reader, built from owner-selected derived authority, proof and anchor
  journal capabilities, with financial capabilities omitted, exposing only `read(id)`;
- a test proving zero signer/approval/relay/write calls;
- shape checks against `servingContextOf(pins, snapshot)` (`deployment-host-authority.mjs:194`).

The Windows derived reader, proof execution and persistent anchor journal do not exist (`L/network/derived-reader/
process.mjs` is Linux-only). Independent hosting under Enclave refusal is therefore **not** achieved.
**Unfinished dependency.**

## Platform / packaging gaps
- No Windows EXLOCK qualification. Node 24.16.0 has no named `UV_FS_O_EXLOCK`, and the numeric wrapper stays
  unqualified and fail-closed.
- No release-closure manifest. `source-manifest.json` is stale for `guard-core.mjs`, `permit-enforcement.mjs`
  and `permit-journal.mjs`, and lists neither `node/protected-isolation.mjs` nor the new tests. Root must
  recompute hashes. New import edges: `node/protected-isolation.mjs` → `isolation/m4/guestd/control-client.mjs`.
  No new third-party dependencies (viem 2.53.1 is unchanged).
