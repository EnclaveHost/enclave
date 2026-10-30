# Independent SOURCE-ONLY review: native manager router draft (control.mjs / io.mjs + tests), 2026-10-26 19:26–19:40Z

## Bytes reviewed
These are identical at the start and the end of the review, so no concurrent change was observed:

| file | sha256 |
|---|---|
| `router/control.mjs` (140 lines) | `d7b85c003d2222d94a8dcbedb1111ead167bd0ca49ed69a06fef78940ccf72fa` |
| `router/io.mjs` (82) | `7f6ade03f8b822b3f7a46000fb6fe617f6e8b97bda6535163d13186979f73303` |
| `router/control.test.mjs` (75) | `003bf5b55cfe53c2b3c2eb3323eeda6f8b889f7a0bade59601205fa6ca5d486e` |
| `router/io.test.mjs` (52) | `25b9d48177f0f3719429ea088e9c7bc45f4090d46569dcea497b51ad1a3b8f4c` |
| `eyesoff-native-link-20261026/native-manager-routing-plan.txt` | `9ec40067e95d6b77565e629bfb0df2757a34a81a37ab68f4b6f9caf01f13a313` |

**Also read, as the contract the router must match:**
- legacy `manager/server.mjs`: `epoch` (`:186`, random per process), `health()` (`:350-410`), the spawn admission (`:520-600`), `publicOf`, and the HTTP routes (`:965-1035`);
- `manager/memory-share.mjs`, `desktop-memory.mjs`, `wmi-launcher.mjs` `type1VmMemMiB`;
- `datapath/datapath.mjs` `parsePreamble` and its refusals.

**Not done:** no edits, tests, builds, network or live actions. The KVM chat's "23 control + 11 IO tests PASS" is quoted, not re-run. I counted the cases: control is 23 (fixed + generated), IO is 11. **No activation.**

**Already raised by root (not repeated):**
- a direct manager launch bypasses the router;
- a pending reservation is not cleared until the backend is observed.

## Findings (most severe first)
### H1. Router capacity is computed from the caller's body, but each backend computes from its own derived catalog record (`control.mjs:104-108`)
- **The mismatch:** the router admits with `gpu = body.derive.inference.gpuMilli ?? 0` and `memMiB = body.derive.policy.memMiB`. The legacy manager reserves `mapping.record.inference.gpuMilli` and `appMemoryForShare(pool, cpuShare, mapping.record.policy.memMiB)` (`server.mjs:522`, `:552`). Its GPU check counts only **its own** domains (`gpuAllocated()`), never the native desktop's 500.
- **Consequence:** a legacy inference spawn whose body omits or understates `derive.inference.gpuMilli` passes the router's shared check (counted as 0). The legacy backend then admits it against its own view and **starts it**, so legacy inference + native desktop exceed 1000 milli GPU.
  - The post-launch check (`:121`) detects the mismatch only **after** the partition exists. It then latches, but the oversell is already live.
  - A body with no `derive.policy` makes `appMemoryForShare` throw, so **every** such legacy spawn gets a 503. That is a legacy regression if any legacy caller omits it.
- **Fix:**
  - Treat a missing GPU or memory figure as unknown, i.e. refuse; never default it to 0.
  - Before the POST, require `body.gpuShare`/`derive` to be consistent: `gpuShare > 0` ⇒ an exact `derive.inference.gpuMilli` (or `derive.desktop.gpuMilli` for native), and `gpuShare == 0` ⇒ none.
  - Better: compute from the same derivation the backend uses (pinned catalog/cid → record), as the native path effectively does through its pins.
- **Tests needed:**
  - a legacy inference spawn with `gpuShare > 0` and no or a smaller `derive.inference.gpuMilli` while the native desktop holds 500: the router must refuse **before** the POST;
  - a legacy spawn body exactly as the node agent sends it today (`host.mjs` `plan.spawn`): it must be admitted, and its post-check observation must match.
- **Same class for rows** (`:69`): `r.gpuMilli ?? r.inference?.gpuMilli ?? 0` counts a row with no GPU field as 0. The backend rows do carry `gpuMilli` (`server.mjs:578`), so require it to be present (`natural(r.gpuMilli)`) rather than defaulting.

### H2. After a backend mutation the router can answer the caller with a 4xx (`control.mjs:116`)
- **The cause:** after a 200/201, `routeFor(r.id)` **throws status 400** when `r.id` is missing, malformed, or `nd`-prefixed but not 32 hex. `controlServer` (`io.mjs:43`) sends `e.status`, so the client gets **400 for a launch that happened**.
- **Why it matters:** the supervisor reads 4xx as a conclusive refusal, which is exactly the "mutation answered 4xx after side effects" case. The latch stays, but the client may give up or retry elsewhere while a partition exists.
- **Fix:** wrap everything after `journal.begin` so that any failure becomes a 502/503 ("launch outcome unknown; reconcile").
- **Test:** a backend that answers 201 with `{id: undefined}`, `{id: "nd-bad"}` or a wrong role must give the client a 5xx, with the latch kept.
- **The same 400 leaks from `snapshot()`:** a legacy row whose id starts with `nd` without being a valid native id makes `routeFor` throw 400 inside the inventory. `GET /vms` and `/health` then answer 400 instead of 503. Inventory faults must be 503; wrap `routeFor` in `snapshot` to rethrow 503.

### H3. The durable latch is not durable, and can fail open (`control.mjs:25-34`)
- **`pending()` is `fs.existsSync`**, which returns **false on EACCES/EIO/ENOTDIR**. An unreadable latch, or an unreadable directory, reads as "no pending launch" and admission reopens. **Fix:** `lstat`; ENOENT ⇒ false; any other error ⇒ pending (throw 503).
- **`begin()` fsyncs the file but not the parent directory.** After a power loss the directory entry can be lost while the POST already went out. The latch then disappears, which is the crash window the design exists to close. **Fix:** fsync the directory fd after create; also fsync after `clear()` (less critical: a resurrected latch fails closed).
- **The journal path's filesystem is unchecked.** On tmpfs (`/run`) a host reboot clears it. Recovered partitions do block through the inventory (`recovered`), but a manager restart without a reboot does not.
  - **Fix:** require the journal on a persistent local filesystem at construction (statfs type check), owner-only directory.
  - **Tests:** EACCES on the latch ⇒ refuse; dir-fsync ordering (inject fs).

### M1. Any backend 4xx or unverifiable outcome wedges ALL admissions, legacy included, with no reconcile tool (`:125`, `:86`, `:95`)
- **This is safe but brittle:** an ordinary user-error 400 from the legacy manager (a bad catalog/cid, "a deployment ID is required…", "Shield GPU allocation is full" which is a 400 at `server.mjs:553`) now stops every launch on the node until an operator deletes the file.
- **The design says** the latch clears on a *conclusive* 4xx; that is not implemented, and there is no reconcile procedure in code.
- **Recommendation:** the explicit `reconcile()` that root already requested. It clears only when a fresh snapshot in the **same epochs** proves no row with that `name`/`id` and an unchanged inventory digest versus the pre-POST snapshot, journalled. Do not clear automatically on status alone.
- **Test:** a 400 with no new row → reconcile clears; a 400 with a new row → reconcile refuses.

### M2. Timeouts are shorter than a slow but successful launch (`io.mjs:8`, `:28`, `:46`)
- **The cause:** `makeRequest` has a 125 s deadline per backend call, and `spawn` = 4 snapshot calls + POST + 4 snapshot calls. The legacy POST itself spans the component fetch and partition start (`server.mjs:599` `await backend.start`).
- **The effect:** a slow legitimate launch hits the deadline, so the latch sticks (M1) and every admission stops. `server.setTimeout(150 s)` also destroys the client socket mid-spawn, giving an ambiguous result. Client retry → 409 adoption, which is good.
- **Fix:** a POST deadline ≥ the supervisor's own spawn timeout, separate from GET deadlines. Document that the client socket can drop.
- **Test:** a backend POST that answers 201 after (GET deadline + 1) ms must not latch.

### M3. When native is down, `/health` and `GET /vms` are 503 for the whole node (`:74-87`, `:131`)
- **The cause:** both go through `snapshot()`, which needs both managers. The design keeps full inventory and admission fail-closed (correct), but legacy `GET /vms/:id`/`DELETE`/custody stay routed (`:133-138`, tested).
- **Risk:** if the node agent treats `/health` 503 as "manager down" for **legacy** domains (stops claiming, re-verifies or retires), a native outage degrades all nine legacy apps.
- **Needed:** a test or recorded behaviour of the node agent with router `/health` = 503 while legacy domains run. Alternatively, health returns 200 with legacy fields and `canStart:false`, V8 removed and an explicit `native:unknown`, instead of 503.

### M4. Legacy routing parity (`io.mjs:36`)
The router 404s paths that the legacy server accepts: a trailing slash, any query string, and percent-encoded ids (legacy normalizes `/+$` and uses `decodeURIComponent`).
- **Custody callbacks** are signed over `u.pathname`, so exact paths matter. The router forwards `req.url` unchanged (good), but a client that today sends `?…` or a trailing `/` now fails.
- **Needed:** an inventory of the node agent's actual request paths, plus a parity test (each legacy-accepted path is either routed identically or deliberately refused, documented).

**Response bodies are re-serialized** (`io.mjs:20`, `:31`: `JSON.parse` then `JSON.stringify`) and backend response headers are dropped.
- Integers above 2^53 lose precision and number formatting changes.
- This is acceptable only if no response body is signed or byte-compared. Confirm for `custody-auth` replies and the `GET /vms/:id` attestation fields.
- The plan says "exact original backend view/header bytes forwarded"; that holds for **requests** only.

### M5. Legacy-namespace assumptions that fail the whole inventory (`:61`, `:66`, `:97-99`)
- **Legacy desktop rows:** any legacy row with `imageRole === 'desktop'` makes the snapshot throw, so all `/vms` and admissions 503. If the current legacy manager hosts any desktop domain (it advertises `derives: …/8` when `#desktop` is set), activation breaks inventory.
- **V8 requests:** every V8 request is classified native (`:97`) and refused unless it matches the single pinned deployment. Any other V8 tenant is refused (by design, but it is a legacy regression if V8 is served today).
- **Preflight is not implemented in code:** the plan requires refusing installation if the legacy inventory has `nd*` ids or desktop domains.
- **Tests:** an activation preflight against the real nine-VM inventory shape; and a legacy row `nd-xyz` gives 503, not 400.

### L1. Data plane (`io.mjs:50-82`); byte preservation holds
**What is correct:**
- the preamble plus the trailing bytes of the same chunk are written first, then `pipe`;
- the client is paused between parse and connect;
- no TLS termination; destinations are fixed ports only;
- `parsePreamble` and `routeFor` are strict; the deadline is 5 s; the head is ≤ 512 + 64 KiB; connections are bounded at 1024.

**Gaps:**
- (a) **Half-close:** `net.createServer` has the default `allowHalfOpen:false`, so a client that half-closes after its request cannot receive the response. Check against the legacy datapath behaviour and add a half-close test.
- (b) **Malformed or invalid input closes silently.** The legacy datapath answers `NO refused:…` (`datapath.mjs:88-92`). Client diagnostics and retry logic may differ. Either answer `NO refused:router-…\n` or document it.
- (c) **The 180 s idle timeout** on spliced streams is new relative to legacy (there, timeouts appear only on preamble and dial). An idle long-lived TLS session is cut. Make it configurable and match legacy, or justify it.
- (d) **No per-source or per-id cap at the router.** The backend keeps its own caps, and 1024 global is the only bound, so one client can occupy all 1024 slots with slow preambles for 5 s each. Consider a per-remote-port/pid cap or a lower preamble concurrency limit.
- (e) **Shutdown:** `close()` destroys clients, which then destroy upstreams through `close`. `dial` timers can fire after shutdown (harmless). `controlServer` has no close helper: in-flight spawns continue, and a process exit mid-POST leaves the latch, which is correct. Add a shutdown test asserting the latch persists across SIGTERM mid-POST.

### L2. Smaller items
- `routeFor` uses `nd` + **32** hex (`:10`), but the plan says "nd plus 24 hex". Align the document or the code. The backend's `ID_RE` accepts both.
- **Readiness witness:** `:104` special-cases by `name` + `memMiB` only, while the backend also requires `appId === READINESS_WITNESS_APP_ID` (`wmi-launcher.mjs:195`). The router's `type1VmMemMiB` call lacks `appId`, so its physical estimate differs from the backend's 512. The comparison is conservative, but the exact readiness post-check uses `>= 512`. Add a test with the real readiness body.
- **`health()` throws on missing legacy fields** (`h.catalog.derivations.filter`, `h.supports.desktop`). It is a TypeError → 503, which fails closed, but the legacy fields' presence is assumed. Test against the real legacy `health()` output.
- **`controlServer` queue:** queued spawns hold `active` slots (32), so health and GET can get "router busy" behind long spawns. Reserve slots for GET, or bound spawns separately.
- **Pools and the host floor:** the router trusts `physicalMemory.poolMiB` as already excluding the host floor (16 GiB on the NUC as well), and requires the two managers to report equal pools. Add an activation check that the pool equals host RAM − 16 GiB floor − both managers' host overhead, recorded. 32 GiB VM qualification is pending, so no capacity claim follows from this code.

## Tests to add (summary)
- **H1:** a legacy GPU spawn underdeclared or missing `derive` → refused before POST; a real node-agent spawn body round-trip.
- **H2:** 201 with a bad or missing id → 5xx to the client, latch kept; a legacy `nd-x` row → 503.
- **H3:**
  - EACCES on the latch → refuse;
  - directory fsync after begin;
  - a tmpfs journal refused;
  - restart persistence (existing test) **plus** a power-loss simulation (directory entry absent → refuse to start without operator reconcile).
- **M1:** reconcile proof (same epochs, no row, unchanged digest) clears; otherwise it is kept.
- **M2:** a slow successful POST does not latch.
- **M3:** node-agent behaviour with router `/health` 503 while legacy runs.
- **M4:** legacy path parity; response-byte fidelity of custody replies.
- **M5:** activation preflight with legacy desktop or `nd*` rows.
- **L1:** half-close, `NO` reply parity, idle long-lived stream, slow-preamble flood, SIGTERM mid-POST.

## Verdict
- **Not ready for activation:** H1-H3 must be fixed with tests, and M1-M5 decided.
- **What is sound in this draft:**
  - deterministic native-ID dispatch with no fallback;
  - exact request-byte forwarding for custody;
  - serialized admission with the latch written before the POST;
  - shared pools are not doubled;
  - unknown, recovered or unattributed state fails closed;
  - same-epoch observation before the latch clears;
  - the data plane preserves ciphertext bytes and never invents OK.
- **Unchanged by this review:** legacy apps, managers and the NucBox. No restart and no messages to the other chat.

## Addendum (19:31Z): a concurrent change was detected
**At the final re-hash,** `control.mjs`, `io.mjs` and both tests were unchanged. A **new** file had appeared: `router/main.mjs`, 1761 bytes, mtime 19:29:06Z, sha256 `801f8edd572891c987155d946e091aef545435f1ce895ca0ec5cfe41c0a2d0cb`. I read it once; it was not part of the hashed review set above.

**What holds:**
- fixed ports: 8091/8095 to the managers, 8092/8096 to the data planes, and 8097/8098 listening on `127.0.0.1` only;
- the config file is pinned by absolute path and sha256, ≤ 64 KiB, with exact keys `journal, nativePins, schema`;
- SIGTERM/SIGINT close both listeners and no forced exit happens mid-spawn. A kill mid-POST leaves the latch, which is correct.

**Findings:**
- **H3 applies directly:**
  - `config.journal` is only required to be absolute;
  - nothing checks that its directory exists, is owner-only, or sits on a persistent filesystem rather than tmpfs;
  - `LaunchJournal` adds no directory fsync.

  Add these at startup: refuse unless the parent directory is owner 0700, on a persistent filesystem, and the path is not a symlink.
- **Shutdown:** `control.close()` does not close idle keep-alive sockets, so the process can linger up to `server.setTimeout` (150 s) after SIGTERM. Add `closeIdleConnections()` after close; keep in-flight spawns running to completion.
- **Startup:** `nativePins` is validated by the `CompositeManager` constructor (good). No startup check compares the managers' pools with host RAM − 16 GiB floor (L2).
