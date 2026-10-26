# Independent read-only security review: `writer-two-anchor-stage/r1` (2026-10-26 17:55-17:59Z)

## Bytes reviewed
- **Stage:** `SHA256SUMS` sha256 `cdacd616…37ae0b9`; `sha256sum -c` OK.
  - patch `3e399062…`; PROVENANCE `adae2e88…`; job `15005592…`.
- **Report read:** `logs/claude-writer-two-anchor-r1.md`.
- **How I read the code:**
  - the 15 patched files were reconstructed in `/tmp/w2r` from r9 `release.git` commit `296a5833…` (tree `90e4cdaa…`, verified) plus the patch;
  - **every new hash equals PROVENANCE**: `schedule_reader` `694f1297…`, `l1-runtime` `b677a281…`, `proof` `a76b7832…`, `provider` `cf652077…`, `coverage-store` `076f51bf…`, bridge `28fad4ca…`, writer `b5a3a121…`, `lifecycle` `7bd60c3f…`, `api` `d1151102…`.
- **Also read:** r9 `metal/guest/platform-api-role.mjs` and `network/derived-reader/coverage.mjs`.
- **Not done:** no tests, builds, network, live actions or edits.
- **Limits of this review:** the stage's 23 tests use fixture L1 and **echo-native** processes. Nothing here, and nothing in them, shows actual-node feasibility (M1-M5) or native completeness/correctness for attested-L1 ranges.

## Verified in source (what holds)
**Claim finality and the generation:**
- the fact's claim must be ≤ B_f (`claim_not_final`, writer `:342`), and the row at B_f must replay to the **same** claim (`:344-349`);
- a same-runner release + re-claim in (B_f, S] shows as a later Claimed in the complete coverage, so it gives `claim_not_final`;
- the lease16 fact bytes are unchanged; `block.finalized` = B_f.

**Monotonic finalized floors:**
- only B_f is journaled (bridge `:94`);
- the journal, `deployment-lifecycle-journal` and the coverage-store manifest stay finalized-only;
- S is never `agreed`, staged or published (provider `:263`, coverage-store `:140-141`).

**Current-ness at S:**
- the row at S's **derivation-authenticated** hash (the bridge pins the verifier header and stateRoot equal to the native-bound S, `:74-85`, rechecked `:91`);
- logs `[from, S]` read **at S** in the same callback;
- `replayToRow(logs through S, row at S)`;
- the ledger at S equals the ledger at B_f (`:269`);
- the unchanged 120 s expression on `S.time` (`:327`), with a separate `stale_finalized` bound for B_f;
- then the deny-only verifier from S+1 (`:295-316`).

**Coverage completeness (B_f, S]:**
- each provisional segment chains by exact predecessor hash (`submitProvisional` `:258-260`);
- v3 coverage is per-block complete (`coverage.mjs:26-37`);
- the overlay must start at the last persisted `toBlock + 1`, be contiguous, and end at S by number and hash (`coverage-store.mjs:41-52`);
- the store refuses an attested anchor without its overlay (`:140`).

**Tier branding:**
- L1 heads are branded in a module WeakMap (`l1-runtime.mjs:18-21`, `:95`, `:105`);
- `prepareProof(mode:'provisional')` and `bindNativeV3(tier:'l1-attested-derived')` require the attested brand;
- an attested head can never bind the finalized tier (`proof.mjs` `bindNative`);
- the tier is chosen only by provider code.

**Schedule reader, provisional mode:** finalized ≤ anchor ≤ attested and `block(n).hash == anchor`, before and after the read. The default mode is unchanged (`schedule_reader.mjs:161-180`).

**Canonicality, reorgs and contradictions:**
- every provisional L1 head is re-read on every S use (`provisionalCanonical` `:121-131`, called from `currentProvisional` and the overlay `readDerivedLogs` before **and** after the store read);
- an attested regression discards (`:229-231`);
- finalized progress compares **every** overlapping block (hash + outputRoot), fencing on a mismatch (`rebaseProvisional` `:103-118`).

**Default disabled:**
- the binding gains `provisional` only when configured (`readerConfiguration`);
- `lifecycle.mjs` exports `stateSnapshot` only then;
- the relay takes it only from the runtime service;
- env knobs do nothing (`test/derived-writer-two-anchor.test.mjs:169-189`).

**Helios trust is stated honestly** (`l1-runtime.mjs:97-100`): the attested header of the latest verified finality update, signed by more than ½ of the recent maximum sync-committee participation, with **no finality branch**.
- **Canonicality checks rest on the same trust:** they use that same client (cache / EIP-2935 at `latest`), so they are only as strong as the attested head.

## Activation blockers (concrete)
**A1. Provider exclusivity makes S-based authority unavailable during every native run; driver integration depends on it.**
- **The cause:** `submit` and `submitProvisional` run `invokeDerivation` (up to `nativeTimeoutMs`, ≤ 120 s on the provisional track) **inside** `exclusive` (provider `:171-177`, `:246-252`). `readAnchor`, `readStateAnchor` and `readDerivedLogs` then throw `derived provider busy` (`:76-79`), and the writer maps that to `derived_unavailable` (its own test, `test/derived-writer-two-anchor.test.mjs:147`).
- **The effect:** keeping S ≤ 120 s old needs frequent provisional runs, so authority is refused for each run's duration. The duty cycle is unmeasured (M3).
- **Abuse:** any local caller of the loopback `/provisional/prepare` + `/provisional/witness` can hold the lock with valid-but-slow tickets.
- **Minimal fix (KVM provider):** run `invokeDerivation` **outside** `exclusive`, and take the lock only to bind and merge. The existing "chain changed while deriving; ticket void" check (`:258-260`) already covers concurrent change; the same pattern applies to `submit`.
- **Regression test:** `readStateAnchor`, `readAnchor` and `readDerivedLogs` succeed while a `submitProvisional` native run is in flight. The submit then appends, or voids if the chain changed. Ticket replay is still refused.

**A2. A contradiction fence is RAM-only and silent, and nothing records which facts used the contradicted S.**
- **The cause:** `provFence` lives in provider memory (`:94`, `:110-112`). It is cleared by **any** relay or reader restart; the platform-api role restarts the relay child with backoff, so the provisional track silently re-enables.
- **Not surfaced:** it is never logged or alerted at the relay.
- **No audit trail:** the writer returns `evidence.state {number, hash}` to the caller, but nothing records it, so facts already issued from a later-contradicted S cannot be found.
- **Minimal fix:**
  1. on a fence, write a small **disable marker** (not state, never a floor) into the replicated `data/` dir (role-committed). With the marker present, the reader refuses provisional mode **until an admin-signed clear**;
  2. the relay logs the fence once at error level;
  3. the relay appends `{fact, claimBlock, state.number, state.hash, state.l1}` per issued two-anchor fact to a bounded, replicated log.
- **Regression tests:**
  - after a fence plus a restart, `stateSnapshot` is still refused;
  - the fence is logged;
  - every issued fact has its S entry, and the entry for a contradicted S is identifiable.

**A3. Enabling the policy rotates the binding, and the binding keys the coverage store.**
- **The cause:** coverage lives in `coverage/<binding>` (relay `:414`), and adding `provisional` changes the binding (`readerConfiguration`).
- **The effect:** the enrollment rotation that enables Option B starts coverage empty from a new bootstrap. **Every lease whose current claim predates that bootstrap stays `claim_not_covered`** until it is re-claimed. This is fail-closed, but it changes writer availability for all existing deployments.
- **Fix (decision and plan, no code):** enable `provisional` at the **initial** enrollment of a new group, or record and accept the coverage reset. The report and the activation runbook must say so.
- **Regression test:** a binding rotation that adds the policy leaves an existing lease `claim_not_covered`, with no fact, until a fresh claim is covered.

## Should fix (small; defence in depth)
- **S1. Unsigned enabling branch.**
  - **The gap:** without `ENCLAVE_DERIVED_STATE`, the relay starts the reader straight from the private config with no enrollment check (writer `:427-429`). A config carrying `provisional` then yields `stateSnapshot`; the stage's own wiring test does exactly this with `initializeState: true` (`two-anchor.test.mjs:364-379`).
  - **Production impact:** the production role forces `initializeState: false` (role `:118`), so this is not reachable there. It still contradicts "only the signed binding enables".
  - **Fix:** in that branch, refuse `config.provisional !== undefined`.
  - **Test:** no-state + `provisional` refuses at startup.
- **S2. Explicit B_f ↔ S ancestry in the bridge.**
  - **The gap:** the bridge checks only number, time and L1-number order (`:63-64`). Ancestry currently relies on provider internals (`currentProvisional` root == served latest).
  - **Fix:** have `readStateAnchor` return the root's `{number, hash}`, and make the bridge require it to equal the B_f it just read; on a race, refuse and retry.
  - **Test:** a finalized advance between `readAnchor` and `readStateAnchor` refuses (or retries) rather than pairing anchors from two roots.
- **S3. Overlay hash link to persisted coverage.**
  - **The gap:** `checkedOverlay` links the overlay to the last persisted segment by block number only (`:44-49`).
  - **Fix:** also require the first segment's agreed root hash to equal the persisted tail block hash.
  - **Test:** a tail-number-equal but hash-different overlay refuses.

## Does the issuer admit claims that are no longer current?
**Within (B_f, S]: no.** A later Claimed gives `claim_not_final`; a Released, or a row no longer this runner's, gives `lease_not_current`; another runner's claim gives `claim_not_final`/`lease_not_current`.

**Within (S, now]: yes, possibly.** Only the deny-only verifier covers this window, and it is inclusion-only, sequencer tier. A release or re-claim there is caught only if the verifier happens to show it.
- **Bound:** S age ≤ 120 s, the same ceiling as legacy.
- **Typically worse than legacy:** S lags by the Base safe lag (unmeasured, M1), whereas legacy B was head − 2 (seconds).

**After the last canonicality check:** an L1 reorg can remove or add a Released that S reflected. That window is bounded by reorg depth (M5) and detected only on the next use (fence or discard), hence A2.

## Required driver integration (not in the stage; S never exists without it)
1. A loop that schedules finalized `prepare`/`submit` **and** provisional `prepareProvisional`/`submitProvisional`:
   - target = the derivable Base safe head at the attested L1;
   - cadence that keeps S ≤ 120 s;
   - back-pressure on `maxSegments`/`maxOverlayBytes`;
   - finalized targets aligned to provisional segment boundaries, so the suffix survives.
2. Witness production for attested-L1 ranges (external, untrusted; bound by the native result).
3. The A1 lock change, so reads are not starved; loopback API access limited to the driver.
4. Fence handling and alerting (A2).
5. Before enabling:
   - KVM review of the changed `network/` closure;
   - a new measured reader template with the policy;
   - the signed binding rotation, with the A3 plan.

## Not claimed
- Native completeness or correctness for attested ranges.
- Feasibility of S ≤ 120 s (M1-M4).
- Helios `latest` cadence (M2).
- That the fixture tests pass: root is running the slice.

Admin controls and contracts are unchanged by the patch, and nothing here asks to change them.
