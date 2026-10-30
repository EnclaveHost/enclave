# REPORT — Windows manager continuing per-app authorization, r1 (source only)

**Status: implementation and tests are AUTHORED, NOT RUN.** No code was executed, built, hashed or installed. The only tools used were Read, Grep and Write. There is no Windows, Hyper-V, NTFS, Base or production claim. Root executes the tests and computes every hash.

## Bottom line
- **What exists:**
  - a working, wired enforcement path in source: authenticated opt-in → durable staging → guard registration → spawn → per-instance permit verification by the real r18 gate → data-plane admission bound to the grant → withdrawal → exact removal confirmed by survey;
  - an independent guard process that removes exact compute when the manager dies, the guard restarts or a deadline passes;
  - a Windows-specific owned journal;
  - router support for the new routes.
- **What does not exist:** an end-to-end production capability. The manager's **production authority reader is unavailable**, so `permitEnforcement.available` is false in production and states why (`authority-reader.mjs` lists the five exact missing inputs). The positive tests use a TEST-labelled reader and TEST Windows doubles.
- **Deployment-role finding:** the seed's `main.mjs` is the pinned **native desktop** manager on 8095 (see `run-manager.cmd`). The legacy-role 8091 manager is installed separately and is not in this seed. Protected instances are designed for the legacy role (`pp` + 32-hex namespace). `main.mjs` gains an optional, separately pinned legacy-role protected entry (`ENCLAVE_PERMIT_CONFIG`). Without it, native startup is unchanged. Running it means replacing the 8091 manager with this source, which is a migration step that has not been done.

## Files written (all under `candidate/`)
**Modified seed files** (seed hashes are in `PACKAGING-WINDOWS-PERMIT.json`): `manager/main.mjs`, `router/control.mjs`, `router/io.mjs`.

**Deliberately unchanged:** `server.mjs`, `backend.mjs`, `wmi-launcher.mjs`, `datapath.mjs`, `node-bridge.mjs`, `isolation-client.mjs`, `source-manifest.json`, `bootstrap.mjs`.

**New source** (all under `control/windows/vbslike/` unless stated otherwise):

| File | What it does |
|---|---|
| `manager/control.mjs` | guestd-control/1 server, re-typed verbatim from L. Root must sha256-compare it. |
| `control/isolation/m4/guestd/control-client.mjs` | The supervisor client, verbatim copy, used by the tests. |
| `manager/win-durable.mjs` | Owned append-only log. The journal file itself is held with `UV_FS_O_EXLOCK` (share mode 0) before it is read. Appends are flushed on the held handle with no rename. Any write/flush failure latches the handle. A torn tail is ambiguous until an explicit owner quarantine. Missing or corrupt journals are never defaulted. Paths are checked for junctions, symlinks and UNC; a PowerShell probe checks ACL SDDL, NTFS and fixed drive. |
| `manager/permit-journal.mjs` | One journal with three sections: the r18 lifecycle floors (same transition rules), the r18 host-authority floor/Offline/handoff (using the r18 pure functions), and the protected instance mapping (immutable identity; terminal records are never revived). |
| `manager/permit-enforcement.mjs` | Config validation, the capability check, staging, permit verification through the real `DeploymentPermitGate`, the per-instance attachment check, data-plane admission, withdrawal and removal, and startup recovery. |
| `manager/protected-manager.mjs` | `ProtectedManager extends Manager` plus `createProtectedServer`, which puts ControlServer in front of the *installed* `createServer` handler. |
| `manager/authority-reader.mjs` | The production reader contract. It throws, listing the exact missing dependencies. |
| `guard/guard-core.mjs`, `guard/guard-client.mjs`, `guard/guard-main.mjs` | The independent guard: its state machine, the MAC'd pipe protocol, and the Windows/TEST process entry. |
| `guard/install-guard.ps1` | **Staged only, not run.** |

**Docs:** `PACKAGING-WINDOWS-PERMIT.json`, `WINDOWS-ACCEPTANCE-PERMIT.md` (procedures W0–W10, not run), and this report.

**Tests (authored, not run):** all under `test/windows-permit/`.

| File | Tests |
|---|---|
| `permit-enforcement.test.mjs` | 14 |
| `guard-death.test.mjs` | 4, using real separate processes |
| `win-durable.test.mjs` | 5 |
| `legacy-baseline.test.mjs` | 7: the baseline's 3 tests with exact assertions, run on both `Manager` and `ProtectedManager`, plus a missing-guard/missing-authority refusal |
| `router-protected.test.mjs` | 3 |
| `helpers/world.mjs`, `helpers/manager-child.mjs` | TEST harness |

That is 33 tests. Before running: vendor the five r18 generated files listed in the packaging JSON, and provide `viem` at the r18 version.

## How the requirements map
1. **Opt-in.**
   - A legacy `POST /vms` is unchanged, except that enforcement-shaped fields and the `pp` id namespace are refused (400).
   - Protected staging is reachable only through a MAC-verified guestd-control/1 request.
   - Staging is admitted only when the manager's own authority reader shows the deployment queued for this pinned host, admitted and funded at a qualified tier, with Online same-block host authority. The r18 `fresh-queued-start` handoff is then recorded durably.
   - The staging deadline is explicit and bounded (≤ `maxStagingMs` ≤ 600 s).
   - The order of effects is: durable intent → guard registration → spawn.
   - Staged instances get no data-plane admission.
2. **Permit binding.**
   - The v2 signed bytes are verified by the r18 gate (typed signatures, quorum, floors, denial, host generation/owner revision/digest, freshness).
   - A separate attachment (`enclave-instance-permit-attachment/1`) must equal the durable mapping exactly: instance id, VM GUID, manager epoch, launch epoch, deployment, generation, app, runtime, image, and the digest of the signed record.
   - No unsigned field is added to the signed record.
3. **Deadlines.**
   - Effective deadline = min(gate wall deadline, attachment `validUntil`), plus a monotonic deadline set at acceptance.
   - Units: signed record times are in seconds; everything else is in milliseconds.
   - Re-sending the same envelope keeps the old monotonic deadline (gate behaviour), and the guard refuses a renew with the same digest.
   - A clock discontinuity closes the gate (r18 behaviour): **suspend/resume or a wall jump withdraws every protected instance until restart.** This is conservative.
4. **Manager death.** The guard is a separate process and holds an exact per-instance registration before spawn. A manager session is bound by HMAC to PID **and** creation time; the guard checks that the PID is alive with the same creation time. The guard removes compute when:
   - the session ends or the identity changes;
   - a deadline passes;
   - the guard restarts, or the boot id changes. It never continues a lifetime.

   Removal matches GUID **and** Notes identity. It is confirmed only by a survey; for an unbound launch, only after a late-effect horizon. Failures are recorded and retried. If the guard is lost, the manager withdraws access, removes compute itself and stops advertising capability.
5. **Durability.** The journal is opened exclusively before any read, and ownership is the held handle. Restart continues nothing: `recoverAtStartup` marks every non-terminal instance `unknown` and removes it. Protected VMs that are not in the journal are never adopted (recovered records never serve).
6. **Boundaries.**
   - Withdrawal is synchronous: the serving entry is dropped and the splices are closed (the router-side splice closes with them).
   - Compute removal starts afterwards, independently of any relay or transport cleanup.
   - New splices re-assert the gate. Late dials are covered because the installed data plane registers a splice before dialing and `closeInstance` ends it.
   - DELETE (explicit Stop) returns 200 only after a survey confirms absence.
   - **Scope:** r1 refuses secrets (V6/V7), desktop, GPU, ports, volumes and command sockets for protected instances. The hold acknowledgment's `storage/secrets: true` is explicitly based on "none admitted", not on revocation.

## Unresolved gaps
- **Production authority:** there is no read-only qualified selection of `deployment-chain-adapter.mjs`, and no Windows derived-reader `readAnchor`, Windows proof verifier, Windows anchor journal or reviewed pins. Production capability is therefore false.
- **Node side not wired:** the r18 runtime's `boundaries.allow/hold` adapter, and an `isolation-client.mjs` extension that calls `/protected/*` with an attachment, are not written. Supervisor integration is outstanding.
- **Windows platform (all unproven):**
  - `UV_FS_O_EXLOCK` exclusion and FlushFileBuffers durability across power loss (W1, W2);
  - the ACL probe;
  - the pipe DACL: `node:net` cannot restrict it, so the MAC is the only authentication;
  - Node is not a native service (a scheduled-task form is staged);
  - guard behaviour across reboot, suspend and WMI hangs (W3–W10).
- **Trust boundary (T0-hv):**
  - The guard trusts the manager's verified deadline values; it does not verify witness signatures itself.
  - If guard and manager are both down, nothing removes compute until one of them starts.
  - There is no protection from a host administrator and no manager attestation.
- **Router:** the positive stage *through* the composite router is not tested (it needs a native-manager double that satisfies `snapshot`); this is acceptance item W7. Router admission does already apply the same latch and capacity checks.
- **Behaviour notes:**
  - A refused permit leaves a *staged* instance staged (r18 semantics); the staging deadline or Stop bounds it.
  - Any `removing`, `remove-failed` or `unknown` instance blocks new protected admission.
- **Possible test flakiness:** the TEST JSON inventory is read-modify-written by both the manager double and the guard process, so a lost update is possible under races. The test with the tightest timing is the 4-second permit lifetime test.
- **Cosmetic, harmless:** `guard-core #arm` contains a redundant `Math.min(..., Infinity)`, and `hold()` returns `removal: "pending"` through an odd expression.
- **Packaging:** no hashes were computed. The `viem` version is not pinned. A new reviewed release manifest is required; `source-manifest.json` was not changed.
