# Accepted-image derived-reader ENROLLMENT and durable-state transport, role side (PREPARED; not run by Claude)

**Stage:** `accepted-image-enrollment-stage/`, `SHA256SUMS` sha256 **ccee4c59313f8ad3268f10ce1b57b2071e498ecde3c37c8cf8aa9725d24db042**.

| file | sha256 |
|---|---|
| `patches/accepted-image-enrollment-vs-r3.patch` | `df06a34c…` |
| `jobs/root-accepted-image-enrollment.sh` | `28f4f567…` |
| `PROVENANCE.md` | `e5564eae…` |

- **Inputs:** the contract, root's note, the audit and the 1384 r3 verdict, all in `inputs/`.
- **Tree:** **`583f2d7c3039ecbb04ce582f180e54546253a85e`** = r3 `59e11251` + the patch. I re-verified it from r4 + r1/r2/r3 + patch in a clean temporary repo.
- **Not done:** no tests, builds, queue, SSH, network, live actions or commits. I ran only `node --check`, `bash -n` and tree reproduction.
- **Left alone:** r1/r2/r3, r4 and every KVM module.
- **Contract (written first, revised to root's 14:49 API):** `logs/derived-state-ipc-contract.md`.

## What it implements (role side, using existing mechanisms only)
1. **Unenrolled means the relay is available and writer authority is unproven (the crash-loop blocker in audit 370).**
   - The role gives the relay **no** derived name unless, at that start, `data/derived-authority/enrollment.json`:
     - is re-verified against `platformApi.admins` (EIP-191, the existing `packageSigner`);
     - matches this image's `readerPins` (sha256 of `DERIVED-READER-IMAGE.json`);
     - matches the restore marker, if any.
   - **Guard:** a derived child that exits **before it listens** disables derived mode for that enrollment digest. The role restarts the relay without it. Only a new admin enrollment re-enables it.
   - **Status** shows `reason`/`disabled`.
2. **Enrollment:** `POST /platform-api/derived-enroll`, using the existing admin package (`kind: "derived-enroll"`).
   - **Bound to:** the group and the **primary's boot** (`targetStatementSha256`).
   - **Requires:** `at` strictly newer, a `previousDigest` chain, the current `stateDigest` and `markerDigest`, `readerPins`, plus KVM's `binding` and an exact `floorDigest`.
   - **Handling:** serialized; written to the replicated, sealed `data/`, then `node.commit()`, then 200.
   - **Modes:**
     - **`genesis`:** only with no enrollment, state or restore; the floor is null.
     - **`rotate`:** carries the committed state unchanged and records `previousReaderPins`. It can never clear a pending restore.
     - **`recover`:** only after an admin `recover` bootstrap marker, and **requires the admin's retained, reviewed high-water anchor** (`floorDigest` = its digest) for any previously enrolled group.
   - **There is no reset.** Corrupt or unverifiable held state is never replaced automatically (`held_state_unreadable` / `held_unverified`).
3. **Durable transport: private IPC, not the HTTP barrier.** The relay child's `relay/derived-state-commit.mjs`, over Node's per-child IPC channel:
   - **`derived-commit {boot, id, file, bytes, sha256}`.** The role:
     1. checks boot, a strictly increasing id, the file grammar, ≤ 1 MiB, ≤ 8 files and the exact sha;
     2. **writes the bytes itself** to `data/derived-authority/state/<rel>`;
     3. awaits `node.commit()`;
     4. replies `ok` + `head` **only if** it is still the primary of the same epoch and the **committed scan holds exactly that sha**.
   - **`derived-enroll-verify {binding, floorDigest}`:** the provider answer for KVM's `enrollDerivedState`. It answers only for the child's own verified enrollment, the signed binding and floor, and, for a genesis, only while no durable file exists.
   - **Client:** it serializes requests. It resolves only an exact echo (boot, id, sha or binding/floor, well-formed head). It **fences permanently** on a timeout, refusal, mismatch, abort in flight or closed channel. Late or unknown replies are counted and resolve nothing.
   - **Each relay start** gets a new random boot. The role re-seeds RAM working copies **only from the committed copies**, so uncommitted, never-acknowledged local bytes are dropped. Coverage and runs are left to KVM.
4. **Writer adapter:**
   - **With the role descriptor and a runtime exposing `enrollDerivedState`:** it uses root's accepted API, exactly as in contract §6:
     - split `journalDir`/`coverageDir`/`runsDir`;
     - `enrollDerivedState` on the first start of an enrollment;
     - `openLifecycleJournal(..., {requireExisting, commit, requireCommit, commitTimeoutMs})`;
     - `journalCommit` + `requireJournalCommit`.
   - **Without such a runtime (today's KVM):** it returns `null`, so the relay serves with writer authority unproven. It does not throw.
5. **No new secret and no plaintext to sinks.** Everything is inside the existing K-sealed replicated directory and archive. The new status fields are public digests and the floor anchor (chain data). The two new env names are role-only, refused in bound `relayEnv` and dropped from credentials.

## Root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-enroll-check 2560 unshare -Urnm bash accepted-image-enrollment-stage/jobs/root-accepted-image-enrollment.sh check
bash jobs/q-exit-status.sh aie-enroll-image 1024 unshare -Urnm bash accepted-image-enrollment-stage/jobs/root-accepted-image-enrollment.sh image <CHECK_RUN> <BASE> <OUT>
```
- **Harness:** r3's strict harness (root 1384 PASS), unchanged in method:
  - frozen r1/r2/r3/r4 sums;
  - tree reproduction `5052bd58 → c0a5f4e4 → 59e11251 → 583f2d7c`;
  - read-only `node_modules` binds;
  - runtime pin `e12c5baf` (its 2477 inputs contain no file this patch touches);
  - reader runtime and sidecars;
  - **guest bundle regenerated** and `--check` rc 0;
  - a private release commit.
- **Bundle requirement:** the regenerated bundle must carry the edited role, `derived-state.mjs`, the client and the adapter, at the tree's digests.
- **Tests, strictly clean, with exact counts:**
  - **new enrollment 12**;
  - endpoints 6;
  - overlay 25 (real inputs);
  - platform-api-config 5;
  - writer 23, relay reader 4, KVM 33;
  - the 4 real relay startup refusals;
  - relay/platform group at r3's exact counts: native-relay 8, consumers 10, admin-cli 9, admin-status 1, forward 6, handoff 9, hosted 6, native-issuer 11, registry 1, replica 12.

**New suite (`test/derived-state-enrollment.test.mjs`):** three real `startRole` members with the real `ReplicaNode` over a partitionable/delayable in-process transport, real viem admin signatures, and a stand-in relay child using the real client over the real IPC.
1. **unenrolled:** no derived env, no state, no restart loop;
2. **genesis refusals:** non-admin, kind, target boot, pins, previous, state, reset, extra field, bad binding/floor, rotate/recover preconditions, tampered signature, standby. Then genesis; a replay and a second genesis are refused;
3. **IPC:**
   - the provider verify answer;
   - the commit reaches a majority including the primary;
   - 9 malformed or foreign requests write nothing;
   - a valid hand-made request commits, an id is never reused;
   - verify refuses wrong binding/floor, `prior_state` and a foreign boot;
4. **restart:** a new boot; the committed copy is seeded; the old boot is refused;
5. **deadline:** a timeout fences, and the late ack resolves nothing;
6. **quorum loss:** never acknowledged; the primary steps down and the relay stops. After healing, all members agree. The never-acknowledged write may be adopted, stated as such;
7. **failover:** the successor seeds the same committed copy;
8. **crash guard:** derived is disabled, the relay serves, no loop; a rotate carrying the state re-enables it;
9. **image rotation:** unenrolled until a rotate for the new pins, which carries the state;
10. **restore rules:** marker → unenrolled; `rotate`/`genesis` refused; `recover` without or with a wrong high-water refused; the correct one is accepted and passed on; a later restore needs a new recover; a corrupt held record is never replaced;
11. **client:** exact echo, mismatches, timeout, disconnect, abort in flight, verify, serialization;
12. **adapter:** an old runtime gives `null` with no start; the new runtime gets exactly the accepted options and calls in order.

**Unrun-risk notes:**
- The suite's timings use `leaseMs` 2000 and a 120 ms transport delay, aimed at the deadline case.
- If a timing assertion flakes, the log shows which. It must be fixed, not counted.

## Exact remaining items (not claimed)
- **KVM (root note: implementation pending):**
  - `enrollDerivedState`, `journalCommit`/`requireJournalCommit`, and `openLifecycleJournal({requireExisting, commit, requireCommit})`;
  - **rotate under a changed binding** (carrying the committed floor) and **recover at ≥ `highWater`**.
  - Until then, such starts are refused by KVM, and the role's guard keeps the relay up with writer authority unproven.
- **Admin process:**
  - retain the high-water: status `derived.bridgeFloor` and `stateDigest`, reviewed and kept outside the group;
  - sign `binding`/`floorDigest` only once KVM's binding function is frozen. **No signature is requested now.**
- **Durability:** crash-fault replication over the configured members only.
  - **Co-located members count as separate votes, and no quorum or distinct-host claim is made.** The test runs all members in one process and on one host.
  - There is no SNP-persistent counter.
  - A whole-group loss rests on the admin's retained high-water, **not on archives**.
- **Root:** run the job, re-measure the image (the bundle and role change), then SNP qualification.
- **Unchanged:** the writer's **fixed 120 s ceiling**. With L1-finalized anchors, writes stay `stale_snapshot`. Enrollment is necessary, not sufficient. Admin controls, the 16 GiB floor, native v3 and the finalized-only derivation are also unchanged.
