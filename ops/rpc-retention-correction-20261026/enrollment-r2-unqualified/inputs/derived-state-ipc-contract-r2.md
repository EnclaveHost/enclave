# Derived-reader durable state: integration contract r2 (role ⇄ relay child ⇄ KVM)

**Status:** PROPOSED by Claude for `accepted-image-enrollment-stage/r2`, 2026-10-26.
- **Supersedes** `logs/derived-state-ipc-contract.md` where they differ.
- **Inputs:** `logs/claude-enrollment-security-review.md` (B1–B5 and points 1–4) and `logs/image-enrollment-root-note.txt` (through the 15:08 API freeze).
- **Scope:** role side only. KVM modules are not edited.
- **B2** (a partial genesis seed) belongs to the KVM source owner. See §7.

## 1. Durable files: exactly two
| IPC name (relative, the ONLY accepted values) | replicated copy (role-written) | canonical RAM path (KVM's) |
|---|---|---|
| `reader/derived-state.json` | `data/derived-authority/state/reader/derived-state.json` | `<stateDir>/journal/derived-state.json` (= `config.journalDir` + `/derived-state.json`) |
| `bridge/anchor-journal.json` | `data/derived-authority/state/bridge/anchor-journal.json` | `ENCLAVE_DERIVED_ANCHOR_JOURNAL` = `<stateDir>/anchor-journal.json` (image `roleEnv`, unchanged) |

**Rules:**
- The pattern allowlist is gone: any other name is refused at the client, the role and the state reader.
- **KVM's commit hooks pass the ABSOLUTE canonical RAM path** (15:08 note). The adapter maps **only** the two exact paths above to the two names:
  - the path must be absolute and already normalized (`path.resolve(p) === p`);
  - it must equal one of the two paths;
  - it must not be a symlink;
  - its parent directory's `realpath` must equal the parent itself.
- **Everything else throws before any IPC:** traversal, a relative path, a foreign file, or a symlinked file or parent. KVM fences on a throw.

## 2. Role-level serialization (B1, B3)
**One role-wide async lock (`derivedLock`) orders all of:**
- every relay **start** (state plan, seed and spawn);
- every `derived-commit` and `derived-enroll-verify`, from any child, old or new;
- every **enrollment**.

There is no per-child `busy` flag any more. A request queued by a child that is no longer the current child is refused **without writing** (`not_current_child`).

## 3. Only exact, freshly majority-committed bytes (B1)
**A fresh committed scan:**
1. under the lock, as primary, `epoch = node.promised`;
2. `await node.commit({ heartbeat: true })`, which always runs a full majority round;
3. require `true`, still primary, the same epoch, and a valid lease;
4. then `scan = copy of node.index`, the scan that round acknowledged.

**Gate, seed, enrollment and provider answers** all read state with `readState(dataDir, scan)`. Every `derived-authority/*` file must be in the scan with **exactly** the local bytes, and no local file may be outside it. **Anything else refuses (no seed, no answer); nothing is repaired.**

**A relay start:**
- deletes `journalDir` (including KVM's local `.enrollment-inflight` marker, and any pending, uncommitted or failed copy) and the RAM anchor journal;
- writes back **only** the committed bytes;
- writes the descriptor.

`coverageDir` and `runsDir` stay KVM's. This is the "parent RAM discard only by reseeding validated committed-majority copies" of the 15:08 note.

**An unknown outcome may become committed later.** A write whose commit failed or timed out stays in the local directory. The next fresh round replicates it, and it is then committed, majority-held and seeded. The role never assumes it is absent, and the client never treats a failure as "absent" (§4).

## 4. IPC `enclave-derived-commit/v1`: deadlines and outcome semantics
**Request:** `{t:"derived-commit", v:1, boot, id, file, bytes, sha256, timeoutMs}`.
- `timeoutMs` is the client's deadline (1..120000).
- The role computes `deadline = receipt + timeoutMs − 250 ms`.
- **It writes nothing** if the lock is acquired after the deadline.

**Reply:** `{t, v, boot, id, ok, ...}`.
- **`ok: true`, `sha256`, `head`:** the committed scan of a majority round holds exactly these bytes, in the same epoch with the same primary.
- **`ok: false, outcome: "refused"`, `error`:** **definitely not written.** Errors: `bad_request`, `not_enrolled`, `not_current_child`, `not_primary`, `deadline`.
- **`ok: false, outcome: "unknown"`, `error`:** written locally and **may be committed later**. Errors: `not_committed`, `epoch_changed`, `bytes_changed`, `write_failed`.

**Client errors:**
- `derived_commit_refused`: a role refusal;
- `derived_commit_outcome_unknown`: a role-reported unknown, a client deadline, an abort in flight, or the channel closing in flight;
- `derived_commit_fenced`: every later call;
- `derived_commit_invalid`: a malformed request.

**Every failure fences.** KVM must treat refusal and unknown alike: no publication, journal fenced.

**`derived-enroll-verify {binding, floorDigest, timeoutMs}`:** answered from a fresh committed scan (§3), under the lock, with the same refusal codes. The result is unchanged from r1, plus `committed: true`.

**Deadline relation:** client/KVM `commitTimeoutMs` (10000) > `leaseMs` (the role's replica asks time out at `leaseMs/3`, serialized behind other rounds). `platformApi.leaseMs` is bounded to 2000..60000 at bind time. With a lease above 10 s the role answers `deadline` or `unknown` more often (availability only).

## 5. Enrollment (B3, B4)
`POST /platform-api/derived-enroll`. The order is:
1. Signature first (EIP-191 ∈ admins), **outside** the lock, so non-admins cannot stop the relay.
2. **Under the lock:**
   1. stop the relay child (quiesce the writer);
   2. take a fresh committed scan and `held = readState(scan)`;
   3. run the rules;
   4. re-verify the held enrollment's signature;
   5. **re-read `held` right before the write**, refusing on any digest change;
   6. write `enrollment.json`, then `await node.commit()`;
   7. require true, the same epoch and primary, and the committed scan holding exactly the record's sha.
3. **The relay restarts after the lock is released:**
   - **after durable success**, with the new enrollment;
   - **after a refusal before writing**, unchanged, because nothing changed;
   - **after an unknown outcome:** the member has stepped down, so it does not restart. The reply is `503 {error: "outcome_unknown"}`, and the record may later be committed.

**Rules added in r2:**
- **Future dating:** `at ≤ now + 24 h`.
- **`rotate`:** `floorDigest` must equal `sha256(canonicalJson(committed bridge authorityAnchors["8453"] or null))`, i.e. the **committed** floor (`wrong_floor`).
- **`recover`, enrolled group:**
  - `highWater` must be ≥ BOTH committed restored floors (the bridge's `authorityAnchors["8453"]` and the reader journal's `floor`);
  - compared **component-wise per chain**: `base.number ≥` and `l1.number ≥`, each separately;
  - on an equal number, `hash` and `stateRoot` must be identical (and `outputRoot` for Base);
  - otherwise `high_water_below_restored`;
  - `floorDigest` = the high-water's.
- **`recover`, never-enrolled group:** only if the restored archive has **no** derived state (`stateDigest === null`), with the null floor.
- **No reset.** Unreadable or malformed held state refuses everything.

## 6. Runtime declaration and composition (B5)
**The adapter hands the role's durable state to a runtime ONLY if it declares exactly:**
- `DERIVED_STATE_API === "enclave-derived-state/v1"`;
- functions: `enrollDerivedState`, `derivedReaderBinding`, `openLifecycleJournal`, `startDerivedLifecycleReader`.

**Who declares it:** the relay-side runtime module `relay/derived-reader-runtime.mjs` (role composition, per the 15:08 note). It does so **only together with the frozen KVM closure** that implements those functions with the options below. The stage carries the proposed export lines in `proposed/derived-reader-runtime.exports.patch`. They are applied by the harness's `kvm` mode only; see §7.

**Otherwise:** `null`. The relay serves, writer authority is refused (§8), and nothing is started.

**The calls (15:08 freeze):**
1. **Config:** `config = { ...composed, journalDir, coverageDir, runsDir }` with **`stateDir` DELETED**, because KVM rejects mixed legacy/split.
2. **First start of an enrollment** (no committed reader/bridge file):
   `await enrollDerivedState(config, { anchorJournal, verifyEnrollment, commit, commitTimeoutMs: 10000, signal })`.
3. **Bridge journal:** `openLifecycleJournal(anchorJournal, { requireExisting: true, commit, requireCommit: true, commitTimeoutMs })`.
4. **Reader:** `startDerivedLifecycleReader(config, { verifier, journal, journalCommit: commit, requireJournalCommit: true, commitTimeoutMs })`, forwarded to `startDerivedReader`.

**Hooks:** `commit`/`journalCommit` receive `{file: <absolute canonical RAM path>, bytes, sha256, signal}`. They are mapped per §1 and resolve **exactly `true`** only on the role's `ok:true`.

## 7. Dependencies NOT resolved here (stated plainly)
- **B2, partial genesis:**
  - **The failure:** two separate durable commits. If only the first commits, a later `enrollDerivedState` must not refuse forever, and must not complete automatically from foreign or advanced bytes.
  - **Owner:** the KVM source owner. Root requested ONLY:
    - **(a)** exact, authenticated, same-genesis, deterministic committed-subset recovery (divergent, advanced or foreign refused); or
    - **(b)** a true crash-consistent batch plus manifest.
  - **Role side:** the descriptor lists exactly the committed files with their sha256, and the provider answer lists `priorFiles`.
  - **If (b) is chosen:** the role needs a batch IPC request (`{files:[{file,bytes,sha256}…]}`, one majority round, one reply). I have **not** invented it; it will be added to match KVM's frozen callback once named.
  - **Until then:** a partial genesis leaves the reader refused, derived disabled, and the relay serving with writer authority refused.
- **Rotate/recover runtime (carry-floor composition):** KVM's first revision refuses them (15:08). The role checks above are guards only. **They remain required rollout work and are not complete.**
- **The exact runtime module locations** of `enrollDerivedState`/`derivedReaderBinding` are not in the note. The proposed export patch assumes `network/derived-reader/provider.mjs`. If KVM's closure differs, the harness's `kvm` mode fails at that patch with the path. That is a one-line fix, not a design change.

## 8. No-authority downgrade defense
- **The marker:** the role sets `ENCLAVE_DERIVED_INTENDED=1` whenever `platformApi.derivedReader` is bound, enrolled or not. It is role-only: refused in bound `relayEnv` and dropped from credentials.
- **In `relay/api-relay.js`:** when it is set and no derived authority was built, the relay builds **no public-RPC lease reader** and uses **`refusingWriterAuthority("writer_authority_unproven")`**, independent of `RELAY_CHAIN`. It logs that the intended derived reader is unavailable.
- **The crash guard:**
  - A derived-enabled child exiting unexpectedly before it listens, **or within 60 s after**, disables derived mode for that enrollment digest. Only a new enrollment clears it.
  - It is in memory; it bounds a loop per role-process life.

## 9. Honest limits (unchanged)
- crash-fault replication only;
- co-located members are not a quorum;
- whole-group recovery rests on the admin's retained high-water, not on archives;
- the writer's fixed 120 s ceiling means L1-finalized anchors give `stale_snapshot`;
- enrollment is necessary, not sufficient.
