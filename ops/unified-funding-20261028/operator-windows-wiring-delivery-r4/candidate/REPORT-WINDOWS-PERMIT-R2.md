# Windows manager permit — r2 repair/integration report (SOURCE ONLY)

**Status: PARTIAL. Not production. Not a migration.** Every test here was **authored but not run**: the author executed no code, tests, or builds, and changed no production, service, config, wallet, or finance state. Root runs the tests and publishes the evidence. Protected capability stays **false** in production. The reasons are listed under "Remaining blockers".

## Files changed in candidate/ (all other seed files are byte-identical to the 145-file seed)
| File | Change |
|---|---|
| `control/windows/vbslike/manager/permit-journal.mjs` | Rewritten: replay semantics validation and release-phase admission revocation (bugs 1, 2) |
| `control/windows/vbslike/guard/guard-core.mjs` | Rewritten: validation runs before the durable arm, and the durable record owns cleanup (bug 3); guard replay validation |
| `control/windows/vbslike/manager/permit-enforcement.mjs` | Removal no longer waits without a bound on a hung spawn or a hung `removeRecord`. Hold acknowledgments now report what actually happened. Staged-write and register-failure paths are now owned. |
| `control/windows/vbslike/manager/win-exclusion.mjs` | **New**: runtime-pinned numeric `UV_FS_O_EXLOCK` adapter. It requires a qualification record, which has not been produced yet. |
| `control/windows/vbslike/manager/authority-chain-reader.mjs` | **New**: read-only selection of the actual r18 adapter. Financial capabilities are traps that count calls. |
| `test/windows-permit/helpers/world.mjs` | `splice()` now presents the identity retained while the instance was live, so a post-removal splice still opens a real socket (author #18/#24 helper defect) |
| `test/windows-permit/r2-repairs.test.mjs` | **New**: 41 tests — the 3 root tests with import paths changed only, plus 38 adjacent tests |
| `REPORT-WINDOWS-PERMIT-R2.md` | This file |

Unchanged:
- The 5 vendored r18 modules (`control/network/deployment-*.mjs`).
- `main.mjs`, `win-durable.mjs`, `source-manifest.json`, `bootstrap.mjs`, the router, and `LaunchJournal(file)`. tmpfs refusal is retained.

No dependency, manifest, or version changed. viem is not vendored. Root's executed runs resolve viem 2.53.1 from `it/work/enclave-kvm-guest/node_modules`. Its package.json sha256 is `e949a8d5…` and `package-lock.json` is `9ada1611…`; both are pinned in `input-pins.json`. A release closure must pin exactly that package and lock. The author did not produce that closure.

## The 3 demonstrated bugs
1. **Release admitted new work.** `release()` now sets phase `releasing` synchronously, before any listener runs.
   - From that point, `journal.assertLive()` and `hostAuthority.assertLive()` throw. As a result, r18 `gate.ownerLive()`, `work()`, and `stage()` refuse, and the enforcement capability is false.
   - The following now refuse: `observeAssignment`, `permit`, `restoreDenial`, `hostAuthority.accept` and `bind`, `onRelease`, and every `putInstance` that is an admission or a non-withdrawal state.
   - Narrow cleanup authority remains: `fence`, `deny`, `observe`(Offline), `unbind`, and instance moves into held/removing/remove-failed/removed/unknown/refused.
   - The physical handle closes only after all listeners resolve. If a listener rejects, the handle stays held and admissions stay revoked permanently. `release()` then retries only the listeners that failed.
   - Limitation: the r18 gate memoizes `close()`. A gate whose withdrawal failed therefore keeps rejecting until the process exits, at which point startup recovery removes everything. This is conservative, but it means retrying release inside the same process cannot clear a gate failure.
2. **Replay accepted impossible rows.** Every `lc`/`ha`/`inst` record is now checked on cold replay for exact schema, internal consistency, and the transition from the previous row. Live writes call the same `checkLc`/`checkHa`/`checkInst` functions before appending, so a live write cannot produce a journal that fails to reopen. Unknown record kinds refuse the whole journal. Guard `reg` records get the same treatment (`checkReg`).
   - Integrity is separated from authenticity: `journal.provenance()` states that the chain is unkeyed integrity only.
   - Behaviour change in `hostAuthority.observe`: the floor now advances only if neither axis decreases. r1 could roll owner revision back when host generation rose. Otherwise the old floor is kept and only Offline is recorded, which is stricter.
3. **The guard left an expired registration armed.** All fields and the effective deadline are validated before the durable `armed` write.
   - Timer installation failure, session end during registration, or a write with unknown outcome → the instance is expired and removed. It is never left armed without a timer.
   - `sessionEnded` and `stop` iterate **durable** registrations, not just the in-memory timers.
   - An expired `renew` writes nothing and keeps the old, shorter deadline. A failed renew write or arm expires the instance.
   - `status().unguarded` exposes any armed record without a timer, and enforcement `verifyGuard` refuses readiness if that list is non-empty.

Author helper failures #18/#24 are fixed without skipping the socket or weakening removal or denial. The router tests and `LaunchJournal` are untouched.

## Actual integration work done (and not done)
- **A (supervisor/isolation-client adapter over the real HTTP, composite router, and GuestdControl): NOT done.** No adapter was written, no end-to-end direct+composite TCP composition exists, and no out-of-band raw-operation ownership exists. This remains the largest open item.
- **B (read-only authority): partial.**
  - `authority-chain-reader.mjs` constructs the actual r18 `createLifecycleChainAdapter`, injected so the pinned file is used. The constructor accepts the signer, approvals, and relay without requiring them; this corrects the r1 report. Each of these capabilities is replaced by a trap that throws and counts calls, and only `read(id)` is exposed.
  - It refuses rpc-quorum. It reports `production-derived-finality` only when given a root qualification record for a Windows derived authority, which does not exist.
  - Not done: no test proves zero trap calls against the real adapter (it needs pinned chain fixtures). It is not wired into `main.mjs`, and `authority-reader.mjs` still throws. One assumption is unverified: that `servingContextOf(pins, snapshot)` is exported with this signature by the vendored `deployment-host-authority.mjs`; that file's r1 comment names it, but the author did not check it.
  - Still missing: a Windows derived reader (the existing one is Linux-only), a Windows proof verifier, an anchor journal on the owned-log primitive, owner-selected generation sources, and reviewed pins. Safe refusal is **not** usable independent hosting.
- **C (workload boundaries): only the hold/removal pieces were done.** Ingress is acknowledged only if `closeInstance` succeeded. Storage and secrets are reported with their real basis (never admitted). Compute removal and the guard's independent removal start even when the spawn or manager cleanup hangs, and the hung calls stay owned.
  - **UNFINISHED migration blockers:** V6/V7 secrets, desktop/KVMBoxNative GPU, worker, egress, ports, volumes, and command sockets are still refused as protected.
  - Legacy tenants are unchanged.
- **D (general 8091 + native 8095 bootstraps): NOT done.** `main.mjs` is unchanged. No shared enforcement composition exists for the general entry (sha `53a85497…`) or the native wrapper.

## Windows persistence
- `win-exclusion.mjs` uses the numeric flag `0x10000000` only when all of the following hold:
  - the platform is win32;
  - the named constant is absent or equal to the numeric flag;
  - `process.version` and the exec sha256 match the pin (Node v24.16.0, `b3094d0b…`);
  - a root `enclave-win-exlock-qualification/1` record shows that cross-process open, rename, and delete are refused and that holder death releases the lock;
  - a same-process second open fails with a sharing violation.
- There is no fallback and no flock.
- **The OS qualification has not run, and nothing wires this adapter into `main.mjs`.** `main.mjs` still uses `WINDOWS_EXCLUSION`, which refuses on the deployed runtime because the constant is absent. The intended integration, once root qualifies the flag: `exclusion: windowsNumericExclusion({ qualification, runtime: { platform, version, execPath, execSha256: execSha256() } })`.
- All TEST adapters (in-process exclusion, injected fs/timers, fake fsImpl) are labelled TEST. They are not Windows evidence.

## Tests authored, NOT RUN (`test/windows-permit/r2-repairs.test.mjs`, 41 tests)
- The 3 root tests.
- Release (3): revocation and narrow cleanup; a failed listener keeps the handle owned and retries; real r18 gate close.
- Positive cold reopen across all sections (1).
- 23 cases of well-chained but impossible journals (lc/inst/ha/unknown kind).
- An injected flush failure latches the handle, and the landed intent is replayed (1).
- Guard (6): invalid fields write nothing; timer failure; write with unknown outcome; lost timer covered by session end and stop; expired renew; impossible replayed registration.
- Enforcement (2): hung spawn; hung `removeRecord` combined with a failed data-plane close.
- EXLOCK adapter (2): refusals and the self-check.
- Root must run these with an owned persistent `TMPDIR`. The existing 33 author tests should be rerun, because the journal and guard semantics changed. Any existing test that wrote records the new validators reject would surface there.

## Remaining blockers (production migration NOT complete)
A, D, and most of C are not implemented. B lacks the Windows derived authority and its qualification. The Windows EXLOCK qualification has not been run or wired. There is no Windows, Hyper-V, NTFS power-loss, or Base evidence. The r18 gate's close-once behaviour limits in-process release retries.
