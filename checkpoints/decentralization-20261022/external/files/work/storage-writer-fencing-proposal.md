# sia-s3 writer fencing and consistent listing: protocol specification (revision 2)

Claude, 2026-10-20. This replaces revision 1, which was rejected. Status: specification plus bounded models. I edited
no shared source (indexd, SDK, sia-s3, contracts) and made no commits or production actions.

**Models and outputs:** `work/storage-writer-fencing/`:
- `listing_model.py`, output `listing_model.out`;
- `fence_v2.py`, outputs `fence_v2_*.out`;
- `member_model.py`, output `member_model.out`.

**Source read** (hashes in the result report):
- indexd `work/indexd` @ ddaf24b (0.6.0);
- vendored SDK `app_client/http.rs`;
- sia-s3 main tree (`replica.rs` e45eb2f0…);
- Enclave relay `relay/secrets-release.mjs`, guestd `release.go`, `EnclaveDeployments.sol`.

## 0. What changed from revision 1 and why

| Revision 1 claim | Problem (with evidence) | Revision 2 |
|---|---|---|
| Listing = published pages, then the NULL tail | A row published between the end of the published traversal and the NULL query is missed (`listing_model.out`, L1, 5 steps, no concurrent writes). A pre-listing re-pin can move a row out of a range already passed (L1, 6 steps). | Commit-ordered per-account sequence (§2.3). Complete and snapshot-consistent in every modelled interleaving (L2, up to 3 concurrent mutations, 12,901 states). |
| A mutation is accepted when its token ≥ the fence | A higher token is not proof of an installed fence. With ≥, the frozen-after-install argument that makes the boot listing a snapshot fails. | Exact equality with the installed fence (§2.2). The model finds no violation with ≥ for writers that write only after readiness (`fence_v2_geq.out`). Exact is required by the snapshot argument and for replica-local authority, not by that model. |
| nonce = current + 1 separates contenders | Two starters that read the same maximum choose the same token. A raise equal to the installed one is accepted as an idempotent retry, so both become ready and both acknowledge: DOUBLE create (`fence_v2_traces.out`, 16 steps) and a stale confirmed read (16 steps). Read confirmation does not help, because each instance sees "installed = mine". | A unique 128-bit instance id inside every ballot (§3.1). |
| Readiness on N − W + 1 fenced replicas suffices | With W = N the fence quorum is 1, so two contenders can both be ready. Without read confirmation: a stale 412 (N=2 W=2, 15 steps) and a stale read by the old writer (9 steps). A fence quorum one smaller gives DOUBLE (9 steps). | Readiness permits nothing by itself. Writes need W exact acknowledgements. Every read-type answer needs a confirmation round on W voters (§3.3–3.4). |
| A 5 s fence poll bounds stale reads | False under partition, scheduler delay or a hung poll | Fail-closed confirmation before every read answer (§3.4). |
| "A fenced instance never re-raises" bounds churn | A host can start fresh instances | Safety and availability separated (§5). Churn is bounded per lease by the relay binding. Within the current lease, churn equals that host's existing power to stop the VM. |
| Membership assumed fixed | — | Fenced records and copies, and quorums recomputed over the acting set (§6). Modelled: an unfenced commit gives DOUBLE (`member_model.out`, 29 steps). |

## 1. Facts this rests on (source)

1. indexd 0.6.0 has no conditional mutation (`api/app/app.go` 413, 433). Request authentication covers method, host,
   path, `sv` and body, **not the query** (`api/app/auth.go` 182–190).
2. Every pin, re-pin and delete sets `object_events.updated_at = NULL` (`persist/postgres/objects.go` 354, 435).
   Listings exclude NULL (198–205). A 1 s publisher assigns positions:
   - in batches of at most 25,000, `ORDER BY account_id, object_key, SKIP LOCKED`;
   - stalled while the DB clock is behind (508–560).
3. Two more paths unpublish events without any app action:
   - **slab repair**, `RecordSlabMigrated` (`persist/postgres/sectors.go` 1147–1160), for every object that
     references a migrated slab;
   - admin **unblock** (`persist/postgres/blocked.go` 53–58).

   Blocked objects are silently omitted from listings (`objects.go` 203). Event rows are never deleted. Deleted
   objects keep a `was_deleted` row.
4. The SDK signs with `sv = now + 60 s` (`app_client/http.rs` 615–655). The app API has 30 s read/write timeouts
   (`cmd/indexd/run.go` 346–349).
5. guestd's dead-man lease does not stop a stale guest (`isolation/m4/guestd/server.go` 24, 789–794).
6. The relay issues **one-use** release tickets to the **current lease holder's** operator (`holdsLease`: runner set,
   leaseUntil in the future), with a 120 s TTL. Each ticket is bound to the guest's attestation report
   (`relay/secrets-release.mjs` 8–36, 267–274, 362).
   - It rate-limits by IP or endpoint, **not per lease**.
   - It does **not** put a lease generation into the release.

## 2. indexd patch (additive; accounts that never install a fence keep 0.6.0 behaviour)

### 2.1 Schema

- `accounts.fence BYTEA NULL` (exactly 32 bytes when set);
- `accounts.event_seq BIGINT NOT NULL DEFAULT 0`;
- `accounts.seq_enabled BOOLEAN NOT NULL DEFAULT FALSE`;
- `object_events.seq BIGINT NULL`;
- `CREATE INDEX object_events_account_seq_idx ON object_events(account_id, seq) WHERE seq IS NOT NULL`.

**Token encoding:** `gen u64 BE ‖ counter u64 BE ‖ iid [16]byte` (32 bytes). `gen < 2^63` and `counter < 2^63`; a set
top bit is answered with 400. The order is bytewise, which is PostgreSQL `bytea` comparison and equals
lexicographic (gen, counter, iid).

### 2.2 Fence endpoints and the check (signed app auth, as today)

**`GET /fence`** returns `{"fence": hex64|null, "seq": u64}`. It is a plain read of committed state.

**`POST /fence`**, body `{"fence": hex64}` (the body is already signed). In one transaction:
1. `SELECT fence, event_seq, seq_enabled FROM accounts WHERE id=$1 FOR UPDATE`.
2. If `new == fence`: answer 200 `{fence, seq: event_seq}`. This is an idempotent retry, safe only because the iid is
   unique (§3.1).
3. Else if `fence IS NULL OR new > fence`:
   - If `!seq_enabled`, backfill first:
     `UPDATE object_events SET seq = r.n FROM (SELECT object_key, row_number() OVER (ORDER BY updated_at NULLS LAST, object_key) n FROM object_events WHERE account_id=$1) r WHERE …`,
     then set `event_seq` to the row count and `seq_enabled = true`.
   - Then set `fence = new` and answer 200 `{fence: new, seq: event_seq}`.
4. Else answer 409 `{"fence": current}`.

**Fenced mutations:** every app mutation of account state:
- `POST /objects`, `DELETE /objects/:key`;
- `POST /slabs`, `DELETE /slabs/:slabid`, `POST /slabs/prune`;
- `POST /sharing`, `DELETE /sharing/:key`, `POST /sharing/:key/objects`, `DELETE /sharing/:key/objects/:objectkey`.

**Signed query `sf`:**
- exactly one occurrence;
- exactly 64 lowercase hex characters, decoding to 32 bytes;
- anything else is answered 400;
- `requestHash` appends `"indexd/fence/v1"` and the 32 decoded bytes after the body when, and only when, `sf` is
  present. Requests without `sf` hash exactly as in 0.6.0.

**Check, inside the mutation's own transaction, as its first statement:**
`SELECT fence, event_seq FROM accounts WHERE id=$1 FOR UPDATE`.
- `fence IS NULL`: no `sf`, run as 0.6.0. With `sf`, answer 409 `{fence: null}` (the client must raise first).
- `fence NOT NULL`: run only if `sf == fence` **exactly**. Otherwise answer 409 `{fence}` with no effect.
- When `seq_enabled`: every `object_events` row the mutation inserts or updates gets `seq = ++event_seq`, written
  back to `accounts` in the same transaction. The exclusive row lock is held to commit, so seqs are assigned in
  commit order.
- Raise and mutation both take the account row `FOR UPDATE`, so each mutation is entirely before or entirely after
  any raise.

**Cost:** `seq_enabled` accounts serialize their mutations on the account row at each indexer. sia-s3 has one writer,
and other accounts are unchanged.

### 2.3 Committed-sequence listing (fixes U1 and its slab-repair and blocking variants)

**`GET /objects/seq?after=<u64>&limit=<1..1000>`** (signed; 409 if `!seq_enabled`).
- **Query:** one statement:
  `SELECT oe.object_key, oe.was_deleted, oe.seq, (oe.object_key IN blocked) AS blocked … WHERE account_id=$1 AND seq > $2 ORDER BY seq LIMIT $3`.
  It is joined to the current objects for live rows, and also returns `head = accounts.event_seq` from the same
  snapshot (`REPEATABLE READ`, a single short transaction).
- **No server state:** no cursor objects, expiry or resource held between requests. Resumable from any `after`.
  Bounded by `limit`.
- **Blocked objects are returned flagged `blocked: true`, not omitted.** sia-s3 treats a replica with a blocked
  object as unable to serve as a source (fail closed).
- **Slab repair (`RecordSlabMigrated`) and unblock do not change `seq`:** they do not change object metadata. The
  object's current slabs are returned with the row as today.

**Why it is a snapshot.** Seqs are assigned under the account row lock held to commit. So every mutation committed
after a page query carries a higher seq than every one committed before it. A traversal from `after = 0` until an
empty page sees each key's state as of the last seq read.
- A row re-pinned behind the cursor moves ahead and is seen again.
- A delete is seen as `deleted`.

`listing_model.py` checks exactly this (L2), exhaustive within bounds, including concurrent re-pins and deletes.

**At boot under an installed fence nothing else mutates the account**, because every other mutation fails the exact
check, so the traversal ends at `head` returned by the raise. The listing is the replica's committed state at
install. It includes every pre-fence write, tombstone, ceiling and membership record, published or not.

## 3. Ballots, readiness, writes and reads (sia-s3)

### 3.1 Identity

- `iid`: 16 bytes from the TEE guest's hardware-backed RNG (WASI `random` in the attested VM), drawn at process start.
  It is never persisted and never reused.
- A ballot is `b = (gen, counter, iid)`.
- **Uniqueness assumption (A2):** a running instance cannot be duplicated with its memory. This holds for SEV-SNP and
  TDX guests, whose memory the host cannot copy into another guest. It does **not** hold for a plain VM or for an
  owner's local process. In that case the operator or owner must not clone a running process. Different processes
  draw different iids.

### 3.2 Boot

Let `M(acting)` be the acting set's voters, `W` its write quorum, and `rq = |M| − W + 1`.
1. `GET /fence` on every listed replica.
   - If any installed `gen > my gen`, refuse to start (§5), except in measured cold mode.
   - `counter` = 1 + the maximum counter among installed fences with `gen == my gen` (0 if none).
2. `POST /fence b` to every listed replica. Retries reuse `b`.
   - 200: the replica is *installed*, at `head_r`.
   - 409 with a current fence above `b`: **stop for good**. Do not retry with a higher ballot. A restart is a new
     instance.
3. List each installed replica with `/objects/seq` up to `head_r`, issuing no own write to it before then.
4. Compute membership (B1), view, ceilings (B4) and records from **installed and listed replicas only**. B1's
   "loaded" means this.
5. **Ready** when the membership is ready and `|installed ∩ M(acting)| ≥ rq(acting)`.
   - Another replica becomes usable only after its own raise and listing.
   - Pending, Waiting and Refused never serve.

### 3.3 Writes (every mutation, including records, ceilings, floors, copies, parts and deletes)

- Every mutation carries `sf = b` and goes only to installed replicas.
- An acknowledgement needs `W(acting)` voters answering success (exact fence).
- A 409 naming a fence above `b` means stop for good: answer 503 to everything and exit, so that a restart is a new
  instance.
- A 409 naming a lower fence or null means the replica lost state (outside fail-stop). Stop using that replica and
  report it.

### 3.4 Reads: the exact guarantee

Every answer derived from the view needs **a confirmation round started after the request arrived**: GET, HEAD,
ListObjects, ListParts, ListMultipartUploads, a 412 from If-None-Match or If-Match, and a CopyObject source check.
- A round is `GET /fence` to all voters of the acting set.
- It succeeds when `W(acting)` of them answer exactly `b`.
- Rounds are pipelined, one in flight. Requests arriving during a round wait for the next.
- A round that sees a higher fence stops the instance.
- A round that does not succeed within the metadata deadline answers 503 (fail closed).

**Guarantee:** under A1–A3 (§7), the endpoint is **linearizable per account** for PUT, DELETE, GET, HEAD, CopyObject,
If-None-Match / If-Match PUT and multipart Create/UploadPart/Complete. ListObjects answers from one linearizable view.
This holds across writer changes, concurrent contenders, arbitrarily delayed requests and answers, and partitions.
- A write answered 503 may still take effect later, as now.
- Bytes are read from Sia hosts for the confirmed version.

**Cost:**
- one parallel metadata round trip per read batch;
- read availability equals write availability (W voters reachable). Before, one loaded replica sufficed after boot.

### 3.5 Why (structure; checked by the models within their bounds)

- **(a) Late acknowledgements.** A mutation commits at replica r only while its ballot is installed there. B's
  listing of r happens after B's install and before any other change, so it contains every commit made at r under
  an earlier ballot.
  - Every write acknowledged by an earlier writer has W voter commits.
  - B installed `rq` voters before reading, and W + rq > |M|.
  - So B reads at least one of them. This holds even if the acknowledgement reaches the old writer after B is ready
    (S6, M1).
- **(b) No acknowledgement after B's install.** After B installed `rq` voters, an earlier ballot can no longer gather
  W exact commits, by the same intersection. A higher contender C can still preempt B. Then B's own later writes fail
  at C's replicas, and C's listing contains all of B's acknowledged writes, by (a).
- **(c) Reads.** A read confirmed by W voters holding exactly `b`, after the request arrived, means no higher ballot
  had been installed on those W at confirmation time. Any writer that later acknowledges anything must first install
  `rq` voters, which intersect those W. So everything acknowledged before the read began is in b's view, and nothing
  newer has been acknowledged.
- **(d) Contenders.** Contenders with unique ballots are totally ordered. A raise succeeds only if strictly higher, or
  equal, which can only be the same instance retrying.
  - Two contenders can both be "ready" when W = N, because their fence sets need not intersect.
  - Whichever has the lower ballot cannot acknowledge, or answer a read, after the higher one has installed `rq`
    voters, since `rq` installed voters meet every W set.
  - Before that, everything the lower one acknowledges is in the higher one's listing, by (a).
  - Disjoint W sets can exist (2W ≤ |M|, e.g. N=3, W=1). Safety never needs W sets to intersect each other, only
    `rq` with W.

### 3.6 Model results (exact bounds; peak RSS ≤ 141 MiB; every run foreground and bounded)

**`fence_v2.py`** models N indexers (all voters) with arbitrary delays of requests and answers. Writer A is the old
writer, ready, with its ballot installed everywhere. Contenders B and C start concurrently under the same gen with the
same observed maximum. P = N − W + 1 and Q = W. The operations are put-if-absent and confirmed reads. The checks are
DOUBLE, STALE and REGRESS.

| Scenario | N=1 | N=2 W=1 | N=2 W=2 | N=3 W=1 | N=3 W=2 | N=3 W=3 |
|---|---|---|---|---|---|---|
| S1 A, B, C all create | 629 ✓ | 50,775 ✓ | 865,353 ✓ | 4,653,467 ✓ | stopped at 5.87M, not exhaustive | stopped at 5.87M, not exhaustive |
| S2 A reads, B creates, C reads | 524 ✓ | 38,132 ✓ | 736,024 ✓ | 3,330,002 ✓ | stopped, not exhaustive | stopped, not exhaustive |
| S3 A creates+reads, B creates+reads | 3,132 ✓ | 4,637,372 ✓ | 859,331 ✓ | stopped | stopped | stopped |
| S4 B and C create (same lease, same maximum) | — | — | — | 15,387 ✓ | 672,387 ✓ | **11,398,071 ✓** |
| S5 A reads, B creates | — | — | — | 800,990 ✓ | 6,792,176 ✓ | stopped at 11.7M, not exhaustive |
| S6 A creates (late ack), B reads | — | — | — | 998,766 ✓ | 7,624,624 ✓ | stopped at 11.7M, not exhaustive |

✓ = exhaustive within these bounds, no violation. "Stopped" runs found no violation in the explored part. That is not
evidence of absence.

**Rejected variants:**
- `same` (no iid): DOUBLE in S1 and STALE in S2, for N=2 W=1, N=2 W=2 and N=3 W=3.
- `noconfirm`: STALE or REGRESS in S1, S2, S3.
- `smallP` (P = N − W): DOUBLE or STALE.
- `geq`: no violation found (see §0).

**`member_model.py`** (C = {0,1} → T = {1,2}, the old writer committing, a contender booting):
- proposed: M1 294,909 ✓, M2 8,837 ✓;
- unfenced records: DOUBLE (29 steps);
- "loaded" readiness: no counterexample, because rq is 1 for both sets here, so it coincides with the rule.

**`listing_model.py`:**
- L0: 0.6.0 misses an unpublished commit;
- L1: two misses;
- L2: ✓ in all cases.

## 4. Linearizable metadata layer: what this is

This is the smallest decentralized linearizable layer the data model needs: **one leader per account, elected with
Flexible-Paxos-style ballots across N independent indexers**.
- **Phase 1:** raise plus a snapshot listing on `rq` voters.
- **Phase 2:** exact-ballot quorum writes on W voters.
- **Reads:** confirmed on W voters.

The per-replica primitives it needs are an atomic CAS on the account fence, an exact-ballot check inside each
mutation, and a commit-ordered sequence. That is §2 and nothing more. There is no separate consensus service, no
clocks in safety, and no Enclave component in safety.

## 5. Generation, churn and owner recovery

**Safety does not depend on `gen`.** Any number of instances with any gens remain linearizable (§3.5).

**`gen` decides who may preempt (availability):**
- **Deployment mode:** gen is the lease ordinal `blockNumber << 16 | logIndex` of the finalized `Claimed` event of the
  lease the secrets were released under.
  - **Relay change:** the sealed release (already Ed25519-signed, `responseDigest`) must carry `{deployment id, lease
    ordinal}`, read by the relay from a finalized block when it checks `holdsLease`.
  - sia-s3 takes gen only from there.
  - A host still running an instance from an older lease cannot preempt the new lease's writer: its gen is lower, so
    it refuses at step 1, and its raise would be refused anyway.
- **Churn within the current lease:**
  - The relay must limit releases to **k per (deployment, lease ordinal) per window** (for example 3 per 10 minutes).
  - Each release can preempt at most once, so churn is bounded by that rate.
  - The lease holder can deny service anyway by stopping its VM, so bounded churn adds no new power. The remedy is the
    lease itself: moving the deployment makes a new claim with a higher ordinal, and the old host's instances can
    never preempt again.
- **Cold owner recovery** (measured sia-s3, owner-run, no Enclave):
  - gen = the maximum installed gen and counter = installed + 1. This preempts the current writer but never outranks a
    later lease's ordinal, so it cannot starve successors.
  - Measured code refuses a manual gen above `max(installed gen, the latest finalized claim ordinal it is given)`.
  - The owner should pause or release the Enclave deployment first. Otherwise the platform's next instance (same
    lease, counter + 1) preempts the owner's, and they alternate.
- **Unmeasured tools with the app key** (an owner's own scripts, or a leaked key) can raise any fence or write
  directly. The app key is full authority by design. Fencing protects measured instances from each other, not the
  data from its key holder.
  - A huge gen set this way is permanent (raise only). Owner tooling must use measured cold mode.

## 6. Membership changes (B1) and B2–B4 together

Required algorithm changes:
1. **"Loaded" means installed and listed after install** everywhere B1, B3 and B4 compute from replicas: membership,
   view, observed ceilings, `caught_up`, `view_complete`.
2. **Seal, admit, the caught-up copies, ceiling objects, ledgers (floors), parts and compaction** are all fenced
   mutations. `member_model.py` shows a DOUBLE when commit records are unfenced.
3. **Admission requires the member to have b installed and listed.** After a commit the writer therefore holds b on
   every admitted member of T.
4. **Fence readiness, write acknowledgement and read confirmation use the acting set**, recomputed on each rebuild:
   - Migrating uses C (new members are written but are not voters);
   - Pending, Waiting and Refused do not serve.
5. **A reservation (B4 `ensure_range`) is a fenced mutation counted over acting voters (M1).** `observed` is taken
   from installed and listed replicas (M3). I1 and I2 hold with "boot set" = installed set, by the same W + rq
   intersection.
6. **B3 reconcile re-lists through `/objects/seq`.** Its in-flight and `changes` guards stay.
7. **B2 (an unreadable live manifest keeps a replica unloaded) is unchanged.** A blocked object in the seq listing
   means the same: fail closed.

**Late acknowledgement across a change:** handled by §3.5 (a). The old writer's records and copies commit only while
its ballot is installed. A contender's listing of its installed replicas therefore contains every record committed
there before its install. A commit's W(C) seals intersect the contender's `rq(C)` installed voters of C (M1, M2).

**Parity and censorship resistance:**
- The replication guarantees, cold recovery (read-only) and multipart are kept.
- An indexer that refuses fences or seq listings counts as unavailable, which is no worse than today.
- Read availability needs W voters (§3.4), a stated cost.

## 7. Assumptions and remaining limits

- **A1:** indexers are fail-stop and implement §2 faithfully, with durable acknowledgements. Byzantine indexers
  (ignoring fences, hiding rows, rolling back) are out of scope. A blocked flag is surfaced, and fail-closed handling
  covers only honest blocking.
- **A2:** running instances cannot be cloned (§3.1).
- **A3:** instances run the measured sia-s3 code. A key holder outside it has full authority (§5).
- **Model scope:**
  - one key, one put-if-absent per writer, at most 3 writers;
  - membership modelled only for C = {0,1} → T = {1,2} with W = 2;
  - several N=3 configurations only partly explored (§3.6).

## 8. Implementation sequence

1. **indexd** (owned by the storage-indexd worker; this spec goes through `work/storage-final-review-interface.txt`):
   - migration;
   - `sf` canonical parse and hash in `auth.go`;
   - a `checkFence(tx, accountID, sf) (seq, error)` helper wired into every §2.2 mutation;
   - `GET/POST /fence` with backfill;
   - `GET /objects/seq`;
   - seq not bumped by `RecordSlabMigrated` or unblock.

   **Go tests against the real PostgreSQL fixture:**
   - raise against pin and against delete under concurrent transactions;
   - exact mismatch (lower, higher, null);
   - an equal-raise retry;
   - seq strictly increasing in commit order under concurrent pins;
   - backfill;
   - blocked flag;
   - non-canonical `sf` gets 400;
   - a 0.6.0 client on an unfenced account is unaffected.
2. **SDK (vendored):** a `Fence([u8;32])` type; `fence_get` and `fence_raise`; `objects_seq(after, limit)`;
   `set_fence` adding `sf` to every fenced call's signed query; `Error::Fenced(current)`.
3. **sia-s3:**
   - iid;
   - §3.2 boot replacing `fetch_index`, with `head`-bounded seq traversal;
   - §3.3 fenced mutations everywhere;
   - §3.4 confirmation rounds and fail-closed answers;
   - stop semantics;
   - §6 changes;
   - gen from the relay release and the cold-mode rules;
   - the mock `Net` gains fence and seq (with delayed-commit faults).

   **Native tests:** traces S1–S6, M1–M2, L1-miss and L2, the same-nonce counterexample, and noconfirm stale read and
   412 as regression tests.
4. **Relay:** the lease ordinal in the signed release, and k releases per (deployment, lease ordinal) per window.
5. **Real-indexd validation** on the patched build, then cutover: patch indexd; ship; stop the old writer; the first
   raise enables seq.
