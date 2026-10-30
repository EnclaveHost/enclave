# Review 1617: native-manager sidecar v12 final candidate (independent, SOURCE ONLY; no activation authority)

**Directory:** `…/2026-10-23/it/work/native-manager-sidecar-v12/`.

**Not done:** no tests, builds, live actions, USB or edits. The "73 tests PASS" claim is the peer's; `tests.log` shows `# tests 73 / # pass 73 / # fail 0`, which I read but did not re-run.

## Bytes verified
**The frozen review set:**

| file | sha256 | status |
|---|---|---|
| `source-manifest.json` | **`58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929`** | = the claim |
| `candidate.diff` | `4fc7c95a…` | = the manifest's `diffSha256` |
| `operations.txt` | `5b2aa210…` | |

- **All 114 manifest entries** match by sha256 and size, both in `control/` and in `source.zip`. 109 come from the baseline (`baseline-files.json` `fb1325f7…` = `baselineManifestSha256`); the new ones are the router files.
- **`bootstrap.mjs`** (`02b6625b…`) re-verifies the manifest pin and **every** manifest file before `import()`. Both `run-*.cmd` pass the manifest pin.

**The directory was modified DURING this review:**
- **Re-packaged:** `package.py`, `source.zip` and `stage-plan.json` (13:04:26).
- **Launcher changed:** `run-manager.cmd` went from `56e7c882…` to `97d27cf9…`.
- **New files:** `fetcher-config.*` and `inspect-fetcher.ps1` (13:02:29).
- **Unchanged:** the manifest, diff and operations bytes.
- **At first read** `stage-plan.json.sourceZipSha256` (`cc967513…`) did **not** match `source.zip` (`6f523960…`).
- **After the re-package** they agree: `source.zip` = **`1fd9e48b94c82a911fd2e01c6cd5b5b3f2ec7398c4e7ff07a6cba9cba46d9baf`** (119 entries = 114 manifest files + `source-manifest.json` + `bootstrap.mjs` + `run-manager.cmd` + `run-router.cmd` + `initialize-journal.mjs`); `release-config.zip` = `ac2f02cc…` = the plan; `router-config.json` = `a4ba4c47…` = `routerPin`.

**Freeze requirement (BLOCKER for handoff, procedural):** re-freeze the **package set** (`stage-plan.json`, `source.zip`, `release-config.zip`, `bootstrap.mjs`, `run-*.cmd`, `initialize-journal.mjs`) and record its hashes in the frozen handoff. The launchers are inside `source.zip`, but nothing in the reviewed manifest pins them.

## Corrected / confirmed findings (actual code)
- **Ownership isolation holds both ways.**
  - **The native copy:** `OWNER_MARKER = "enclave-native-vbslike-domain"` and the default prefix `enclave-native-` (diff); `main.mjs` passes no prefix, so the default applies. `survey` selects `Name.StartsWith(prefix) -or Notes.StartsWith(OWNER_MARKER+"/manager|")` (`wmi-launcher.mjs:667-669`), `teardown` selects by prefix (+ marker) (`:653-655`), and a failed create only removes its own `$name` (`:483`).
  - **The unchanged legacy:** filters only `enclave-app-` / `enclave-vbslike-app-domain`.
  - **So:** neither manager can survey, recover, stop or remove the other's VMs, and DELETE/GET/custody route by id to the original backend.
- **The memory mapping is exactly one qualified case:**
  - `desktopVmMemMiB(24576) = 32768`; every other value keeps `ceil(app·3/4)·2`.
  - Native admission is pinned to `cpuShare 0.25` (`main.mjs` gate and router `checkNative`), and the app RAM is `floor(appPool·0.25)` (`memory-share.mjs`).
  - **The peer's live inspection** (`fetcher-config.json`, not verified by me) shows `NODE_APP_RAM_GB=96`, i.e. 98,304 MiB, which gives exactly **24,576** MiB. That is the qualified case.
  - The router's physical estimate uses the same `desktopVmMemMiB`.
- **B1:** the router pre-validates **before** the journal intent (`control.mjs:164-186`):
  - legacy: the backend's own `derive()` on placeholder component bytes, derivation served, runtime, the secret/config rules, `refuseUnsupported`, the exact readiness witness (cid, policy, shares), and a `0x`+64-hex name;
  - native: `validateDesktopRecord` and `desktopSpawnRefusal`.

  This removes the deterministic-4xx wedge of review 1601 B1. A dynamic fetch or backend failure can still latch; that is the documented manual path.
- **B2:** catalog keys must be exactly `{app, version}` (`:192`), and correlation compares `app`/`version` fields (`:243`).
- **B3:**
  - `--reconcile` is an HTTP POST to `127.0.0.1:8097/router/reconcile` (`main.mjs:13-15`) and never opens the journal;
  - it runs under the admission mutex (`control.mjs:248`) and clears only on a positive same-epoch correlation (now including `cpu.grantedUnits`);
  - **single writer:** `lockJournal` creates `<journal>.lock` with `'wx'` (`platform.mjs:36-41`); a stale lock blocks startup and is never auto-cleared.
- **B4:** admission stops at a 900,000-byte journal (`hasCapacity`, `begin`, `health`; `control.mjs:78-79,156`). Rotation is offline only, per `operations.txt`.
- **Shared CPU** is accounted (`cpuForShare`, `cpu-share.mjs`).
- **Fresh physical guard:** `Win32_OperatingSystem.FreePhysicalMemory` ≥ physical + 17 GiB per spawn (`control.mjs:215-216`, `platform.mjs:8-12`).
- **Windows storage** (`platform.mjs:13-33`, at startup):
  - fixed local NTFS;
  - SYSTEM owner on the file and its parent;
  - protected ACLs with only SYSTEM/Administrators Allow entries;
  - no reparse point in the ancestry.
- **B5 (cross-epoch):** no code bypass; the operations text keeps it as an evidence-based offline procedure (accepted by root).

## Remaining findings (non-blocking unless noted)
- **F1 (MEDIUM): an unpinned executable.**
  - **What:** the new `run-manager.cmd` sets `ENCLAVE_CID_FETCHER=C:\Program Files\Enclave\control\windows\node\fetch-cid.py`, the **installed** legacy copy. That file is executed by the native manager, but neither the manifest nor `bootstrap.mjs` verifies it (`main.mjs:39` defaults to the pinned `../../node/fetch-cid.py`).
  - **Fix, either:** drop the override (use the pinned copy), or verify the installed file's sha256 equals the manifest entry at staging and record it.
- **F2 (LOW-MEDIUM): an unpinned shared script.**
  - **What:** `run-manager.cmd` first `call`s the shared, unpinned `shield-config.cmd`. Values it supplies (`NODE_APP_RAM_GB=96`, `NODE_VCPUS`, launcher/egress options) determine admission and the 24→32 GiB mapping.
  - **Why it is fail-closed today:** the router requires equal pools across managers, so a changed file without a legacy restart refuses.
  - **Fix:** record the file's hash in the staging evidence, or set the native-relevant values explicitly in the pinned launcher.
- **F3 (LOW): the physical pool.** `NODE_VM_RAM_GB=83` is forced for native. The router refuses unless it equals the legacy manager's physical pool, so step 2 must show `physicalMemory.poolMiB` equal on both managers (it is otherwise refused, not unsafe).
- **F4 (INFO):** `FreePhysicalMemory` excludes standby cache, which is conservative. The PowerShell check has a 10 s timeout per admission; a failure gives 507/503 (fail-closed).

## Remaining actual platform qualification (not shown by source)
1. **Re-freeze:** the package set (blocker above), then staging into fresh immutable directories with the `prepare.py` hash checks recorded.
2. **Windows checks on the real host:** the journal ACL/NTFS/reparse check passing (`checkJournalStorage`), the lock behaviour, the `--reconcile` HTTP path, and an empty native inventory with the 9 legacy VM IDs unchanged.
3. **Equal pools on both managers:** `NODE_APP_RAM_GB` 96 / app pool 98,304 MiB; `NODE_VM_RAM_GB` 83; CPU pool. Fresh free memory ≥ 32 GiB + 17 GiB at the native claim.
4. **Memory qualification:** 24 GiB app / 32 GiB VM, per `memoryQualificationSha256` `2683548b…`. The final guest cleanup ended before the GoPASS marker (stated limitation). Host cleanup was independently verified.
5. **Admission caller drain:** no direct `POST /vms` to 8091 remains.
6. **Endpoint switch:** coordinated with Decentralize enclave.host, **with no legacy Shield manager restart and no app VM stop.**
7. **Owner-release acceptance:** `/exec` x86_64, uid 1000 `/home/desktop`, an authenticated JPEG/input check, and the masked CLI.

## Verdict
**No code blocker found** in ownership isolation, the memory mapping, B1–B4, CPU/physical guards or Windows storage checks.

**Before handoff:**
- the package set must be re-frozen and its hashes recorded (it changed during this review);
- F1 (the unpinned installed CID fetcher) should be resolved;
- F2/F3 recorded as staging evidence.

**No activation authority** follows from this review.
