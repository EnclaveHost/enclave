# 1642: independent SOURCE-ONLY review of KVM native-router-health-v13 (minimal compat repair)

**Scope:** source reading only. No tests, builds, live actions or edits; no messages to peers; no stage changes.
- **Reviewed:** `/home/steven/Documents/Codex/2026-10-23/it/work/native-router-health-v13/`.
- **The router core (v3)** was already reviewed by 6d. This review covers only the v12 → v13 health change and its consumers.

## Pins (verified)
- **The source pin** `c8d2bf87312f97f518f1ac53a194d5e80b213d44ea48e14a3b42febf6d96d144` is the sha256 of **`source-manifest.json`** (`source-pin.txt` matches).
- **The files match their manifest entries:**
  - `windows/vbslike/router/control.mjs` = `966fd3b5…` (21,406 bytes);
  - `windows/node/host.mjs` = `dde60f6e…`.
- **`repair.diff`** (`52f1fac3…`, 28 lines) touches **only** `router/control.mjs` `health()`; the file contains exactly the v13 lines.
- **Not verified:** whether the live nodes run exactly this `host.mjs` (outside source review).

## The change
1. **Partial or composite inventory unavailable:** v12 returned **200** with the legacy body plus `supports.desktop=false`, `supports.gpu=false` and `catalog.derivations=[]`. v13 returns **503**, with the legacy capabilities left unchanged, capacity zeroed (`freeMiB/freeUnits 0`, `allocated* null`), `canStart=false`, `inventory.state='pending'` and `admission.ready=false`.
2. **Journal pending, at maintenance threshold or unreadable:** v12 returned **200** with `canStart=false` and `derivations=[]`. v13 keeps the derivations, and **any `canStart===false` gives a 503** with `admission`.

## Is it the actual regression mechanism? Yes
- **`host.mjs` `isolationVerdict` (l.1073):** it calls `client.health()`. `IsolationManagerClient.health()` **throws on any non-200** (`isolation-client.mjs` l.180-183), and the error becomes `managerHealth = null`.
- **`node-bridge.mjs` `isolationPlan` l.142:** `!manager` gives `unknownInput("manager")`, i.e. **`unknown: true`**.
- **The v12 path:** a **200** body with `derivations=[]` / `supports.desktop|gpu=false` reached `isolationPlan` as a definite **refusal** (`derivation`, `deployment.gpuMilli` l.169, …), then `#giveUp`, then retirement. That matches ef514 being retired during the 7th native launch, when the journal was pending.
- **v13:** the body is never read by the node, and the plan is **unknown** for both legacy and native (the test loops `nativeDesktop: false/true`).

## `host.mjs` l.1208-1215: the unknown branch HOLDS, it does NOT retire (verified)
- **Inside the startup grace:** with `plan.unknown` and a running owner-committed partition within `STARTUP_GRACE_MS` (10 min), the record keeps serving (reason only).
- **Otherwise:** `status: "provisioning", planHeld: true` and **return**. **`#giveUp` is reached only for a definite refusal.**
- **Pre-claim (`#preclaimVerdict` l.1148):** unknown gives `queued`, never `refused`, and is not cached.
- **`refreshManagerView` (l.2930):** a throw gives `managerView.error`, so `coupledRoom` is unknown. New capped claims are refused; `capped:false` (already here) is not.
- **`agent.mjs` `isolationHealth` (l.438-445):** a throw gives `null`, a host statement that is "never raised, never weighed".
- **`desktop-plan.mjs` l.12** (`canStart !== true` gives a refusal) is reached only with a non-null manager. A 503 never produces one. No other node code reads `canStart`/`cannotStart` (grepped `control/`).
- **Steady state is safe:** the routine tick calls `ensureApp` **only when the app is not running** (l.2510). Running domains are not re-verified, stay `running`, and keep renewing (`#renewServing` l.2226).

## Router side
- **Admission is unchanged and not weakened.** The diff touches only `health()`; `spawn()` never consults it.
  - `spawn` recomputes the snapshot (a failure throws before any POST).
  - It checks `s[role].canStart`/native readiness (l.210).
  - `journal.begin` refuses while pending or at maintenance (l.79).
  - The 40+ "refuses before mutation"/latch tests still pass in the log.
- **No false healthy:** every degraded state is **non-200** with `canStart=false` and `admission.ready=false`, and the capacity in the partial branch is zero. No capability or capacity is invented.
- **No recursion:** the partial branch asks the **legacy backend's** `/health` (`this.request('legacy',…)`), never the router. A failing legacy health throws, and `io.mjs` l.43 maps that to `e.status||503`.
- **Custody and data stay available:** `handle()` routes `GET /health` → `health()` and `GET /vms` → snapshot. Per-id `GET`/`DELETE` and custody `POST` go `request(role,…)` **without** consulting health. The data plane (`io.mjs` preamble router) is untouched.
  - **Tests:** "legacy GET/custody remains on original manager…", "unavailable native inventory disables all admission while keeping legacy reads available", and the new test's `GET /vms/hv1234` still routing.

## Tests (`tests.log`: 71/71 pass, 0 skipped, `[queue] EXIT 0`, root's run, not mine)
- **The new tests** (`prepare-tests.py`) use the **real installed** `IsolationManagerClient` against the real `controlServer` HTTP server, for pending launch, partial inventory and corrupt journal. Each asserts:
  - 503;
  - `canStart` false;
  - catalog and `supports.gpu` equal to the normal health;
  - `client.health()` rejects;
  - `isolationPlan` is `{ok:false, unknown:true, input:'manager'}` for legacy **and** native;
  - `GET /vms/:id` routes;
  - `spawn` rejects with **no POST**.
- **One test was adapted:** the previous 200 assertion for the pending inventory became 503 with derivations preserved, which is the intended change. A memory-related constant was adjusted (`36864` → `32768`) in the copied test. That is not a runtime file, but **root should confirm** that edit is intended.

## RECOMMENDATION: **GO for this minimal repair. No blockers.** It removes the actual retire-on-200 mechanism and keeps admission fail-closed.

### Non-blockers (operational; state them in the activation note)
- **N1 (important, pre-existing semantics): a long 503 equals "manager unknown" for any path that re-verifies a deployment.** Those paths are:
  - **node restart / adoption:** the app is not in `apps`, so `ensureApp`, then `planHeld`;
  - forced relaunch, version change, share relaunch;
  - respawn after a domain ended;
  - the owner's config/resize when it relaunches.

  Each holds the deployment (`provisioning`, `planHeld`). Held deployments are **not renewed**, and **are stopped at lease lapse** (`notServing`, l.2456-2460, `#stopApp`).
  - **The consequence:** during a persistent "journal requires manual reconciliation" state, existing domains survive **only while nothing restarts or relaunches them**, and only until their lease if they are re-verified.
  - **Restoring ef514 itself** (a relaunch) is **held until the router journal is reconciled** and health is 200 again.
  - **Procedure:**
    - reconcile the pending native launch through `/router/reconcile` first;
    - no node restarts, forced relaunches or version updates while the router reports 503;
    - watch lease renewal windows.

  This is not a regression of v13 (any unreachable manager behaves the same), but it is the limit of "hold, don't destroy".
- **N2 (cosmetic):** the partial-inventory 503 body clones the legacy `catalog.derivations`/`supports` **without** the normal branch's `V8` filtering. The journal-pending 503 body carries the full composite capability. Both are harmless because they are non-200 and the node never reads them. Consumers that display 503 bodies (UI/tray) must not present them as capability. Optionally filter `V8` in the partial branch for consistency in a later version.
- **N3:** confirm the `36864`→`32768` test-constant edit in `prepare-tests.py` is intended.
- **N4:** the live deployment must be checked to run exactly the manifest bytes (pin `c8d2bf87…`). That is outside this source review.

**Unchanged:** original admin controls and authority. Nothing was removed or edited by me.
