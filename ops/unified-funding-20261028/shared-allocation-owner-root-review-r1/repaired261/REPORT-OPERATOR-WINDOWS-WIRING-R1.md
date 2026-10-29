# Operator Windows wiring r1: installing the operator-effects store and wiring it into startup

**Status: source only. Authored, NOT RUN.** I ran nothing: no tests, no builds, no shell, no PowerShell, no qualification, no installation, no network. All file hashes are left for the coordinator to compute. Nothing here shows that tests pass, that Windows is qualified, that anything is installed, or that any migration is complete.

Baseline: Exact243 root-repaired operator r2 seed (`seed-provenance.json`). The root `chain.mjs` quarantine repair `79771c6c…` is preserved byte for byte. There is no identical-tuple replay exception. Historical reports and results are left as they were. The r2 report is still superseded on the replay exception.

## 1. The gap that was closed

`agent.mjs` built `Host` without `cfg.operatorEffects`. That meant `Host` handed `chain.setOperatorEffects(<dir>/operator-effects.journal, {})` an empty set of options. On Windows the open therefore refused, either because storage was missing (no `storage.run/sddl/parentSddl`) or because of `WINDOWS_EXCLUSION`, which needs the named `UV_FS_O_EXLOCK` that is absent on Node v24.16.0. That is safe, but the store could never be used. `initialize-operator-effects.mjs` also had no qualified exclusion.

## 2. Source entry wiring (actual runtime chain)

```
node.exe (NODE_RUNTIME_PIN v24.16.0 / b3094d0b…)
 └ agent.mjs
    OPERATOR_EFFECTS = operatorEffectsForHost({ env: process.env,
        actualDomain: () => ({ account: operatorAddress(), chainId: publicClient().chain?.id }) })   ← before `new Host`
    new Host({ …, operatorEffects: OPERATOR_EFFECTS.option })
     └ host.mjs constructor: { file, refused, ...options } = cfg.operatorEffects
        chain.setOperatorEffects(file || <dir>/operator-effects.journal, options)      (chain.mjs UNCHANGED)
         └ first operator effect → chain operatorEffects() → openOperatorEffects(file, { ...options, domain: actual acct + chain })
            ├ windowsStorage → options.storage.run: domain gate → powershellRunner(60 s, 64 KiB) storageProbeScript
            │   → checkWindowsStorage (exact file + parent SDDL, NTFS, Fixed, no reparse)  BEFORE the journal opens
            ├ openOwnedLog → checkLocalPath (drive path, no reparse ancestor, 1 link)
            └ options.exclusion.open: domain gate → windowsNumericExclusion.open (same-process second-open self-check)
```

- **New `control/windows/node/operator-effects-config.mjs`.** This is the single strict loader, used by both the installer and the Host:
  - Bounded pinned reads: link-free, single-link regular file, inode unchanged across open, size limit, sha256 equal to its pin.
  - Strict UTF-8 JSON. Unknown or missing fields are refused at every level.
  - Windows path rules refuse UNC, device, relative, ADS colon, dot, 8.3 short-name, reserved-name and trailing-dot/space forms.
  - SDDL policy: the directory DACL must be protected. Allow ACEs for broad principals are refused. The exact strings are compared at runtime.
  - The config runtime block must be exactly equal to `NODE_RUNTIME_PIN`.
  - The exclusion must be `numeric-qualified` with flag `0x10000000`. Named-constant selection is refused because it is unreachable under this pin. A different runtime needs its own pin and qualification.
  - The pinned launcher (`94a8…`) and probe (`6c8d…`) artifact hashes are refused as qualification.
- **`operatorEffectsForHost` never throws.**
  - **`configured`:** returns the exact options (`file`, `backend`, `platform`, `exclusion`, `storage`).
  - **`refused`:** returns refusing options. Their `storage.run` and `exclusion.open` throw `OperatorEffectsConfigRefused` before any filesystem or PowerShell use. A sanitized `refused` reason is attached.
  - **`platform-default`:** used only when the platform is not win32 and no config is named. The option is undefined, so the Host keeps its existing default. If a config is named on a non-Windows platform, the result is `UnsupportedPlatform`.
- **`host.mjs` (additive edits):**
  - The constructor honours `operatorEffects.file` and records `operatorEffectsRefusal`. Neither key is passed to `openOperatorEffects`.
  - New read-only method `operatorEffectsReadiness()`.
  - New-claim gate: with a refusal present, a claim is queued with the reason before any chain call.
  - The status object gains `operatorEffects`.
- **`agent.mjs`:** the seam described above, one sanitized log line, and `/v1/health` reports `operatorEffects: { state, available }` (no reason text).
- **What a refusal leaves running:** the agent is never stopped, and no store is created or selected. `chain.mjs` refuses every new operator effect (it is unchanged). Read-only reconciliation, Stop and `operatorEffectsStatus` stay available as before.
- **Withdrawal is also refused.** It is an operator write through `send`, so it is refused by the existing design rather than by anything new here. This is stated plainly; it is not a new restriction.
- **What "available" means:** `operatorEffectsReadiness().available` is true only after `chain.mjs` has lazily opened the owner and it is live. Before that it truthfully reads `false` (`store.ownership: "not opened"`).

## 3. Identity, config and qualification trust chain

1. **Config pin.** `ENCLAVE_OPERATOR_EFFECTS_CONFIG` + `ENCLAVE_OPERATOR_EFFECTS_CONFIG_SHA256` (process environment) pin the config bytes. This is the same model as `ENCLAVE_GUARD_CONFIG`. A separately reviewed activation step sets them; the installer never does.
2. **Qualification pins.** The config pins `qualificationFile` by sha256 and `evidenceFile` by sha256.
   - The record must pass the reviewed `validateExlockQualification`.
   - Its `evidenceSha256` must equal the configured value, and the evidence bytes must be present.
   - The literal `qualifiedBy:"root"` therefore counts only through this byte chain. The record and its evidence must not live in the store's writable state directory.
3. **Runtime match.** The actual `process.platform`, `process.version`, `process.execPath` and the sha256 of the actual executable (existing `execSha256`, read once at startup) must match the pin, enforced inside `windowsNumericExclusion`. If a named `UV_FS_O_EXLOCK` with a different value is present, the result is refusal.
4. **Identity check at open time.** Before any probe or open, the loaded operator key's actual address and the chain client's actual id must equal the config `domain`. The store separately refuses a log established for another domain. A configured account never selects or substitutes the signing identity, and neither the loader nor the installer reads a key.
5. **TEST injection.** Runtime, fs and PowerShell can be injected only through an explicit function argument labelled `TEST-ONLY-NOT-WINDOWS`. It is refused on win32, no environment variable selects it, and its results report `production:false`. Neither the loader nor the agent uses `TEST_inProcessExclusion`.

## 4. Installer and preflight semantics (`control/windows/node/install-operator-effects.mjs`, new)

- **Plan is the default and writes nothing.** Strict inputs:
  - state dir, public account, chain id, one service identity (no groups), config output path, legacy node dir
  - qualification and evidence files with their pins
  - release manifest with its pin

  An argument that is unknown, repeated or missing its value is refused.
- **Preflight checks, all before anything is created:**
  1. Windows only.
  2. State dir, store, config and receipt are all absent. Otherwise the result is a read-only `AlreadyEstablished` (a matching receipt is present) or `IncompleteInstall` (anything else). Nothing is touched.
  3. The release manifest pins every file of the install/runtime chain, and each pin is verified.
  4. The actual runtime matches the pin, and the qualification and evidence build **the same** `qualifiedExclusion` the agent builds.
  5. The legacy `operator-writes.json` / `sponsored-obligations.json` hold no records, and no store or evidence (`.established/.intent/.commit/.history/.lock`) sits at the legacy default.
  6. The state parent and config directories are link-free, on fixed NTFS, and the config directory ACL has no broad grants.
- **Apply requires `--apply --confirm install-operator-effects-store`. Steps, in order:**
  1. Create the state directory with one `CreateDirectory(path, DirectorySecurity)` call: protected DACL, SYSTEM and Administrators full control, the service identity Read+Write (no Delete), owner Administrators.
  2. Verify the directory: empty, protected DACL, no reparse anywhere.
  3. `initializeOwnedLog` with purpose `enclave-operator-effects/1`.
  4. Handle the SDDL circularity: observe the journal's ACL, check it against policy and the directory just verified, then run the runtime `checkWindowsStorage` against exactly those observed values.
  5. Establish the domain under the qualified exclusion, using the same `operator-effects-established` row that `initializeOperatorEffects` writes. It is mirrored because that function can only compare a file SDDL that cannot exist before creation.
  6. Open through the runtime `openOperatorEffects` with the same exclusion and storage options: zero records, then release.
  7. Write the config with `wx`, re-read it through the runtime loader, and rebuild the exclusion from those bytes.
  8. Write a sanitized `wx` receipt beside the config.
- **Failure and reruns:** any failure stops with `IncompleteInstall`, naming the completed steps and the failed step. Everything already created is preserved. A rerun refuses and never deletes, resets or replaces anything.
- **The installer does not:** register services or tasks, set machine environment, restart anything, cut over a host, change grants, use the network, or delete anything.
- **`initialize-operator-effects.mjs` now refuses on win32** and points to the installer. Its Linux behaviour is unchanged. This removes the divergent environment-SDDL path, and with it the `initialize → psrun` edge in the source closure.

## 5. Tests authored, NOT RUN: `test/windows-permit/ow-r1-operator-windows-wiring.test.mjs`

- **A1–A6, the loader:**
  - Exact bytes map to exact options.
  - 29 refusal cases (absent, malformed or tampered config or qualification; runtime/version/executable/named-flag drift; named kind; unqualified flag; false observation; other evidence; missing evidence; cross-build artifact; missing or unprotected or broad SDDL; store name or dotted path; config in the state dir; symlinked or hard-linked config; non-canonical account; string chain; unsupported platform; unlabelled TEST). Each yields refusing options, no probe, and no file created through the actual `openOperatorEffects`.
  - Windows path rules.
  - Foreign or unknown identity refused before PowerShell.
  - On Linux the real numeric exclusion **refuses** (flag ignored, second open succeeded), with no unlocked fallback and the store bytes unchanged.
  - A missing journal is never created.
- **B0–B2, the actual seam:**
  - A static check that `agent.mjs` calls the seam before `new Host` and passes its option. The agent is never imported.
  - Through the actual `Host` constructor and a fresh actual `chain.mjs` per Host (inert viem doubles as in od-r1):
    - With a valid config, the storage probe runs for exactly the pinned store first, then the POSIX TEST path is refused under win32 rules. No write.
    - With a tampered config, there are zero probes, writes or signatures and no store is created. Renew and withdraw are refused with `OperatorEffectsConfigRefused`, readiness reports `refused`, and diagnostics never throw.
- **C1–C6, the installer:**
  - Plan is read-only.
  - 14 preflight refusal cases (legacy records, legacy store evidence, unpinned or mismatched release, runtime drift, missing qualification, launcher artifact, config in the state dir, group service account, key-shaped account, unknown input, non-Windows, broad config ACL, probe timeout). Each refuses for both plan and apply and creates nothing.
  - Confirmation is required.
  - A TEST apply in disposable storage (labelled; `TEST_inProcessExclusion` for the journal opens only) produces the exact config bytes. The runtime seam accepts them, then honestly refuses the Linux open. The store is established, empty and single-owner, and a foreign domain is refused. Reruns are non-destructive.
  - A partial install is preserved, and reruns refuse as incomplete.
  - CLI parsing.
- **Fixture caveats:** the TEST qualification record, TEST SDDL strings and TEST PowerShell answers are fixtures for schema and pin binding only. They are not Windows evidence and cannot make operator effects available. Fixture shapes (such as `renewDeployment` reaching `send`, `Host` constructor dependencies, and `Get-ChildItem` script detection) were transcribed from the existing od-r1 and r10 tests. If they differ, root should adapt the fixture rather than the product.
- **Existing tests:** all unchanged, including quarantine, state-loss and shipped-client tests and root assertions. `Host` without `operatorEffects` behaves as before.

## 6. Release and target qualification boundaries (unchanged, not executed)

- **Cross-build artifacts are not Windows evidence.** Launcher `94a8483e…` and probe `6c8d02e9…` were reviewed as cross-build artifacts. Nothing was rebuilt, run, staged or replaced. The probe reports its flags as false by design.
- **`qualification-admission-plan.json` status is NOT ADMITTED:**
  - The live guestd floor of **18432 MiB** (or a higher fresh floor) is preserved.
  - The 17408 MiB launcher cutoff is an unresolved gap, not permission to lower the floor.
  - P (pending commitments), O (independent death observer, a proposed 64 MiB that is unenforced) and E (early setup) are unbounded or unknown.
  - The historical journal reading of zero is stale. Sia's later 8504 MiB running guest cannot be ignored.
- **Staged order (each step needs its own approval; none was done):**
  1. Fresh complete admission accounting.
  2. Job containment, limits, inheritance and owner-death observed on the exact target.
  3. Separate review, implementation and admission of the independent death observer.
  4. Native EXLOCK test on Node v24.16.0 / `b3094d0b…`: a second process's open, rename and delete refused while the file is held; holder death releases it; a same-process second open is refused; raw errors and a positive control captured.
  5. Root-reviewed qualification record plus evidence file, with both hashes pinned.
  6. A release manifest pinning `RELEASE_FILES`.
  7. Explicit settlement of legacy r12 obligations.
  8. Installer `--plan`, then review.
  9. `--apply --confirm …`, then review of the receipt and config sha256.
  10. A separately reviewed activation that sets `ENCLAVE_OPERATOR_EFFECTS_CONFIG/_SHA256` for the agent service and restarts it.
  11. Canary.
- **Example paths:**
  - State: `C:\ProgramData\Enclave\operator-effects\operator-effects.journal`
  - Config: `C:\ProgramData\Enclave\config\operator-effects.json`
  - Receipt: `<config>.install-receipt.json`
- **Target measurements required before activation:**
  - libuv's `O_RDWR|0x10000000` open and FlushFileBuffers succeed with the service identity's Read+Write (no DELETE). If the open requests DELETE, it fails closed and needs a reviewed ACL change.
  - `Get-Volume -FilePath` works on a directory.
  - `Directory.CreateDirectory(path, DirectorySecurity)` and `SetOwner(BA)` work under Windows PowerShell 5.1.
  - The observed file SDDL is stable across agent restarts.
  - The probe completes within 60 s.
  - The time to hash `node.exe` at startup.
  - The receipt/config directory denies the service identity write access (the installer checks only for broad grants).
- **Minimal bounded canary prerequisites:**
  - The agent logs `operator effects: configured` with the reviewed config sha.
  - `/v1/health operatorEffects.state === "configured"`.
  - Readiness `available` becomes true only after the lazy open.
  - No financial action until separately approved.
- **Explicit follow-on (still open):** manual uncertain-state recovery, capacity maintenance, native and full workloads, power-loss, guard and reboot work, platform migration, and every other lifecycle item.

## 7. Additive dependencies and untouched files

- **Dependencies:** none added. Only Node built-ins plus existing project modules are used. `package.json` and the lock file are unchanged.
- **Untouched:**
  - `chain.mjs` (`79771c6c…`), `operator-effects.mjs`, `win-durable.mjs`, `win-exclusion.mjs`, `psrun.mjs`, `owned-durable-state.mjs`
  - `lease-gas-runtime.bundle.mjs` (`159108d1…`), `host-admission.bundle.mjs`
  - root r12 `control-client.mjs`, `protected-isolation.mjs`, `protected-supervisor.mjs`
  - guard files, `install-guard.ps1`, every existing test, every historical report and result
- **Changed pins:** `agent.mjs` (previously pinned `4105b28e…` as the construction entry), `host.mjs` and `initialize-operator-effects.mjs` (previously `e4d01652…`).

## 8. Mutation chronology (this task, candidate/ only)

1. Created `control/windows/node/operator-effects-config.mjs`.
2. Edited `control/windows/node/host.mjs` (constructor wiring; claim gate; status field; `operatorEffectsReadiness` method).
3. Edited `control/windows/node/agent.mjs` (import; seam and `operatorEffects` option before `new Host`; `/v1/health` field).
4. Rewrote `control/windows/node/initialize-operator-effects.mjs` (win32 refusal; Linux unchanged).
5. Created `control/windows/node/install-operator-effects.mjs`, then one edit (preflight artifact/distinct-file checks plus import).
6. Created `test/windows-permit/ow-r1-operator-windows-wiring.test.mjs`, then four fixture/assertion corrections before delivery.
7. Created this report and `RELEASE-CLOSURE-OPERATOR-WINDOWS-WIRING-R1.json`.

Nothing outside `candidate/` was written.
