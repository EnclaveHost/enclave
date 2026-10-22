# sia-s3 integrated storage protocol: independent final review (Claude)

Date: 2026-10-19 (review started 20:29 -07:00). This was a read-only review of the shared main tree. I made no source
edits there, no commits, no production/SSH/staging/catalog/wallet/contract actions, and used no GUI or Wine. My only
writes are under `work/storage-final-integration-review/` (a hashed snapshot and a Python model) and the two
reporting files. I built and ran no Rust. Native evidence below is the integrator's logs, which I read; I did not
reproduce them.

## Decision

**Source:** commit candidate for continued work after F1, not an activation candidate.
- Against the mock-indexer fault model, no safety blocker was found in the reviewed hashes. The evidence is code
  reading, the integrator's 65/65 native runs ×2 and 14 mutants, and my bounded models.
- **Update (U1, found while preparing the fencing work).** Real indexd 0.6.0 publishes object-listing positions
  asynchronously. A re-pinned or new object is absent from every listing until it is published (≥ 1 s, unbounded
  if publishing stalls). sia-s3's boot quorum argument assumes that a booting writer's listing contains every
  acknowledged pin. That is false within the publication lag, so a crash restart or writer handover can miss
  acknowledged ceilings, records, tombstone-carrying objects or newer versions.
  - The mock cannot show this.
  - Fix (a) is an additive indexd listing mode or watermark. Fix (b) is a sia-s3-side barrier, with a residual.
  - U1 is a **safety blocker for activation** until fixed, or disproved by the real-indexd harness.
  - Details and source lines: `work/storage-final-review-interface.txt` [U1].

**Activation:** NOT READY. Open gates: U1; real-indexd durability proof; independent funded operators; writer
fencing (`work/storage-writer-fencing-proposal.md`); a clean committed build; cutover.

The local tests and models are one-writer, fail-stop, mock-indexer evidence. They do not show production
decentralization, concurrent-writer safety or Byzantine tolerance, and nothing here certifies those.

## Exactly what was reviewed

- **Snapshot:** `work/storage-final-integration-review/snapshot/`.
  - Taken 2026-10-19T20:29:02-07:00 from `work/enclave-apps-sia-recovery/sia-s3`.
  - Base: HEAD `54818ba68ea0feddec1cae5650230ddf2fec3d30` plus an uncommitted diff (6 files, +2701/-136). The diff
    is saved as `snapshot/main.patch` and the hashes in `snapshot/SHA256SUMS`.
- **Match:** every `src/*.rs` hash equals the integrator's `work/storage-integration-logs/final-sha256.txt`.

| file | sha256 |
|---|---|
| src/replica.rs | 043d9ee42d68bffa3df4ec3d778d787b29197d420caa27f53a22cf14bd5a82b3 |
| src/store.rs | 225c09b42eed019fe883caf2dc7c8525c470edc55579fb04885f1e6eb9b1ee49 |
| src/main.rs | ed6abf7f587319c62a99a3f32de4a78dab4ac11d0697fbfd0ebc48876cd8ed5a |
| src/config.rs | 0926f0cf0402b9fb32a9bfa0b6048693b6f1ab179c21c61abc99da9b32d6f11f |
| src/s3.rs | a84be65ea5dd61091d3940c8f40dec0db6627603164ee68747127efab44677c6 |
| src/recovery.rs | 43609c73f6b9802bf5639ae93a72b395fb4647540d0d35a316f8946cc9715fb2 |
| src/import.rs | bf3b8b593f0ab9d1c7ab3b75b623d4941229bb4df1a5b74db1107def470aa495 |
| src/diag.rs | ea7021ddb43b2a8aba7f22f8c49fe40c906a4ecf13df05bb496b982d2387b033 |
| src/http.rs | 46686e51be1f833dd3d7107d05689c57b46dec13f7a419b6ea70aab000a7bb66 |
| src/sigv4.rs | 6ee15cba4bdc8f1bb2511bf3b109df0b3af6da374a0069c8c866691c6fc092f4 |
| REPLICATION.md | e8ff4c1deba4d44d3bce87b7477ec64a1ef9209b02e2098fec33eb8c1187294e |
| README.md | e22865799c609da74bf23f64d7f5b672183cdd243ef838ad1b9578993013c4de |

Any change after this snapshot invalidates the hash-specific statements here.

**Earlier model runs (honest status).** My previous bounded checks (`work/storage-protocol-audit/checks.log`)
finished 2 of 8 configurations:
- the snapshot rules: lost write reachable;
- `FIX=legacy,sealall`: 2,360,115 states, no lost write.

The other six have no completion or exit record. Their outcome is **unknown**, and they are not used as evidence
anywhere here.

## Findings

| # | Severity | Finding | Evidence | Minimal fix |
|---|---|---|---|---|
| F1 | Availability (not data loss). Fix before activation | Epoch 2 is shared by record-less commits (p = None) and recorded changes from a single indexer's epoch-1 record (p = Some). A late p = None seal next to the other set gives Refused, which the resolution rule cannot clear. | Model replay `model/traces/F1-epoch2-collision.steps` | A recorded change never targets `RECORDLESS_SET_EPOCH`. The replay with the fix (`F1-fixed.steps`) ends Stable. |
| G1 | Coverage gap | Mutant MI3 (observed ignores records' `c`) survives. The mutants were run on a 61-test tree, not on the reviewed hashes. | `storage-integration-logs/mutants.log` | One test (below) and a mutant re-run on the final hashes |
| G2 | Coverage gap | No mutants for: RECORDLESS_SET_EPOCH, `caught_up`'s in-flight/try_lock final check, `upload_part`'s `acting` re-check, `ensure_range`'s `acting` re-check, `required_ceiling_now` vs `known_ceiling`. No end-to-end test of a split resolved by real late pins (only the pure `membership()` test). | Mutant list | Add mutants and an end-to-end test (below) |
| D1 | Documentation / operations | `sia-s3 import` stamps the wall clock or `SIAS3_IMPORT_VERSION_MS` without a reservation or membership. The README says "a running server sees imported keys after its next index load", which invites running import beside the writer. That is a second writer, and the import's stamps are unbounded by B4. | `import.rs` 82–87, README 94–107 | The README must say to stop the server before importing. Import into every admitted member, or into the single indexer before the migration. |
| D2 | Minor, pre-existing | Duplicate part objects for one (upload, part number) on one replica, left when replacing a part fails to delete the old one, are resolved at load in HashMap order (`store.rs` 629). A reload can index the stale one. With P3 the change then waits (two variants). In Stable a completion may fail on that replica. | Code | At load, keep the part object with the later `created_at` (or stamp parts later). |
| U1 | **Safety at real indexd; activation blocker** | Listings omit unpublished (just pinned or re-pinned) objects, so a boot or re-read can miss acknowledged state | indexd `persist/postgres/objects.go` 354, 433-437, 198-205, 508-560 | indexd listing includes unpublished events, or exposes a watermark; or a sia-s3 barrier object (residual) |
| D3 | Minor UX | After the first `ready`, `boot_error` is never set again. A later Refused or Pending answers 503 with "index is loading". The membership reason is still on `/healthz` under `replicas`. | `main.rs` 129, `s3.rs` 148 | Use `ms_reason()` when not ready. |

No other finding. The required invariants hold as written (next section).

### F1 detail and trace

The relevant code:
- `replica.rs` 140: `RECORDLESS_SET_EPOCH = 2`, used at 575 for record-less commits (p = None).
- `replica.rs` 647: a recorded change targets `top + 1`. From a single indexer's own record `{a}@1`, that is epoch 2
  with p = `{a}@1`.
- `replica.rs` 615: the split resolution applies only when every set at the top epoch names a previous set.

So a seal of an abandoned record-less attempt, landing late beside a committed recorded change at epoch 2, makes the
cluster Refused whenever the replica holding that seal is loaded. Recovery is deleting the record object by hand,
or dropping that replica.

Replay (model with the integrated rules, `FIX=integrated`):

```
L1{a}w1: first pass admit({a}@1) abandoned
-> restart {b,c}w2 + a retiring (no records visible): record-less commit at epoch 2:
   seals b: abandoned, c: abandoned, a: failed -> 0/3, stop
-> admit({a}@1) lands on a
-> restart, same config: Migrating {a}@1 -> {b,c}@2 (p = {a}@1); seal a, admit b,c -> Stable
-> the abandoned s({b,c}@2, p = None) lands on b -> Refused
```

This needs the operator to skip the documented step (wait for `record.admitted` on `/healthz` before listing new
indexers), plus three unlucky pin outcomes. It loses no data.

Fix: at line 647,

```
st.target = MsDef { s: if top + 1 == RECORDLESS_SET_EPOCH { top + 2 } else { top + 1 }, ..cfg };
```

Epoch 2 is then written only by record-less commits, whose admissions follow seals on all listed replicas. A late
p = None seal lands below 3 and is ignored. `membership()` does no other epoch arithmetic, and the docs' claim
("a single-indexer record applied late never collides") then also covers the reverse case.

Test: the trace above with the mock's `Fault::Defer`/`apply_deferred`, asserting Stable at the end.

The fixed rule was replayed in the model only (`model/traces/F1-fixed-replay.txt`, Stable). Its bounded search
(`run_skip2.sh`) never ran: the session ended first, and `skip2-checks.log` is empty. Nothing beyond that single
replay is claimed for the fix.

### G1/G2: tests to add (coverage, not counts)

1. Records' ceiling as the only evidence (kills MI3). Commit a change, then delete one new member's ceiling objects
   on its mock indexer, simulating a rollback or a lost object. Boot from that member plus one other, and assert:
   - `observed_ceiling() >= record.c`;
   - the first stamp is above it;
   - an abandoned PUT of the old writer stays below a new DELETE.
2. RECORDLESS_SET_EPOCH mutant (=1): `a_deployment_without_records_migrates_only_with_every_indexer_up` asserts
   epoch 2, so it likely dies. F1's new test makes the collision itself covered.
3. A split resolved end to end:
   - a partial seal for T1 is acknowledged on a replica that is offline at the next boot;
   - T2 is committed at the same epoch;
   - the replica returns;
   - assert Stable under T2 and that `T1`'s seal is inert (today this is covered only by the pure
     `membership_states_follow_the_records`).
4. Mutants:
   - drop `!wait && s.in_flight() > 0` in `caught_up`;
   - drop `upload_part`'s `acting` re-check;
   - drop `ensure_range`'s `acting` re-check;
   - use `known_ceiling()` instead of `required_ceiling_now()` under the locks.

   Each should be killed by an existing or a new test. Then re-run all mutants on the final hashes. The 14 recorded
   mutants (13 killed) were run while the tree had 61 and then 65 tests. They were not shown to run on 043d9ee4….

## Invariants checked against the code (snapshot line numbers)

- **B1 voting.** Every client write counts only voters, which are the admitted members of the acting set:
  - `commit` 1199/1217, `copy` 1242/1261;
  - `delete`: an up-front quorum check at 1275 and `recorded` at 1332;
  - `create_upload` 1357, `upload_part` (counted under the write lock with an `acting` re-check, 1407–1411),
    `complete_upload` 1429/1448.
- **P1.** A record-less N>1 configuration has no voters and is never ready. `finish` drives the boot-loop commit
  (`membership` 568–588, `main.rs` 120–129).
- **P2.** Record-less commits seal every listed replica and need all n, both in Legacy (577–578) and in Pending with
  prev = None (684–688).
- **P3.** The sources must agree on one variant per open part. `repair_parts` copies only an agreed variant
  (1705–1717). `caught_up` refuses ambiguity and requires the agreed variant (1818–1825).

  Exact selection rule: the variants are the distinct (ETag, size) pairs over the `sources` (Migrating/Stable: the
  admitted voters; Pending: the admitted members, or the prev quorum). A single variant must be held by the member.
  With more than one, nothing is copied and no change commits until the upload is completed or aborted. Open
  uploads older than 7 days are swept, so a forgotten upload can hold a change for up to a week, or until an operator
  aborts it.
- **P4(b).** Split resolution happens only when all sets name a previous set and exactly one has admissions
  (604–626). The lemma (admissions follow w(prev) acknowledged seals, which every later rq(prev) quorum of prev
  meets) holds for recorded changes. It holds for joiner admissions too, because they need the set's earlier seals.
- **B2.** `fetch_index` refuses a replica with a blocking unresolved manifest (`store.rs` 817–823), an unread ledger,
  or an unreadable record. `Index::complete()` uses `blocking_unresolved()` (701–703).
- **B3.** `reconcile` swaps only with `try_lock`, no change since the listing and nothing in flight, then retires the
  old store without an await in between (876–912). Records and ceilings travel in the fresh listing.
- **B4.**
  - `stamp` stays at or below the acknowledged ceiling (724–735).
  - Every stamping site calls `ensure_range` before taking the write lock: 1204, 1247, 1271, 1437.
  - `rebuild` folds every loaded replica's ceiling objects and records' `c` into `observed` (M3, 919–951).
- **M1.** `ensure_range` checks `votes(loaded) >= need` before reserving and counts acknowledgements among voters
  after the fan. It refuses if `acting` changed during the fan (777–795).
- **M2.**
  - `caught_up` requires `idx.ceiling >= required`. `required` is `required_ceiling_now()` under both locks: own
    ceiling, observed, and every loaded idx ceiling, using `try_lock` and never waiting (756–762, 1804–1808).
  - Records carry `c = required` (1922).
- **M2-live.** `ceilings()` copies `known_ceiling()` regardless of who reserved, and renews only when this process
  holds a range and is ready (2070–2098). Repair order is floors → ceilings → admission (1555–1557).
- **RC and lock order.** `admission` takes `reserving` then `write` and holds both through its final rebuild
  (1911–1987).
  - `ensure_range` holds only `reserving`.
  - The stamping sites release `reserving` before taking `write`.
  - Nothing takes `reserving` while holding `write`.

  So there is no lock cycle.
- **Under the write lock, admission never waits on an index.** It uses `try_lock` and refuses a replica with a call
  in flight. Liveness: a long compaction only delays a commit to the next pass.

The paths below are covered by tests (integrator's suite) and/or my model:
- **Delayed pins:** seal and admit abandon/land, part pins in flight, reservation late pins.
- **Crash/restart:** a partially sealed change restarted into Pending; a Pending restart with the ceiling only on
  the old set.
- **Revert:** a record-less commit called off back to the single indexer waits (P2), and the F1 analysis above.
- **Remove/add:** retiring hand-over, a returning member that lost state, a join after outage.
- **Split recovery:** the pure function test, plus my model's recoverable split R1 (Refused under `{a}` alone,
  Stable once the admitted replicas are loaded: `model/traces/R1-then-load-admitted.steps`).

## Remaining trust and fencing assumptions (not removed by this code)

1. **One writer, enforced outside sia-s3.** indexd has no conditional or generation-checked pin. Two concurrent
   writers break conditional PUTs, version ordering and the membership barrier: both can commit different sets at
   one epoch, and both can acknowledge writes. B4 orders *consecutive* writers only. Failover must stop the old
   process before the new one starts, which is an Enclave-level control and is not provided here.
2. **Fail-stop indexers with durable acknowledgements.** An acknowledged pin must survive the indexer's crash
   (PostgreSQL commit before the HTTP answer), and `object_events` must eventually list every live object, records
   and ceilings included. This is the subject of the separate real-indexd validation, and is unproven until that
   lands.
3. **Not Byzantine.** An indexer can withhold records or objects, or replay old state. More than N − W doing so (or
   withholding seals on w(old) old members) can revive an old set or hide acknowledged data. Signed metadata
   prevents forgery only.
4. **Each indexer operator is a single party for its replica:** contracts, renewal, funding, slab repair and the
   object list. Decentralization is real only when the N operators are independent and each replica is funded. A
   mock N=3 shows the mechanism, not that independence.
5. **Writers older than B4 are unfenced.** Calls left in flight by a 0.1.x or 54818ba writer are ordered by wall
   clock only (documented). The first B4 writer fences only later writers.
6. **No rollback below this build.** 54818ba sweeps records and ceilings as orphans after a day (documented).
   Rollback to 0.1.x is unsupported once deletes, manifests or replicas exist.
7. **Import is a second writer** (D1).

## Activation gates (concrete; none done by this review)

From the live legacy baseline: a single indexer, record-less, served by the currently deployed build. I did not
inspect or change it. Each step can be verified on `/healthz` / `/api/status`.

0. Source:
   - apply F1 and add its test (and the G1/G2 tests);
   - re-run the full native suite twice, the wasm check and the mutants on the final hashes, with the bounded runner;
   - commit from a clean checkout: one commit on 54818ba containing exactly the 6 files in `snapshot/main.patch`
     plus the F1 change and its tests. No other files. List the hashes in the commit message or the release notes.
1. Real-indexd evidence (the storage-indexd workstream) on the same commit:
   - durable pin and acknowledgement across an indexd restart;
   - `object_events` listing of v2 record and ceiling objects;
   - a late-applied abandoned pin (or proof that indexd cannot apply one late, which would narrow the model);
   - 1 KiB metadata limits on records.
2. Build the catalog version from that clean commit (not a test build) with the owner's existing authority.
3. Cutover on the existing single indexer, without changing the replica list:
   - stop the old writer completely first (one writer);
   - start the new build with the unchanged single-indexer config;
   - expect Legacy and ready, then after one maintenance pass `record.admitted` at epoch 1 (phase Stable);
   - after the first write, `version_fence` = `ceiling` and `versionCeiling` > 0 on the replica.

   Rollback window: back to the old build only before any DELETE, manifest key or replica list exists (0.1.x leaves
   v2 records alone). Never to 54818ba.
4. Independent indexers: each registers the app key with quota, is funded (about 14 GB contracted per replica at
   today's ~4.7 GB), and is run by an operator shown to be independent of the minipc one.
5. Migration (following "Operator procedures"):
   - list the new indexers (the old one stays a member, or is listed `retiring` when it is to be replaced) and
     restart;
   - expect Migrating (old set serving), then backfill;
   - the commit needs every new member loaded, caught up and holding the ceiling, and no open-upload part variant
     disagreement;
   - expect Stable at epoch 2 today, or epoch 3 with the F1 fix (a recorded change from `{a}@1` then skips 2; only
     a record-less commit uses epoch 2);
   - only then drop a `retiring` replica from the list.
6. Post-checks:
   - a restart with one indexer down still serves (N=3, W=2);
   - `observed_ceiling` ≥ the previous writer's ceiling;
   - no Refused or Waiting.

## Model evidence: exact bounds and what did not finish

Model: `work/storage-final-integration-review/model/ms_model.py`, `FIX=integrated`. It transcribes the integrated
`membership()` and `admission()` rules (P1 legacy-not-ready, P2 seal-all, P4(a) epoch 2, P4(b) resolve). It is
one-writer and fail-stop. Every record pin either succeeds, fails, or is abandoned and lands later. Restarts may pick
any configuration and loaded subset. Writes are acknowledged by exactly `need` voters. B4, multipart and B3 are not
in this model. B4 and multipart are covered by the directed `joint_traces.py` and by the integrator's native tests.

Each run used depth-first search under a 190 MB address-space limit (peak RSS 142 MiB) and a 600 s cap. The log is
`model/integrated-checks.log`.

| Configuration (universe:writes:configs:max epoch) | States | Complete? | Lost acknowledged write | Refused with disagreeing records |
|---|---|---|---|---|
| legacy:1:-:3 | 5,121,642 | **No**: stopped at the time cap | none found in the explored part | reachable: the recoverable split R1 |
| legacy:2:-:2 | 1,103,250 | yes (within bounds) | unreachable | reachable: the same R1 pattern |
| recorded:1:C,T1:2 | 93,896 | yes | unreachable | unreachable |
| recorded:1:C,T1x:2 (c dropped from the list) | 11,466 | yes | unreachable | unreachable |
| recorded:0:C,T1,T2:2 | n/a | **started, no exit record**: unknown | n/a | n/a |
| recorded:1:C,T1,T2:2 | n/a | **never started**: unknown | n/a | n/a |
| F1 fix (`integrated,skip2`), 2 configurations | n/a | **never started**: unknown | n/a | n/a |

About the Refused rows:
- R1 (`model/traces/R1-recoverable-split.steps`) is the documented split: Refused while only `{a}` is loaded under
  the single-indexer configuration. Loading the admitted replicas resolves it to Stable
  (`R1-then-load-admitted.steps`).
- F1 is the one case where resolution cannot clear the split. It was found by directed replay, not by these
  searches.
- The T1/T2 split universe (P4(b) under the integrated rules) was **not** checked by search. Its only evidence is
  the integrator's pure `membership()` test and the earlier snapshot-rule BFS (`work/storage-protocol-audit`).

## Addendum: re-read after the integrator's F1/G1 change (2026-10-19T21:03:00-07:00)

- `src/replica.rs` is now `e45eb2f0e3fe0e392a13254060fc7f2a378a213da7384c4368543248380bdb0e`. The other files are unchanged.
- The diff is only:
  - the F1 fix at line 647, exactly as recommended;
  - test expectations moved from epoch 2 to epoch 3;
  - two new tests, covering the F1 trace and the G1 case (a ceiling carried only by a record).
- The F1 finding is closed in code. I did not run the tests. Their results, and a mutant re-run on the final hashes,
  remain the integrator's evidence to provide.
- Still open: U1, which blocks activation; writer fencing (`work/claude-storage-fencing-result.md`); the G2 mutants;
  and the D1 documentation.
