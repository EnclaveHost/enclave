# writer-integrated-stage/r1: cold-recovery r2 + driver r1 + enrolled relay startup wiring. EARLY REVIEW + GAPS (building; nothing run)

**Base composition:** r9 release → two-anchor r1 → r2 → r3 (`5f141c3f`) → cold-recovery r2 (`e903c224`) → driver r1 (two new files).
- **The composed tree:** `177184a6f10fb76b35f867190bdfc6616ece1777` (scratch `/tmp/w5`). Every frozen patch applied cleanly, in this order.
- **Driver stage SUMS verified:** `05c3dc7d…`.
- **Untouched:** all frozen stages (including their scratch dirs) and the KVM original source; this is a staged composition only.
- **Not done by me:** tests, builds, network, VM, live actions or commits.

## Independent review of the driver's source (`relay/derived-reader-driver.mjs` `689ff934…`, 252 lines)
**Holds, as read:**
- **Single flight:** across tracks, with `tick` refusing while in flight.
- **Strict config:** exact keys; `stateRefreshSec` < 120; `budgetSec.provisional` ≤ 120; `maxRange.final` ≤ 1800. No key enables provisional: that is `provider.status().provisional !== null` only.
- **Finality first:** urgent finality (no anchor, recovery to the saved floor, or B_f age at the deadline) pre-empts cold and routine finality, which pre-empt provisional. **A recovery target never passes `savedFloor`.**
- **Evidence:** an unreadable or malformed view counts as full and fenced; the limits are imported from the journal module.
- **S confirmation:** S is counted only when the driver's own `submitProvisional` anchor equals `status().provisional.stateThrough`. `cannotMeet120s` stays true otherwise.
- **The witness:** checked against the ticket's `maximumWitnessBytes` and dropped after submit. An unknown shape is never submitted.
- **Retry-later:** busy, single-native and outstanding-ticket refusals count as no failure.
- **`stop()`:** aborts the owned step's signal, which the r2 provider propagates to its native run, then awaits it.

**Observations (no defect blocks integration):**
- **(a) `cold`:** the cold-recovery r2 provider already runs the backward-history scan **itself** (background I/O, off the native slot). Integration therefore passes **`cold: null`**, so the scan is not duplicated.
- **(b) Concurrent schedulers:** the driver's `prepare`/`submit` and the loopback push API (`ENCLAVE_DERIVED_READER_API_PORT`) would compete for the same one-shot tickets. Integration **refuses** both being configured together (fail closed).
- **(c) Byte bound:** `evidence().bytes` must be the anchor journal's actual committed byte length, so integration uses the file size of the role-committed journal path. When the journal lacks `readProvisional` (no provisional tier), the view fails closed.
- **(d) Bootstrap:** the driver relies on the provider error text `candidate range exceeds reader bounds` to recognise a bootstrap. That text is stable in r2 `provider.mjs`. Noted for KVM.

## API feasibility (checked in source)
| needed | exists? | integration |
|---|---|---|
| provider `status`/`prepare`/`submit`/`prepareProvisional`/`submitProvisional` | yes (r2/r3 + cold r2) | `service.reader` passed directly (in-process, never HTTP) |
| target hints | the own Base EL via `baseUrl` (role-bound endpoint) | `eth_getBlockByNumber('finalized'\|'safe', false)` numbers, untrusted hints, through KVM's `boundedRpc` |
| evidence view | the r2 lifecycle journal `readProvisional()` + the committed file | `{states, facts, bytes: fs.stat(journalPath).size, fenced}` |
| rollup config template | **not in the image record** (`metal/derived-reader-image.json`; the role composes only the 3 endpoints) | a template **file path** inside the signed driver policy; the file is read at start (≤ 1 MiB, `l2_chain_id` = 8453). **GAP:** the measured image must ship and pin that file |
| witness producer | **ABSENT from the tree.** The README says it "runs separately on its private backend"; only the push API (`api.mjs`) exists | **a real adapter:** a loopback-only (in-guest) HTTP pull transport with an exact request schema (the ticket is never sent), byte cap = min(ticket cap, policy cap), timeout, abort, no redirects. **GAP:** the producer process itself (preimage/blob collection from the own L1/L2 nodes) does not exist and is not written here. Without it, every driver run refuses (bounded backoff) and no fake path exists |

## Plan (this stage)
1. **`relay/derived-reader-driver-wiring.mjs` (new):**
   - `driverPolicy` (an exact signed section `driver` = {format, schedule (= the driver's config), witness {url, timeoutMs, maxBytes}, targets {timeoutMs}, rollupConfigTemplateFile});
   - `createWitnessTransport`;
   - `startReaderDriver(...)` with `cold: null`.
2. **Runtime and relay:**
   - `relay/derived-reader-runtime.mjs` exports these (the separate bundle).
   - `relay/derived-writer-authority.mjs`, enrolled state branch only:
     - start the driver when the reader config carries `driver`;
     - refuse on the no-state branch, or with the API port;
     - refuse a runtime without `startReaderDriver`;
     - close order: driver stop, API close, reader close;
     - on a start failure, close the reader and refuse.
3. **KVM-area staged edits (`provider.mjs`):** the binding includes `driver` only when present (default unchanged), and S1 refuses `driver` on unsigned state.
4. **Tests:**
   - policy and transport;
   - an integration with the REAL fixture provider plus a loopback witness producer fixture (finalized + provisional runs, journal floor from finalized runs only, the A2 marker stopping provisional, the strict 120 s, a stale S refused);
   - shutdown and abort; producer outage; startup refusals.
   - **Then:** the harness and freeze.

---

## FINAL (source frozen, NOT run, NOT production-ready)
**Status:** frozen and not run; none of this makes the writer production-ready.
- **Stage:** `writer-integrated-stage/r1/`, `SHA256SUMS` sha256 **`47498c7c8bcf43a3b08435b342f3007bf91fee84a6d73faa70293515cceeea31`**.
- **Patch:** `patches/writer-integrated-r1-vs-cold-recovery-r2-plus-driver-r1.patch` (`486e658c…`) on the composed base `177184a6` (cold-recovery r2 `e903c224` + driver r1's two files) gives **`f473e41dfffa13a943a94caf2ee0a92786374e12`**.
  - Re-applying all six frozen and new patches to a fresh r9 archive reproduces every tree.
- **Other contents:** `jobs/root-writer-integrated-r1.sh` (slice | check; verifies the r9, r1, r2, r3, cold-recovery r2 and driver r1 stages, composes and asserts all six trees), `PROVENANCE.md` and the driver report as input.
- **Expected `slice` total: 192** (integration 8, driver 10, plus cold-recovery's 174).
- **Not done by me:** tests, builds, `node`, network, VM, live actions or commits.

### Finished source
**`relay/derived-reader-driver-wiring.mjs` (new; only inside the separate reader runtime bundle):**
- **`driverPolicy`:** the exact signed `driver` section = {format, schedule (the driver's own strict config), witness {url, timeoutMs, maxBytes ≤ 128 MiB}, targets {timeoutMs}, rollupConfigTemplateFile (absolute canonical)}.
- **`createWitnessTransport`:**
  - **loopback only** (`http://127.0.0.1|[::1]:<port>/…`);
  - POSTs `{format, track, trusted, agreedL2BlockNumber, maximumWitnessBytes}`, **never the ticket**;
  - requires 200 + `application/octet-stream`;
  - byte cap = min(ticket cap, policy cap), on the declared length and while streaming;
  - timeout, caller abort, no redirects, an empty answer refused.
  - The bytes are only native input.
- **`ownNodeTargets`:** numbers only from the own Base node's `finalized`/`safe` blocks (untrusted hints; a failure gives null).
- **`journalEvidence`:** the role-committed anchor journal's provisional section plus its committed file size. A missing API or unreadable journal throws, which the driver treats as full and fenced.
- **`startReaderDriver`:** validates the policy and template (≤ 1 MiB, `l2_chain_id` 8453) **before** starting, and passes **`cold: null`**: the cold-recovery provider's own history scan is not duplicated.

**`relay/derived-reader-runtime.mjs`:** exports `startReaderDriver`, `driverPolicy` and KVM's `boundedRpc`.

**`relay/derived-writer-authority.mjs`:**
- **Start rule:** the driver starts **only** on the enrolled-state branch when the reader config carries `driver`. Its effects:
  - `reader` = `service.reader` (in-process);
  - `journal` = the role-committed lifecycle journal;
  - `journalPath`;
  - `baseRequest` = `boundedRpc(baseUrl, 1 MiB)`.
- **Refusals** (the reader is closed before refusing):
  - an unsigned (no-state) config carrying `driver`;
  - `driver` together with `ENCLAVE_DERIVED_READER_API_PORT` (two schedulers would race for the one-shot tickets);
  - a runtime without `startReaderDriver`/`boundedRpc`;
  - any driver start failure.
- **Shutdown order:** driver `stop()` (aborts and awaits its owned step; the provider ends the native run), then the API, then the reader.
- **`driver()`** exposes the driver's status.
- **Unchanged:** the writer gates, the 120 s on S, finalized claims and floors, A2 evidence and admin controls.

**`network/derived-reader/provider.mjs` (KVM area, staged):** the `driver` section enters the signed binding only when present (default binding unchanged), and `startDerivedReader` refuses it on any self-initialized or uncommitted state.

### Tests (written, not run): `test/derived-reader-driver-integration.test.mjs`, 8 tests
1. **The policy:** exact keys; loopback-only witness URL; strict schedule; canonical template path.
2. **The witness transport against a real loopback server:** the exact request body without a ticket; the effective cap; 503, wrong type, declared or streamed oversize, empty, redirect, timeout and abort all refused.
3. **The REAL provider + the REAL driver + a loopback producer fixture:**
   - finality first (it bootstraps the ASR root);
   - the journal floor moves only from finalized runs;
   - S comes from the provisional track only;
   - **strict 120 s:** the same S at 121 s is refused by the provider and the driver reports `cannotMeet120s`;
   - **the A2 durable marker** stops provisional, with no producer call.
4. **Own-node hints:** numbers only; failures give null.
5. **Shutdown:** `stop()` during an in-flight (gated) native run aborts it through the provider; nothing merges.
6. **Producer outage:** a bounded failure and backoff, no floor; a missing or non-Base template is refused.
7. **Relay startup:**
   - enrolled + signed section: started with the right effects;
   - close order: driver, then reader;
   - default (no section): never started;
   - with the API port: refused;
   - an old runtime: refused;
   - a refused start: reader closed, then refused;
   - unsigned branch: refused.
8. **KVM staging:** the binding changes only with the section; an unsigned state refuses.

### Concrete gaps (activation requirements; nothing enabled)
1. **The witness producer does not exist in this tree.** The README says it "runs separately on its private backend"; only the push API exists.
   - The integration supplies a real, bounded **loopback pull adapter** with an exact request schema.
   - **Missing:** the producer process (preimage/blob collection from the own L1/L2 nodes for each `trusted` input), its packaging in the measured image, and its resource bounds.
   - **Until then,** every driver run fails at the witness step with bounded backoff; there is no fake path.
2. **No measured template ships the sections:** a Base rollup-config template file pinned by `metal/derived-reader-image.json`, and a reader template carrying the `driver` (and `history`/`provisional`) sections. Enabling also needs a signed binding rotation and root/KVM approval.
3. **KVM review** of the staged `provider.mjs` edits and of the cold-recovery files. The driver's bootstrap detection depends on the provider error text "candidate range exceeds reader bounds".
4. **The runtime bundle** must be rebuilt in root's `check` (new exports); the platform-api guest bundle changes with `derived-writer-authority.mjs`. I made no bundle or build claim.
5. **Unmeasured:**
   - native, witness, scan and Helios times;
   - S age (M1–M5): **S may be unable to meet 120 s**, and the driver then reports `cannotMeet120s`;
   - evidence capacity in use;
   - own-node support for receipts and raw transactions;
   - the new node bootstrap is not running, so there is no performance claim.
