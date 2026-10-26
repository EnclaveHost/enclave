# Accepted-image derived reader: the remaining STATE enrollment/recovery path (read-only audit, 2026-10-26)

**Scope:**
- Read-only: no edits, tests, builds, network, queue, live changes or commits.
- Endpoint r3 belongs to root and Claude50. I only read it; it fixes the endpoint test so it forges on a `structuredClone` of the frozen config.
- **Tree read:** a scratch extraction in `/tmp` of base `64156dcd`, plus final-consumer r4, plus accepted-image r1, plus r2. This is the r2 composed content.
- **KVM originals:** the derived-reader sources in `enclave-deployment-lifecycle` (HEAD `b7dcf5af9`) are identical to the composed `network/derived-reader/`, `deployment-lifecycle-journal.mjs`, `lifecycle-finality-bridge.mjs`, `runtime-lock.mjs` and `lease-release-journal.mjs`.

## 1. Where it stands today (exact)
**There are two rollback floors, and both live in guest RAM:**

| floor | file | owner | properties |
|---|---|---|---|
| (a) reader | `stateDir/derived-state.json` (`network/derived-reader/journal.mjs:21-62`) | KVM | hash-chained, at most 128 entries, flock-locked, bound to `binding` = sha of chain, native, runtime, L1, **checkpoint digest**, A1 policy, … (`provider.mjs:167-170`); with it, `stateDir/coverage/` (manifest + chunks, ≤ 4 GiB, no eviction) |
| (b) bridge | `ENCLAVE_DERIVED_ANCHOR_JOURNAL` (`deployment-lifecycle-journal.mjs:57`, `authorityAnchors[chainId]`) | — | written by `lifecycle-finality-bridge.mjs:58` before publishing; checked against at `:41-44`; no lock and no chain |

- `stateDir` = `/run/measured-control/platform-api/derived-reader-v3`; the journal is placed beside it (role `:119`, image `roleEnv`).
- **Neither is in the replicated `data/` directory.**

**The agreed root is never loaded from state.** Every start authenticates a fresh ASR anchor: Helios-verified L1 `finalized` from the pinned checkpoint, then the AnchorStateRegistry game, then the Base header against the output root (`provider.mjs:74-78`, `proof.mjs:12-29`).
- The floors only force the reader to derive exactly through the last served position before it publishes again (`provider.mjs:82`, status `recovering`), and to refuse a regression or contradiction (`journal.mjs:54-55`).
- No RPC tag is ever authority, and nothing below changes that.

**`initializeState:false`** is required by the role (`platform-api-role.mjs:116-118`). With no state, `journal.mjs:28` and `coverage-store.mjs:62` throw "explicit enrollment/recovery required".

**BLOCKER found:**
- **Today's sequence:**
  1. The role's try/catch covers only `composeDerivedReader` (`role:222-224`).
  2. The relay then runs `derivedWriterAuthorityFromEnv` → `startDerivedLifecycleReader`.
  3. That throws, and `api-relay.js:2539` calls `process.exit(1)`.
  4. The role restarts the child with backoff (`role:239-240`).
- **Result:** with `platformApi.derivedReader` bound, every boot and every failover (state is always absent in RAM) puts the **whole platform-API relay into a crash loop**, not "relay starts, writer authority unproven".
- **r2's statement is only partly true:** it holds only when composition fails. The r2 endpoint tests never start the reader, so they do not show this.
- **Until the gate below exists,** `derivedReader` must stay unbound in production.

**Even with state solved, writer authority stays unproven.** `relay/derived-writer-authority.mjs:13-17,30,223-224` sets a 120 s freshness ceiling against L1-finalized anchors (≈ 13 min or more), which gives `stale_snapshot`.
- So "the derived reader runs" ≠ "writes are authorised". The recent-state / native branch is still open.
- State enrollment is necessary but not sufficient. Do not claim more.

**Checkpoint expiry:** checkpoint `2e8502e6…` is refused after **2026-11-01 19:21:59 UTC** (`l1-runtime.mjs:27-28`), including by a reader that is already running.
- Its digest is in `binding`, so rotating it invalidates (a) and the coverage store.
- Rotation is therefore a migration state, not a restart.

## 2. Existing production interfaces that can carry it (no new framework)
**Replica, `relay/state-replica.mjs` `ReplicaNode`:**
- **What it is:** primary/backup replication of the whole `data/` directory (`/run/measured-control/platform-api/data` = the relay's cwd/`AUTH_DATA_DIR`).
- **Sealing:** AES-256-GCM under the group key K, with AAD bound to the group.
- **Commits:** majority-acked and bound to the exact `(epoch, seq)` head.
- **Rollback and replay:** monotonic heads, with replay protection by nonce and freshness.
- **The relay barrier:** every relay response waits for `node.commit()` (role `:534-567`). A file the relay writes is therefore on a majority before any answer that depends on it leaves.
- **On quorum loss:** the primary steps down and the relay is killed (`role:275`).
- `.tmp` files are skipped, so `strictWriteFile`'s `.strict.tmp` is never replicated half-written.
- **Size:** about 48 MiB effective. That fits floor (b), which is a few KiB, but **not** the coverage cache.

**Confidentiality:**
- Plaintext exists only in member guests' RAM.
- Host, peers on the wire and archive sinks see only ciphertext; the existing test checks that even file names are hidden.
- K comes from admin genesis (HPKE to the boot handoff key). It is escrowed only to the `platformApi.recovery` X25519 keys (`recoveryEnvelope` / `openRecovery`).

**Admin authority:**
- `packageMessage` / `packageSigner` (`role:147-157`): EIP-191, any one of `platformApi.admins`, bound to group and kind.
- The credentials endpoint (`role:360-373`) is the exact template: primary only, signer check, strictly newer `at`, write, then `node.commit()`.

**Honest limits** (which the proposal must not paper over):
- **Crash-fault only.** Any K holder can forge any member index.
- **Same-host members are counted.** `measured-control.mjs:420-430` only rejects repeated `operator`, `publicUrl` or `controlUrl`, so co-located members count as separate votes. The floor's durability is that of a majority of member guests' RAM, which is **one host's** if they are co-located. **No quorum claim is made for co-located replicas.**
- **A timed-out write may reappear** after the client saw a failure.
- **Whole-group loss:** recovery uses `latest` from an archive chosen by an admin, with no newest-archive check. It can regress up to `archiveMs` (or more, if an older archive is supplied).
- **No reboot-persistent counter.** SNP-sealed disks are not implemented (`docs/…hosted-platform-api.md:145-147`).

**Not usable here:**
- `relay/custody-state.mjs` and `createCustodyGate` (chain-read secret-release gates, in-memory);
- the `custody/` threshold system;
- `network/lease-release-journal.mjs`, except its `strictWriteFile`, which is already used.

## 3. Minimal concrete integration
**Principle:** the replicated, sealed `data/` directory holds the small monotonic floor plus an admin-signed enrollment. The reader's own state and coverage stay RAM-only and rebuildable, and are re-seeded from the replicated floor at each start. The reader never initialises itself (`initializeState:false` is unchanged).

1. **Move floor (b) into the replica (image/role; re-measure).**
   - `ENCLAVE_DERIVED_ANCHOR_JOURNAL` → `/run/measured-control/platform-api/data/derived-authority/anchor-journal.json`.
   - Change role `:119` and `metal/derived-reader-image.json` `roleEnv`.
   - The path is already separable and is an absolute-file env. The bridge's persist-before-publish plus the relay barrier means it is committed to a majority before any dependent response.
   - Add an `fsync`-safe parent directory, created 0700 by the role.

2. **An enrollment record in the replica (role: new endpoint modelled on `credentials`).**
   - **Endpoint:** `POST /platform-api/derived-enroll` taking an admin package `kind:"derived-enroll"`:
     ```
     {format, groupId, kind, at, chainId: 8453, readerPins: sha256(canonicalJson({template, checkpoint, native, helios} sha256s from DERIVED-READER-IMAGE.json)),
      mode: "genesis" | "rotate" | "reset", previousDigest: <sha of the held enrollment> | null,
      floor: null | <the anchor it carries forward>, targetStatementSha256: <this boot>}
     ```
   - **Accepted only:**
     - by the primary;
     - with `packageSigner` ∈ admins, the right group and kind;
     - `at` > held, and `previousDigest` = the digest of the held record (a chain, like the host policy's `previousDigest`, so no fork or replay).
   - **Per mode:**
     - **`genesis`:** only if neither an enrollment nor an anchor-journal floor exists, with `floor: null`.
     - **`rotate`:** `floor` must equal the replicated floor (b) exactly.
     - **`reset`:** names the contradicting floor's digest. Admin break-glass only; see §5.
   - It is written to `data/derived-authority/enrollment.json`, then `commit()`.
   - **It contains no secret.** It is public data, sealed only because the whole directory is.

3. **Role gate (the fix for the blocker; no relay change for the unenrolled case).**
   - `composeDerivedReader` returns `{}`, logging `derived_reader_unenrolled`, unless all of these hold:
     - `enrollment.json` verifies against `cfg.platformApi.admins` and `groupId`;
     - its `readerPins` equal the current image record's;
     - the floor rule holds: a `genesis` record with no replicated floor, or any record with a valid floor (b).
   - **Otherwise** the relay starts exactly as with derived reader unbound: `writer_authority_unproven`, no crash loop, no state created.
   - **Binding change** (checkpoint rotation or new native) means a `readerPins` mismatch, which leaves the reader unenrolled until an admin `rotate`.
   - **Otherwise** the role adds `enrollment: {digest, floorDigest}` to the composed RAM config. This is the only addition to the template; the endpoints stay bound and `initializeState` stays false.

4. **A KVM-owned seed (one small export; KVM writes it, it is not composed here).**
   - **Function:** `enrollDerivedState(config, {floor})` in `provider.mjs`, re-exported by `relay/derived-reader-runtime.mjs`.
   - **What it does:**
     - computes the SAME `binding`;
     - only if BOTH `derived-state.json` and `coverage/manifest.json` are absent (and there are no orphan chunks), writes `{format, binding, floor, entries: []}` and an empty coverage manifest;
     - requires `config.enrollment.floorDigest` = sha256 of `floor` (or of null), and `validateAnchor(floor)` with tier `l1-finalized-derived` when non-null;
     - refuses existing state.
   - **Why it stays fail-closed:** the journal format already accepts a floor with no entries (`journal.mjs:33-44`), and `savedFloor()` then forces "derive exactly through the floor" (`provider.mjs:40-44,82`). Coverage starts empty, so a claim older than the new coverage stays `claim_not_covered`.
   - **Relay change:** `derivedWriterAuthorityFromEnv` calls `runtime.enrollDerivedState(config, { floor: journal.readAnchor(8453) ?? null })` before `startDerivedLifecycleReader`. With no `config.enrollment`, or a mismatch, it throws, as it does today, but the role gate (step 3) means the relay is never given an unenrolled config.

5. **No change** to `initializeState`, to Helios or ASR bootstrap authority, to the 120 s ceiling, to endpoints, credentials, or the custody gates.

## 4. Configuration fields
**Public, HOST_DATA-bound (existing; nothing new):**
- `platformApi.{members (3–7), admins (1–5), recovery (1–5 X25519 pubs), archives (0–8), archiveMs, leaseMs, derivedReader{format, l1ConsensusUrl, l1ExecutionUrl, baseUrl}}`;
- `relayEnv.ENCLAVE_CHAIN_AUTHORITY=verifier`.

**Image-pinned (public):**
- `derived-reader-image.json` (`config`/`checkpoint`/`native` sha256s);
- `roleEnv`, whose journal path changes (step 1);
- `private.stateDir`, unchanged.

**Private (guest RAM only, never in config or image):**
- K and `dirs.root/k`, plus the replicated `data/derived-authority/{enrollment.json, anchor-journal.json}`;
- `derived-state.json` and `coverage/` (RAM, per member, rebuildable).

No new secret is introduced, nothing is passed through from the host, and no plaintext goes to the host or to sinks.

## 5. Migration states
| state | trigger | admin signature | result |
|---|---|---|---|
| U unenrolled | no `enrollment.json` (today: every deployment) | — | relay up, writer authority unproven, nothing written |
| G genesis | first enablement of a group | **yes** (`genesis`, `floor null`) | the first start seeds `floor:null`; reader derives from a fresh ASR anchor; bridge floor (b) is created on the first accepted anchor |
| R restart / failover | process restart, member reboot, primary change | no | the role verifies the record; the relay seeds `floor` = replicated (b); `recovering` until the floor is re-derived; never publishes below it |
| C rotation | checkpoint (**before 2026-11-01**), native or template change, i.e. new `readerPins` | **yes** (`rotate`, `previousDigest`, `floor` = current (b)) | U until signed; then like R under the new binding. The floor carries over: chain positions are binding-independent, and carrying it is conservative |
| L whole-group loss | no member holds `data/` | **yes** (existing `recover` package + `openRecovery`) | state, including the floor, comes back from the chosen archive. **Possible regression ≤ that archive's age** (accepted and stated; there is no newest-archive proof). Then R |
| X contradiction / stuck | reader refuses (`derived authority rollback or contradiction`) or cannot re-derive the floor | **yes** (`reset`, naming the floor digest) | break-glass; logged; never automatic |

## 6. Tests to add (offline, existing harnesses: `platform-api-replica`, `platform-api-hosted`, `derived-reader-endpoints`, and a KVM fixture runtime)
1. **Unenrolled (blocker regression):**
   - Setup: derived reader bound, no enrollment.
   - Expect: relay serves, `writer_authority_unproven`; no `process.exit` loop (child-restart counter stays 0); no state files.
   - Today's tree must FAIL this.
2. **Genesis:**
   - A valid signed `genesis` seeds `floor:null`.
   - Refused: a non-admin; the wrong group, kind or boot; `at` not newer; a wrong `previousDigest`; `genesis` when a floor (b) exists (replay after operation); mismatched `readerPins`.
3. **Restart:**
   - The fixture accepts anchor F, which is persisted in `data/` and committed; then the relay is killed.
   - On restart the seeded floor = F, and the reader is `recovering`.
   - Refused: publishing below F, and a same-height different hash.
   - Existing local state blocks a re-seed.
4. **Failover/replay** (three members, partitionable transport):
   - Primary A accepts F and commits; A is partitioned; B is elected; B's relay seeds F.
   - A's stale writes and replayed packages or answers are refused.
5. **Uncertain write:**
   - Commit times out after one follower applied F′ > F.
   - Expect: the client response is never released (socket destroyed). The successor may adopt F′, which is higher, authenticated and safe; a released floor never regresses. A failed directory fsync (`committed:true`) fences the journal.
6. **Quorum loss:**
   - 2 of 3 down: step down, relay killed, no derived answer.
   - When quorum returns, it is seeded from the replicated floor.
7. **Rollback:**
   - A forged older `anchor-journal.json` or an older archive is either refused (lower than the reader's re-derived floor or contradicting it), or for L documented as a regression bounded by the archive head.
   - A missing `anchor-journal.json` with a non-genesis enrollment is refused.
8. **Rotation:**
   - Changed checkpoint, native or template pins: unenrolled, no crash.
   - A `rotate` with the current floor seeds it under the new binding.
   - A `rotate` with a lower or contradicting floor is refused.
9. **No plaintext:** the archive sink and host see only ciphertext for `derived-authority/*`. The composed config, logs and status carry no K and no state.
10. **No tag authority:** a fixture RPC advertising a higher `finalized` or `latest` never moves the floor. Only an accepted derived anchor moves it.
11. **Co-located members:** status and docs report the floor as crash-fault durable over the configured members, with distinct hosts NOT proven. No test or doc asserts quorum durability for co-located replicas.

## 7. Ownership / next
- **KVM:** `enrollDerivedState` (step 4).
- **Root, Claude50 or an image stage:**
  - steps 1–3 and the role/relay calls;
  - re-measuring the image (`roleEnv` changes);
  - the new checkpoint before 2026-11-01.
- **Root decisions:**
  - accept regression state L;
  - whether to add a distinct-host constraint for members. It does not exist today, and I do not claim it.
- **Not addressed here:** writer authority's 120 s ceiling, so writes stay unproven with L1-finalized anchors.
