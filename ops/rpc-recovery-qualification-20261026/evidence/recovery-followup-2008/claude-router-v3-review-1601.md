# Review 1601: native manager router v3 (independent, SOURCE ONLY; follow-up to 1586)

**Request:** `eyesoff-native-link-20261026/router-review-v3.txt`.

**Bytes reviewed** (`enclave-kvm-guest/windows/vbslike/`):

| file | sha256 |
|---|---|
| `router/control.mjs` (217 lines) | `57fa9ec18e533850ca4d3cc4bd1e883aea74a99c70ef8bf89f37909922043795` |
| `router/io.mjs` (82) | `3a81d403c8f9a4d20d2f7651b31ca5d5a8eb8acae9c2b817082ec1bae74083e2` |
| `router/main.mjs` (20) | `473c4fa8d4e5d764b33683f3fcb2b6b06667855597752b3924f28baf225c5c57` |
| `router/control.test.mjs` | `1c50af3e…` |
| `router/io.test.mjs` | `25b9d481…` (unchanged since 1586) |

**The contract the router must match:**

| file | sha256 | sections read |
|---|---|---|
| `manager/server.mjs` | `93fb60e8…` | spawn `:512-612`, `gpuAllocated`/`physicalRamAllocated` `:333-346`, `publicOf` `:731` |
| `manager/derive.mjs` | `a4754473…` | record `:118-155` |
| `manager/wmi-launcher.mjs` | `e19e6d4e…` | `type1VmMemMiB` `:187-199` |

**Not done:** no tests, builds, network, production actions, USB or edits. "56 tests PASS" is the peer's claim and was not re-run.

## Verified fixed since 1586 (in code)
| 1586 | where | what the code does now |
|---|---|---|
| **H1** | `control.mjs:157-165` | Legacy spawns must declare `gpuShare` with an exact V4 `derive.inference.gpuMilli = round(gpuShare·1000)` (none when `gpuShare` is 0) and `derive.policy.memMiB` in 64..65536. **This matches `derive.mjs:126-130,148-153`, which copy those request values into `mapping.record`.** |
| | `:108-110` | Rows require `natural(gpuMilli)` and physical memory (no `?? 0`). |
| **H2** | `:181-192` | Every post-`begin` error, non-200/201 or unverifiable response becomes 503 with the latch kept. |
| | `:101` | `routeFor` inside the snapshot becomes 503. |
| **H3** | `:45-65` | `lstat`-based checks: parent 0700/owner, regular file, `nlink` 1, ≤ 1 MiB, not tmpfs/ramfs/proc/sysfs; hash-chained rows; a torn tail (`!endsWith('\n')`) refuses. |
| | `:66` | `pending()` throws 503 on any read problem. |
| | `:39-42` | `initialize` fsyncs the file and the directory; production never creates the journal (`main.mjs:12` has no initialize). |
| **M2** | `io.mjs:22` | GET 10 s and POST 125 s, separate. |
| | `main.mjs:16` | `closeIdleConnections`. |
| **M3** | `control.mjs:115-131` | When the snapshot fails, `/health` returns the legacy health with `canStart:false`, derivations empty, GPU/desktop not ready; `/vms` stays 503. |
| **M4** | `:18-26` | `routePath` decodes, normalizes a trailing `/` and accepts queries; the original `req.url` is forwarded unchanged (`:215`). |
| | `io.mjs:20,31,42` | Raw backend response bytes are returned. |
| **Reconcile** | `control.mjs:194-206`, `main.mjs:13` | Explicit and positive only: the same epoch, the minted id present with name, app memory, physical ≥ expected, `gpuMilli`, `runtimeId`, `cid` and `catalog`. **Absence, a 4xx, a restart or elapsed time never clear it** (confirmed: `clear` is called only at `:201`). |
| **IDs** | `:175-177` | Minted for both roles before the journal (native `nd`+32 hex, legacy `hv`+32 hex), with a collision check. Legacy honours `body.id` (`server.mjs:534-541`). |

**Resource accounting matches the backends:**
- **GPU:** legacy `gpuMilli = inference?.gpuMilli || 0` (`server.mjs:552`).
- **Physical memory:** counted over all records, as in the router.
- **The readiness witness:** the backend has `memory: null` (`:518-519`), so the router's row fallback to `policy.memMiB` (256) is consistent. The router's admission estimate (`type1VmMemMiB(256,{name})` = 2048 MiB without `appId`) overestimates compared with the backend's 512, which is conservative.
- **CPU:** no CPU pool is accounted by either manager (`cpuShare` only sizes memory), so this is not a router regression. It remains the peer's open "shared CPU pool" assessment.

## Findings (most severe first)
**B1 (HIGH, availability; data-safe): any refused legacy launch permanently stops ALL admission node-wide.**
- **The policy is correct:** a non-200/201 keeps the latch (`control.mjs:188-192`), and the only clear is a positive same-epoch row (`:197-201`). So a launch the backend **refused without creating anything** can never be cleared by the tool.
- **Many legacy refusals are deterministic and reachable after the router's pre-checks:**
  - `name` not `0x`+64 hex for a non-witness, i.e. "a deployment ID is required for RAM allocation" (`server.mjs:521`, 400);
  - a readiness-named spawn whose `appId` is not the witness (the router assumes the witness from name + 256, `control.mjs:170`);
  - every `derive.mjs` validation (catalog, cid, runtimeId, policy bounds, ports, component preamble; `:118-145`);
  - component fetch failures and startup-package mismatches.
- **Every such 4xx leaves legacy and native admission closed** until someone hand-appends a hash-chained `observed` row, for which there is no tool or reviewed procedure.
- **Required, within "absence never clears":**
  - (a) before `journal.begin`, run the backend's **deterministic** request checks on the same code, e.g. import `derive.mjs`'s structural validators and the name/id rules; a refusal is then a pre-POST 400 with no latch;
  - (b) a reviewed operator procedure for a latch after a backend 4xx (evidence required, journalled, never automatic). Until then, treat any post-POST 4xx as a node-wide admission outage in the activation plan.
- **Tests:** a non-hex name, a mismatched readiness `appId` and a malformed catalog/cid are refused **before** the POST, with no latch.

**B2 (MEDIUM-HIGH, real compatibility): a catalog compared by `JSON.stringify` can wedge a SUCCESSFUL launch.**
- **The cause:** `expected.catalog` is the caller's `body.derive.catalog` verbatim (`:178`), compared with `JSON.stringify(v.catalog)` (`:200`). The backend row's catalog is `derive.mjs`'s rebuilt `{app, version}` (`derive.mjs:148`).
- **The effect:** a caller object with other key order or any extra key (which derive ignores) never correlates. The latch stays, reconcile uses the same comparison, and admission is stopped permanently after a launch that worked.
- **The fix:** compare `catalog.app` and `catalog.version` (and refuse a non-exact `{app, version}` pre-POST).
- **Test:** the **real node-agent spawn body** (`host.mjs plan.spawn`) round-trip to `observed`.

**B3 (MEDIUM, journal integrity): `--reconcile` is a second writer with no lock.**
- **The cause:** `main.mjs:13` opens the same journal in a separate process while the service may be running. `append` is read-then-`open('a')` (`control.mjs:67-71`) with no inter-process exclusion.
- **The effect:** concurrent appends produce two rows with the same `seq`, so the chain is invalid and all admission stops (fail-closed, manual repair).
- **The fix:** an exclusive journal lock (O_EXCL lockfile or a Windows exclusive handle) held by the service and required by `--reconcile`, or reconcile only through the running service, plus a test.

**B4 (MEDIUM, journal capacity): the 1 MiB cap (`:51`) is a hard stop.**
- **The arithmetic:** each launch appends a pending row (with `expected`) and an observed row, about 0.9 KB, an estimate. After roughly 1,000 launches the journal is refused and node-wide admission stops.
- **Needed:** a reviewed rotation, allowed only when the last state is `observed`: a new journal whose first row carries the previous file's final digest. Plus a test at the bound.

**B5 (MEDIUM, cross-epoch recovery).**
- **The cause:** reconcile requires `s.epoch === r.epoch` (`:197`). The epoch is a hash of both managers' per-process random epochs.
- **The effect:** any manager restart after the POST (crash, update, host reboot) makes the pending launch unclearable by the tool, even when the domain is **positively** present. Meanwhile, recovered rows make the whole snapshot 503 (`:102`) until legacy reconciles its own record.
- **Needed:** a reviewed **positive** cross-epoch path (the same minted id, name and resources present after the backend's own recovery is reconciled), never absence.

**B6 (MEDIUM, platform): every storage protection is POSIX-only, but the router runs on Windows.**
- **The cause:** owner/mode checks (`:50,52`) and the directory fsync (`:42`) are skipped on `win32`, and the `statfs` magic list (`:53-54`) means nothing on Windows.
- **Already a precondition (the peer lists it):** in code, before activation, the NTFS DACL must be owner/SYSTEM-only with no write by the interactive user and no inherited write, on a fixed local NTFS volume (not removable, not a RAM disk).

**L1:** when the journal is unreadable, `/health` is 503 (`:143` throws outside the fallback), so the node agent sees a full outage, legacy included. It fails closed; record the node-agent behaviour (as 1586 M3).

**L2:** a spawn can exceed the 150 s socket timeout (snapshots plus a POST up to 125 s plus the observe snapshot; `io.mjs:46`). The client sees a dropped socket; the latch handles it. Document it.

**L3:** the data plane is unchanged from 1586 L1 (`io.mjs:50-82`):
- the half-close default;
- a silent close instead of a legacy `NO refused:` reply;
- the new 180 s idle cut;
- no per-source cap.

## Verdict
**Not ready for activation.**
- **No data-loss or oversell defect found:** resource accounting matches both backends, and absence never clears a pending launch.
- **Before activation:** B1 and B2 can stop all node admission in ordinary operation and must be fixed. B3–B6 need code or reviewed procedures.

## Remaining activation limits (beyond the findings; from the request, confirmed)
- **Storage:** Windows NTFS ACL and persistent-journal checks (B6).
- **CPU:** the shared CPU pool assessment.
- **Preflight:** a read-only sidecar scope/preflight against the real inventory (9 legacy, physical 39,772 MiB, no native, the readiness witness at 256/512).
- **Memory:**
  - an explicit physical-free guard;
  - **32 GiB VM / 24 GiB app qualification before any exact memory-policy override.**
- **Launch path:** every direct launch caller drained through the router.
- **Install:** a narrow patch of the installed snapshot (no broad rebuild).
- **Endpoints:** node and network endpoint activation coordinated, **never restarting the legacy Shield manager**.
- **No production change** (and no sixth claim) is implied by this review or by unit tests.
- **Admin controls:** untouched.
