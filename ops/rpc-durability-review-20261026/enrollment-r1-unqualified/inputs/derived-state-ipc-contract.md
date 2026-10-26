# Derived-reader durable state: proposed cross-process contract (role ⇄ relay child ⇄ KVM)

**Status:** PROPOSED (Claude, accepted-image-enrollment-stage, 2026-10-26). **Revised after root's note** (`logs/image-enrollment-root-note.txt`, KVM API accepted 14:49 UTC). §6 now maps the role side onto that API, and §3b adds the provider verification over the same channel.
- **Role side:** implemented in that stage; nothing has been run.
- **KVM side:** this document only. **The exact KVM API is pending root's note** (`logs/image-enrollment-root-note.txt`, absent when this was written).
- **Base tree:** r3 source `59e11251`. Root's r3 release is `35d4770a`, tree `3bb4a24f`.

**Why:**
- The HTTP response barrier only covers state written for an HTTP answer. A background reader publishes outside any request, and other consumers read the floor too.
- So every durable derived-state write goes through an explicit, awaited, exact-bytes commit to the replica majority. **No HTTP 200, queued message or local write counts as durable.**

## 1. Where state lives
| what | where | who writes | durability |
|---|---|---|---|
| admin enrollment | `data/derived-authority/enrollment.json` | role (admin package) | replicated + sealed (K), majority-committed before 200 |
| restore marker | `data/derived-authority/recovered.json` | role (admin `recover` bootstrap with archived state) | replicated |
| durable journals | `data/derived-authority/state/<rel>` | **role only**, via the IPC below | replicated; the reply is sent only after the majority commit of a head whose scan holds exactly these bytes |
| RAM working copies | `<stateDir>/journal/…` and `<stateDir>/anchor-journal.json` (seeded by the role at every relay start from the committed copies) | KVM | RAM only; uncommitted local bytes are discarded at the next start |
| coverage cache | `<stateDir>/coverage/` | KVM | RAM only; rebuilt, and grants no authority |
| native run ownership | `<stateDir>/runs/` | KVM | RAM; the role never deletes it (KVM reaps saved children from it) |

**More detail:**
- **`data/`** is `/run/measured-control/platform-api/data`, the relay's cwd and `AUTH_DATA_DIR`, which `relay/state-replica.mjs` replicates.
- **`stateDir`** = `/run/measured-control/platform-api/derived-reader-v3` (image `private.stateDir`, unchanged).
- **`<rel>`** matches `^(reader|bridge)/[a-z0-9][a-z0-9.-]{0,63}\.json$`, at most **1 MiB** per file and **8** files.
- **Proposed mapping:**
  - `reader/derived-state.json` ↔ `<stateDir>/journal/derived-state.json`
  - `bridge/anchor-journal.json` ↔ `<stateDir>/anchor-journal.json`, which is the image `roleEnv` `ENCLAVE_DERIVED_ANCHOR_JOURNAL` (unchanged, no re-pin).
  - Other `reader/*` names map to `<stateDir>/journal/<name>`.

**Trust boundary:** the relay child runs as the same user and could write `data/` directly. Durability is defined by the role's commit reply, never by a file's presence. The child is measured image code; the host never writes either location.

## 2. Role → relay child (environment, set ONLY by the role; refused in bound `relayEnv` and dropped from credentials)
**Variables:**
- `ENCLAVE_WRITER_AUTHORITY_SOURCE=derived`
- `ENCLAVE_DERIVED_READER_CONFIG=<root>/derived-reader/derived-reader-v3.json`: the composed config. Unchanged from r2: the template plus the bound endpoints.
- `ENCLAVE_DERIVED_ANCHOR_JOURNAL=<stateDir>/anchor-journal.json`: unchanged.
- **NEW `ENCLAVE_DERIVED_STATE=<root>/derived-reader/state.json`**: the descriptor below, file mode 0600.
- **NEW `ENCLAVE_DERIVED_COMMIT_BOOT=<32 hex>`**: fresh per child spawn. It is correlation, not a secret.

**They are set only when ALL of these hold:**
- `platformApi.derivedReader` is bound;
- the image record and template verify (r2 `composeDerivedReader`);
- `data/derived-authority/enrollment.json` verifies:
  - admin signature, group, kind;
  - its chain from genesis;
  - `readerPins` = sha256 of this image's `/opt/enclave/DERIVED-READER-IMAGE.json` bytes;
  - when the restore marker exists, a `recover` enrollment made after it;
- derived mode is not disabled by a failed start (§5).

**Otherwise:** none of them is set. The relay starts with writer authority **unproven**: there is no crash loop and no state is created.

**Descriptor `enclave-derived-state/v1`:**
```json
{ "format": "enclave-derived-state/v1",
  "enrollment": { "digest": "<sha256 hex of enrollment.json>", "mode": "genesis|rotate|recover", "at": 1730000000000,
                  "readerPins": "<sha256>", "previousReaderPins": "<sha256>|null", "highWater": null },
  "journalDir": "<stateDir>/journal", "coverageDir": "<stateDir>/coverage", "runsDir": "<stateDir>/runs",
  "files": [ { "rel": "bridge/anchor-journal.json", "path": "<stateDir>/anchor-journal.json", "sha256": "<hex>" },
             { "rel": "reader/derived-state.json",  "path": "<stateDir>/journal/derived-state.json", "sha256": "<hex>" } ],
  "commit": { "protocol": "enclave-derived-commit/v1", "boot": "<same as ENCLAVE_DERIVED_COMMIT_BOOT>" } }
```

**Field notes:**
- **`files`:** exactly the committed copies, seeded into RAM by the role (0600, directories 0700). It is empty only for a `genesis` enrollment whose group never committed a file.
- **`highWater`:** only for `recover`. It is the admin-retained anchor (§4) and is never taken from the host or an archive.

## 3. Relay child → role: `enclave-derived-commit/v1` over Node's private child IPC channel
The channel is the `ipc` stdio of `spawn`, a socketpair inherited only by this child.

**Request:**
```json
{ "t": "derived-commit", "v": 1, "boot": "<ENCLAVE_DERIVED_COMMIT_BOOT>", "id": 7, "file": "bridge/anchor-journal.json",
  "bytes": "<base64 of the EXACT file bytes>", "sha256": "<hex of those bytes>" }
```

**Success reply** (sent only after the steps below):
```json
{ "t": "derived-commit", "v": 1, "boot": "<same>", "id": 7, "sha256": "<same>", "ok": true, "head": { "epoch": 4, "seq": 19 } }
```

**Refusal or failure:**
```json
{ "t": "derived-commit", "v": 1, "boot": "<same>", "id": 7, "ok": false, "error": "<code>" }
```

**Role (parent) rules, in order:**
1. **Refuse** with `bad_request` when:
   - `boot` is not this child's;
   - `id` is not a safe integer strictly greater than the last one;
   - `file` is outside the `<rel>` grammar, or the 1 MiB / 8-file bounds are exceeded;
   - the base64 does not decode to bytes whose sha256 equals `sha256`.
2. **Refuse other states:**
   - another request in flight → `busy` (the client serializes, so this never happens in normal operation);
   - no verified enrollment / derived mode disabled → `not_enrolled`;
   - not the primary or lease invalid → `not_primary`.
3. **Commit:**
   1. Record `epoch = node.promised`.
   2. Write `data/derived-authority/state/<rel>` atomically (`.tmp` + rename; the replica never ships `.tmp`).
   3. `ok = await node.commit()`.
4. **Reply `ok: true` only if all of these hold:**
   - `ok === true`;
   - this member is still the primary of the **same** `epoch`;
   - the committed scan `node.index` holds `<rel>` with **exactly** `sha256`;
   - the file still reads back to those bytes.
   
   The `head` returned is `node.head`. Otherwise the reply is `ok: false` with `not_committed`, `epoch_changed`, `not_primary` or `bytes_changed`.
5. **Never** a partial or optimistic reply. If `node.commit()` returns false, the member has stepped down, and the existing `onFollower` path kills the relay child.

**Client rules** (`relay/derived-state-commit.mjs` `createDerivedCommitter`):
- **API:** `commit({ file, bytes, sha256 }) → Promise<true>`. **This is the hook the KVM APIs receive.**
- **Serialized:** one request at a time.
- **Each request:**
  - a fresh id;
  - a deadline (default 10 s; the parent's own replica asks time out at `leaseMs/3`).
- **Resolves `true` only** for a reply with the same `boot`, `id` and `sha256`, `ok: true`, and a well-formed `head`.
- **FENCES the committer permanently** on anything else: a timeout, `ok:false`, a mismatched echo, the channel closing, or a send failure. Every later `commit` rejects with `derived_commit_fenced`.
- **A late or unknown reply** (for example after a timeout) is ignored and counted. It can never resolve anything.
- **A relay restart** gives a new process with a new `boot` and an empty id space. Replies for the old boot cannot reach it, because the channel is per child.

## 3b. Relay child → role: the enrollment verification KVM's `enrollDerivedState` needs (same channel, same id space, same fencing)
**Request:**
```json
{ "t": "derived-enroll-verify", "v": 1, "boot": "<boot>", "id": 1, "binding": "<KVM-computed reader binding>", "floorDigest": "<sha256 of canonicalJson(floor)>" }
```
**Reply (`ok: true`):**
```json
{ "t": "derived-enroll-verify", "v": 1, "boot": "<boot>", "id": 1, "ok": true,
  "result": { "format": "enclave-derived-enrollment-result/v1", "groupId", "digest", "mode", "at", "readerPins", "binding", "floorDigest",
              "highWater", "previousReaderPins", "priorFiles": { "<rel>": "<sha256>" } } }
```
**`ok: true` only if all of these hold:**
- the child was started with this enrollment, which is still the held one;
- its admin signature verified;
- it passes the gate (pins and restore marker);
- `binding` and `floorDigest` equal the **signed** package's;
- for a `genesis`, no durable file exists yet (`prior_state` otherwise).

**Otherwise** the error is `not_enrolled`, `binding`, `floor`, `prior_state`, `not_primary`, `busy` or `bad_request`.

**Client:** `verifyEnrollment({binding, floorDigest, signal})` resolves the result only if the echoed `binding`/`floorDigest` match. Anything else fences.

## 4. Admin enrollment (role endpoint; an existing package format, bound to the primary's boot)
**Request:** `POST /platform-api/derived-enroll` (peer/control listener, primary only) with a `PACKAGE_FORMAT` package:
```json
{ "format": "enclave-platform-api-package/v1", "kind": "derived-enroll", "groupId": "<group>", "targetStatementSha256": "<primary's statement sha>",
  "at": 1730000000000, "mode": "genesis|rotate|recover", "readerPins": "<sha256>", "binding": "<KVM reader binding, sha256 hex>",
  "floorDigest": "<sha256(canonicalJson(floor)); genesis: of null; recover: of highWater>", "previousDigest": "<sha256 of the held package>|null",
  "stateDigest": "<sha256 of the current committed state manifest>|null", "markerDigest": "<sha256 of recovered.json>|null", "highWater": null, "signature": "0x…" }
```
`stateDigest` = sha256(canonicalJson({rel: sha256})) over `data/derived-authority/state/`. It is shown in role status.

**Accepted only when:**
- the member is the primary;
- `packageSigner` ∈ `platformApi.admins`, with the right group, kind and target boot (EIP-191, existing);
- `at` is strictly newer than the held enrollment;
- `previousDigest` equals the held enrollment's digest (`null` only when none is held).

**Per mode:**
- **`genesis`:** no enrollment, no state file and no restore marker. `stateDigest: null`, `highWater: null`.
- **`rotate`** (a new image record, for example the checkpoint before 2026-11-01 or a new native): there must be a held enrollment, and `stateDigest` must equal the current one. **The floor is carried:** state files are kept unchanged, and the descriptor names `previousReaderPins` so KVM re-seeds its journal under the new binding from the carried floor. No marker may be pending.
- **`recover`:** the restore marker must be present, with `stateDigest` = the restored state's. `highWater` is **required**: an anchor `{tier, base:{number,hash,…}, l1:{number,hash,…}}` that the admin retained from status **before** the loss and reviewed.
  - The reader must seed its floor at **max(restored floor, highWater)** and refuse contradiction.
  - **An archive alone never establishes freshness.** A restored state below the admin's high-water is raised to it, never silently accepted as current.
- **There is no `reset` mode.** A contradicting or corrupt state is never reseeded automatically. Break-glass needs a separate review.

**Commit and response:**
- The record is written, then `await node.commit()`, then `200`.
- On a commit failure: `503 not_committed`, and the replica has stepped down. A timed-out write may still appear later; it is a valid admin record either way.
- The relay is restarted to pick it up.

## 5. No crash loop
**A derived-enabled child that exits before it reports `listening`** (for example KVM refusing missing, corrupt, contradicting or expired state):
- sets `derivedDisabled` for that enrollment digest;
- is restarted **without** derived env, so the relay is up with writer authority unproven;
- the reason is logged and shown in status.

A new enrollment digest clears the flag; nothing else does.

## 6. Mapping onto the ACCEPTED KVM API (root note, 14:49 UTC; the exact frozen KVM implementation is still pending)
The writer adapter `relay/derived-writer-authority.mjs` is the only caller. It acts only with a role descriptor, and only if `typeof runtime.enrollDerivedState === "function"`.

**Without that function:** it logs and returns `null`. The relay serves, writer authority is unproven, and nothing is started.

**With it, the call sequence is:**
1. **Config:** `config = { ...composed, journalDir, coverageDir, runsDir }` from the descriptor. These are explicit split fields; the legacy `stateDir` is then unused.
2. **First start of an enrollment** (the descriptor lacks a `reader/*` or the `bridge/anchor-journal.json` file):
   `await runtime.enrollDerivedState(config, { verifyEnrollment: committer.verifyEnrollment, commit: committer.commit, commitTimeoutMs: 10000, anchorJournal })`.
   - KVM computes the binding and asks the ROLE over IPC (§3b).
   - It refuses if any prior file exists, and seeds both small journals through `commit` (§3).
   - The role is the trusted provider: signature, admins, restore marker and admin high-water are verified there. `config.enrollment` is never trusted.
3. **Bridge journal:** `runtime.openLifecycleJournal(ENCLAVE_DERIVED_ANCHOR_JOURNAL, { requireExisting: true, commit, requireCommit: true, commitTimeoutMs: 10000 })`.
4. **Reader:** `runtime.startDerivedLifecycleReader(config, { verifier, journal, journalCommit: commit, requireJournalCommit: true, commitTimeoutMs: 10000 })`.

**What `commit({file, bytes, sha256, signal})` guarantees:**
- It is **exactly `true` only** after the role's §3 reply, which is bound to boot and id and confirms majority-committed exact bytes.
- An abort while in flight fences (the outcome is unknown).
- KVM awaits it, then rechecks cancellation, liveness and freshness before publishing.

**Pending on KVM's side:** rotate under a changed binding (carry the committed floor) and recover (seed at ≥ `enrollment.highWater`). The descriptor and §3b result carry `mode`, `previousReaderPins`, `highWater` and `floorDigest` for that. Until KVM implements them, such a start is refused by KVM. The child then exits before serving, the role disables derived mode for that enrollment (§5), and the relay stays up with writer authority unproven.

## 7. Honest limits
- **Crash-fault replication only:** any K holder can forge.
- **Co-located members** (same host) count as separate votes in `platformApi.members`. Their "majority" is then one host's RAM. **No quorum, distinct-host or SNP-persistence claim is made**, and status labels the state `crash-fault, members not proven distinct`.
- **Whole-group loss:** recovery rests on the admin's retained high-water, not on the archive.
- **Authority:** none of this makes writes authorized. The writer keeps its **fixed 120 s ceiling**, and with L1-finalized anchors (≈13+ min old) it stays `stale_snapshot`. Enrollment is necessary, not sufficient.
