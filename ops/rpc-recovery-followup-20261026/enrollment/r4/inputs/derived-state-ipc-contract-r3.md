# Derived-reader durable state: role ACK of KVM r3 (rotate/recover) + alignment to frozen KVM r2

**Status:** EARLY ACK by Claude (role side) for root to forward. It applies to `accepted-image-enrollment-stage/r3` (in preparation).
- **Frozen inputs:** role r2 (SUMS `5ffc76a5…`, tree `d9a70025`); KVM r2 (`journal-durability-r2`, SUMS `145d49c1…`, 46 files at the stage root).
- **Read:** KVM `journal-durability-r3/ROTATE-RECOVER-CONTRACT.md` and `API.md`, and `logs/image-enrollment-root-note.txt` through the 15:25 update plus the r3 message.
- **KVM modules are not edited.**

## 0. Corrections to my r2 (stated plainly)
- **B2 was stale.** KVM r2 implements the approved exact same-genesis committed-prefix resume:
  - allowed prefixes: none / pending reader / pending reader + empty bridge / final reader + empty bridge;
  - deterministic bytes; `priorFiles` must equal the local bytes.
  
  My r2 "B2 pending" text and its "only when a file is missing" enroll condition are wrong. r3 calls enrollment for **missing file OR reader `enrollment.phase === "pending"` OR reader binding/enrollment digest ≠ the descriptor's**.
- **The B4 rotate rule was wrong.** r2 bound `rotate` to the bridge floor only, but the reader floor may be AHEAD of the bridge. r3 uses the dominating coherent floor of BOTH (§3).
- **The r2 seed deleted the whole `journalDir`.** That unlinked KVM's `derived-state.lock`, which must never be unlinked. r3 removes only working files (`derived-state.json`, `.enrollment-inflight`, `*.strict.tmp`, the anchor journal and its `.strict.tmp`). It keeps every `*.lock` and waits for the previous child's exit before seeding.
- **r2 declared the API in a role-local proposed patch.** r3 re-exports KVM's own `DERIVED_STATE_API` from `network/derived-reader/provider.mjs` (no local constant), together with `enrollDerivedState`, `derivedReaderBinding` and `derivedEnrollmentFloorDigest`.

## 1. ACK: `enrollDerivedState(config, {anchorJournal, verifyEnrollment, commit, enrollmentFloor, commitTimeoutMs, signal})`
**Adapter (`relay/derived-writer-authority.mjs`):**
- **`enrollmentFloor`:** `descriptor.enrollment.highWater` for `recover`; otherwise **not passed** (the r2 runtime has no such option). KVM treats it as an untrusted proposal; authority comes only from the provider answer.
- **Config:** split `journalDir` / `coverageDir` / `runsDir`, legacy `stateDir` DELETED.
  - **`coverageDir` = `<stateDir>/coverage/<binding>`**, where `binding` is the signed one (KVM's binding does not include cache paths, checked in `provider.mjs` `readerConfiguration`).
  - **`runsDir` = `<stateDir>/runs`**, shared across bindings (KVM holds its exclusive lock).
- **`commit`:** maps exactly `journalDir/derived-state.json` → `reader/derived-state.json` and the configured anchor journal → `bridge/anchor-journal.json`. Anything else, a symlink, or a non-canonical parent is refused before IPC.
- **`commitTimeoutMs`:** 10000 (KVM's ceiling is 30000).

**Provider answer** (role, over private IPC `derived-enroll-verify`, under the role lock, from a FRESH same-epoch majority scan):
```
{ format: "enclave-derived-enrollment-result/v1", digest, mode, binding, floorDigest, highWater, priorFiles,
  previousBinding, previousEnrollmentDigest, stateDigest, committed: true }
```

| field | source (all from the authenticated, committed package/record, never host JSON) |
|---|---|
| `digest` | sha256(canonicalJson(signed package)) of the committed enrollment |
| `binding`, `floorDigest`, `highWater`, `mode` | the signed package; `binding`/`floorDigest` must equal KVM's request exactly |
| `previousBinding` | the `binding` of the previously committed (verified) package, recorded in the new committed record at acceptance; `null` for genesis |
| `previousEnrollmentDigest` | the signed package's `previousDigest` |
| `stateDigest` | the signed package's `stateDigest`: the original committed two-file manifest digest at acceptance |
| `priorFiles` | the FRESH committed-majority manifest now (`{rel: sha256}`, at most the two names), which may differ after a partial rebind |

**Role answer rule:** `ok` only for the child's own enrollment, still committed and verified, passing the gate. A `genesis` answer is not limited to "no files" any more: KVM r2 decides the exact prefix from `priorFiles`.

## 2. ACK: startup / adapter decisions
- **Enroll:** a reader or bridge file is missing, OR reader `enrollment.phase === "pending"`, OR reader `binding` ≠ the signed binding, OR reader `enrollment.digest` ≠ the descriptor digest.
- **Normal start:** a complete matching enrollment, including advanced floors and entries. Never reset, never re-enrolled.
- **Normal start options:** `startDerivedLifecycleReader(config,{verifier,journal,journalCommit,requireJournalCommit:true,commitTimeoutMs})` and `openLifecycleJournal(anchor,{requireExisting:true,commit,requireCommit:true,commitTimeoutMs})`.
- **The crash guard no longer deadlocks the same enrollment.**
  - **When it disables:** it records `{digest, committed stateDigest}` with a backoff (60 s doubling to 1 h).
  - **When it allows a retry:** if the committed state changed (progress: a previously unknown ACK appeared), or the backoff has passed.
  - **What clears it:** a new enrollment.
  - **Effect:** an exact same-genesis partial resumes; a no-progress loop stays bounded.

## 3. Floors (role-side guards; KVM enforces the same at runtime)
**Dominance (`anchorDominates(a, b)`):** for each chain separately, `a.number ≥ b.number`. On an **equal number**, these must be identical:
- `hash`, `stateRoot` and `timestamp`;
- for Base also `outputRoot`, and `messagePasserStorageRoot` where either side has it.

Anything else is not dominance. Two anchors are incomparable if neither dominates the other.

- **`rotate`:**
  - **Target:** exactly the dominating EXISTING floor of {committed reader `floor`, committed bridge `authorityAnchors[8453]`}. It is `null` only if both are `null`.
  - **Refused** if incomparable or contradictory (`floor_incomparable`). Never synthesized.
  - **Signed `floorDigest`:** must equal `sha256(canonicalJson(target))` (`wrong_floor`).
- **`recover`:**
  - **`highWater` is mandatory and non-null for EVERY recover**, including a missing or partial restored state. It must validate as a full anchor (Base `messagePasserStorageRoot` required) and dominate every surviving floor (`high_water_below_restored`).
  - **Target and `floorDigest`:** the high-water's.
  - **Never genesis**, and never derived from the archive.
- **Status** shows `readerFloor`, `bridgeFloor` and the computed `dominatingFloor` (or the refusal), so an admin signs the right digest.

## 4. Replica facts (verified in source) and the fix taken
- **`ReplicaNode.commit({ heartbeat = false } = {})`** exists in production `relay/state-replica.mjs`. `heartbeat:true` always runs a majority round and sets `index = scan`, only on a bound, majority-acked head.
- **The defect (shared, pre-existing):** the snapshot catch-up inside `_commitOnce` read `readAll(dir, scan)` AFTER the append await. It could ship bytes newer than the scanned hash under an older head.
- **Why the lock is not enough:** the role lock covers derived writers only; the HTTP barrier, heartbeats and the credentials writer also call `commit()`.
- **r3 fix (role-owned module):** `readAllExact(dir, scan)`. A snapshot is sent only if every file still has exactly the scanned sha; otherwise that member's answer is not counted (`changed`). The election snapshot path reads synchronously after its scan and is unchanged.
- **Durability claims:** crash-fault replication over the configured members only. **No quorum, distinct-host or SNP-persistence claim**; co-located members are separate votes.

## 5. Blockers and decisions for root (early)
1. **A never-enrolled group restored from an archive** (marker written because `derivedReader` is bound) now needs a non-null signed high-water. Such a group has none, so it cannot re-enroll.
   - **Options:** (a) keep this strict rule; or (b) write the marker only when the archive contains `derived-authority/` files. Option (b) re-opens "archive predates enablement" as a regression path.
   - **I implement (a)** pending root's decision.
2. **KVM r3 runtime is not frozen.**
   - The r3 role stage composes **KVM r2** (genesis + prefix resume) for actual composition tests.
   - Rotate and recover: role rules plus provider fields are implemented, but are **not qualified** until KVM r3 is frozen and run through the harness's KVM-closure mode.
3. **Stand-in limits:** the real reader start (`startDerivedLifecycleReader`) needs live L1 and Helios. The composition tests drive REAL KVM `enrollDerivedState` + `openLifecycleJournal` through the REAL role, IPC and `ReplicaNode`, then stop before reader start. That is stated in the tests and the verdict.
