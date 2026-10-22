# sia-s3 membership protocol: independent review (Claude)

Date: 2026-10-19. This was a read-only review of the membership worker's tree (6b7af721/53039). I edited no source
file in `work/enclave-apps-sia-recovery/sia-s3` or in my B2/B3/L1/B4 worktree, made no commits, and used no SSH,
chain, GUI or Wine. The models are Python only, each run under a 190 MB address-space limit (peak RSS is recorded
in each run). No Rust was built.

- **Reviewed:** `work/storage-protocol-audit/snapshot/` is a copy of `src/*.rs` and `REPLICATION.md` taken at
  2026-10-19T19:16:59-07:00, on 54818ba plus uncommitted changes. `SHA256SUMS` is in that directory. The live files
  still matched at 19:4x. Line numbers below refer to the snapshot.
- **Integration handoff:** `work/storage-protocol-integration.txt` (exact M1/M2/M3 rules, plus RC and M2-live, which
  this review adds).
- **Executable evidence:** `work/storage-protocol-audit/`:
  - `ms_model.py`: a transcription of `membership()` and `admission()` (with `admissible()`, `caught_up()`,
    `view_complete()`), plus an exhaustive bounded explorer and a replayer.
  - `joint_traces.py`: directed multipart and B4 traces.
  - `traces/`: the saved traces.
  - `checks.log`: the bounded checks.

## Scope of the claims

- **Fault model:** fail-stop indexers, durable acknowledgements, and one writer at a time. Abandoned calls may be
  applied at any later time.
- **Model abstractions:** writes are acknowledged by exactly `need` voters. Restarts may pick any configuration and
  any non-empty loaded subset. Every record pin either succeeds, fails, or is abandoned and lands later. The bounds
  are stated for each run.
- **What a clean result means:** "no counterexample within these bounds" is evidence about this one-writer,
  fail-stop model. It is not a proof of the Rust code, and it says nothing about concurrent writers (indexd has no
  fencing), Byzantine indexers, or rollback beyond N − W. Nothing here certifies decentralization.

## Findings

| # | Class | What | Evidence |
|---|---|---|---|
| P1 | **Safety: an acknowledged write is lost** | A record-less N>1 configuration serves and acknowledges writes on new members alone. Reverting to the single old indexer then serves without them. | BFS trace, 3 steps |
| P2 | **Safety: an acknowledged write is lost** | A change from a record-less deployment seals only `retiring` entries. If the old indexer is listed as a member and its admission fails, it holds no record, and reverting to it serves stale data. | replayed trace, 4 steps |
| P3 | **Safety: an acknowledged part is lost** | Multipart catch-up accepts *any* part variant a source holds. A stale variant on new members passes the commit, and the acknowledged re-upload can no longer be completed. | `joint_traces.py` MP1 |
| P4 | Availability (permanent, safe) | Two different memberships at the same epoch put the cluster in Refused, and no configuration recovers it. (a) A late N=1 auto-admit lands against a record-less commit (both epoch 1). (b) A partial seal is acknowledged on a replica that is down at the next boot, and a different target is then committed at the same epoch. | BFS traces |
| P5 | **Safety once B4 is merged** | B4 as written counts reservation acks over `loaded()` against `writeQuorum` (M1), and admission does not carry the ceiling (M2). Both undo an acknowledged DELETE across a change. A naive M2 deadlocks Pending (M2-live). A reservation that completes during a commit escapes M2 (RC). | `joint_traces.py` M1, M2, M2-live, RC |
| P6 | Minor or documentation | Seal comment, Waiting reason for dropped members, boot-loop maintenance, rollback to 54818ba sweeps records, `Index::complete()` with B2 | code |

Verified safe within bounds (section "What holds"): partial seals and admissions at crash and restart, late pins,
restarts with any loaded subset, and a retired member dropped from the config for a recorded change (C→T1, with or
without c listed).

### P1: a record-less N>1 configuration acknowledges writes that a reverted configuration never reads

Code: `membership()` 496–519. With no records and N>1, the phase is Legacy, `ready` = every listed replica
loaded, `voters = loaded` (retiring and empty new ones included), and `need = writeQuorum` (over members).
Nothing durable says that this set has acted.

Trace (`traces/P1-P4a-legacy-snapshot-bfs.txt`, shortest, found by BFS):

```
L1{a}w1, record-less, ready
-> restart: config M{b,c}w2 + a retiring, loaded {a,b,c}        Legacy(ready), voters a,b,c, need 2
-> write w0 acknowledged by b,c                                  (a missed it; 2 of 2 needed)
-> restart: config L1{a}w1 (the migration is called off)          Legacy(ready), voters a: w0 is gone
```

Calling a migration off is a normal operator action. The same applies to any record-less configuration whose
listed replicas miss every acknowledger.

Fix (modelled as `FIX=legacy`):
- A record-less N>1 configuration is **not ready**. Its commit (seals, then admissions) runs in the not-ready boot
  loop, so `main.rs` 120–129 must run maintenance for this phase too, not only when `pending()`.
- The zero-downtime path still exists: run the single indexer on this build first. Its first pass writes
  `admit({a}@1)`. Change the configuration afterwards: that is a recorded Migrating change, which serves under
  {a}'s rules while b and c backfill.

### P2: a record-less commit leaves the old indexer without any record

Code: `membership()` 506–507 (`seal_to` = loaded retiring, `seal_needed = retiring.len()`) and `admission()`
1669 (`if st.seal_needed > 0`). With the old indexer listed as a member (N=1 {a} → {a,b,c} w2, nothing
retiring), the commit seals nothing. If a's admission pin fails, b and c (rq = 2) are admitted and the set is
Stable. a has no record, so the single-indexer configuration is record-less and ready again.

Trace (`traces/P2-legacy-commit-without-seal.steps`, replayed under the snapshot rules into
`traces/P2-legacy-commit-without-seal-replay.txt`; it uses no Legacy-phase write, so P1's fix does not remove it):

```
L1{a}w1 -> restart M3{a,b,c}w2 (all loaded)
-> admission to {a,b,c}w2@1: seals {} (none needed), admits a: failed, b: ok, c: ok     Stable, voters b,c
-> write w0 acknowledged by b,c
-> restart: config L1{a}w1                                                               Legacy(ready): w0 is gone
```

Fix (modelled as `FIX=sealall`): a change from a record-less deployment seals **every** listed replica, and
requires all n of them (`seal_to` = all loaded, `seal_needed` = n). This applies both in Legacy and in the
Pending/prev-None branch (581–582). The old holder is unknown without records, but every replica is loaded at
that point, so this costs one small object per replica. A reverted configuration then finds a seal and waits.

### P3: multipart catch-up accepts a stale part variant

Code:
- `repair_parts` 1473–1477: a non-voter's part is "fine" if *any* source holds the same ETag and size.
- `caught_up` 1561–1566: the same "any variant" test.
- `complete_upload` 1185–1205 and `store.rs` `stage_complete` 1305–1313: the ETag must match.

Parts carry no order, so "any variant" includes an overwritten one.

Trace (`joint_traces.py` MP1, output in `traces/joint_traces.txt`):

```
C={a,b,c}w2 acting, config T={d,e}w2 with a,b,c retiring: Migrating, voters a,b,c, targets a..e
UploadPart(1, X): all five store it                                -> acknowledged
UploadPart(1, Y) (same number, other bytes): a,b store it; c,d,e fail   -> 2 of 2 needed: acknowledged, client keeps Y
source variants of part 1: Y on a,b; X on c
repair_parts: d,e hold X, "a variant a source holds" -> kept;  caught_up(d,e): ok
commit: seal a,b,c; admit d,e -> Stable {d,e}; retiring replicas are no longer targets
CompleteMultipartUpload([(1, Y)]): d and e both answer InvalidPart -> the acknowledged part is lost
```

Under C the same completion succeeds, because a and b hold Y. The loss comes from the change.

Fix:
- Minimal: `caught_up`/`repair_parts` refuse while the sources hold more than one variant of a part. The commit
  waits until the client completes or aborts. With a single variant among the sources (≥ rq(acting) voters, which
  meet every acknowledging W set), that variant is the newest acknowledged one.
- Better: give parts an order. Add an optional `h` to `PartTag` and stamp it, which makes UploadPart a fifth B4
  `stamp()` site. `PartTag` has no `deny_unknown_fields`, so old readers ignore the field. Then require the
  highest-`h` variant.

### P4: same-epoch disagreement is a permanent Refused (safe, but no recovery path)

Code: `membership()` 524–528. Any two records at the top epoch with different `d` or `p` give Refused, whatever
the configuration. Only deleting a record object by hand recovers, and no tool for that exists.

(a) Legacy (`traces/P1-P4a-legacy-snapshot-bfs.txt`):

```
L1{a}w1: first pass admits {a}@1, abandoned
-> restart M{b,c}w2 + a retiring, all loaded: record-less commit at epoch 1 (seal a, admit b,c) -> Stable
-> the abandoned admit({a}@1) lands on a -> epoch 1 holds {a}w1 and {b,c}w2 -> Refused
```

(b) Recorded (BFS, recorded universe):

```
C={a,b,c}w2 -> config T1{a,b,d} (c retiring), loaded {a,b,d}
-> admission: seal to a fails, seal to b acknowledged -> 1 of 2 durable, stop (Pending)
-> restart: config T2{a,c,d} (b retiring) while b is down; loaded {a,c,d}: only epoch 1 visible -> Migrating C->T2@2
-> commit T2@2 (seals a,c; admits a,c,d) -> Stable
-> b comes back (or any configuration loads b) -> epoch 2 holds seal(T1) and T2 records -> Refused, permanently
```

The Refused is safe: nothing is served. A running Stable cluster still goes down the moment b is loaded again, and
the only remedy is to unlist b for good. The reason text ("configure that set again") does not apply to this case.

What not to do: making epochs unique, for example by stamping them with B4 versions, reopens a lost write.
- Trace `traces/S1-stamped-epochs-are-unsafe.steps`, under `FIX=legacy,sealall,stamp`.
- The N=1 auto-admit has no seal barrier, so its late arrival at a *higher* epoch revives {a}.
- The snapshot's fixed epoch 1 for record-less changes is what turns that collision into a (safe) Refused.

Recommended mitigation for (b) (modelled as `FIX=resolve`): when the top epoch disagrees **and every record there
names a previous set**, act on the one membership that has admissions, if exactly one does, and ignore the
seal-only records of the others.

Argument for that rule (one writer, fail-stop): a recorded change writes admissions only after w(prev)
acknowledged seals. Any later writer acting under prev loads rq(prev) admitted members of prev, which meet those
seals, so it cannot start a second change at that epoch. Hence at most one membership per epoch ever has
admissions. The rule does not apply to record-less (prev = None) records, so (a) stays a Refused. For (a),
document it and ship an operator recovery step (delete the stray `{a}@1` admit after checking that `{b,c}@1` has
rq admissions).

### P5: B4 joint points (safety once merged)

These are not bugs in either tree as they stand. They are what a naive merge breaks. The exact rules are in the
handoff. Traces are in `traces/joint_traces.txt`. Each trace runs under the rule as written, then under the
proposed rule.

| Trace | B4/merge rule as written | Outcome | With the rule |
|---|---|---|---|
| M1 | `ensure_range` fans to `loaded()` and counts against `writeQuorum`. In Migrating {a}→{b,c}, voters={a}, need=1, W=2, so acks from b,c count. | Writer 1 stamps under a ceiling only non-voters hold. The change is called off and writer 2 boots from {a}, with its clock 2 h behind. Writer 1's abandoned PUT lands on a and undoes writer 2's acknowledged DELETE. | Count `votes()` among `targets()` against `need()`, and re-check `acting`. The range is refused, so nothing is stamped. |
| M2 | Admission does not look at ceilings. | The new members are admitted without writer 1's ceiling and a is removed. Writer 2 boots from {b,c} with observed = 0, and the abandoned PUT undoes its DELETE. | `caught_up` needs `ceiling ≥ max(own ceiling, fresh max over loaded)`. Writer 2 starts above it, and the DELETE stands. |
| M2-live | `ceilings()` returns while this process's ceiling is 0, and `ensure_range` cannot run while not ready. | After a restart in Pending, the new member never gets a ceiling. M2 never passes, so the cluster is never served. | Copy `max(ceiling, observed)` to the backfill targets regardless of who reserved. |
| RC | M2 is checked once. `ensure_range` runs outside the write lock while admission awaits its pins. | A reservation completes during the commit, counted against the *old* voters. The request stamps under the new set, a later boot from the new set misses that ceiling, and the DELETE is undone. | Admission holds `reserving` (taken before `write`) through its final rebuild. |

M3 needs no change, and must not be narrowed: observed is the maximum over **all** loaded replicas.

### P6: minor items

- **Comment at 1692.** It says "the old set no longer acts once any seal may exist". That holds only while a
  sealed replica is loaded. A restart that does not load it lets the old set act again. That is safe by quorum
  intersection (the model confirms it), but the comment should say so. An abandoned seal is not a barrier until it
  lands and is loaded.
- **Dropped members.** If more than w(acting) − 1 members are dropped outright rather than listed as retiring,
  the state is Waiting forever with "waiting for the others". That is safe, but the reason should name the
  missing members and say to list them as `retiring`.
- **Boot loop.** It runs maintenance only while `pending()` (main.rs 120–129). P1's fix needs it for record-less
  N>1 as well. The B4 copy (M2-live) must run in that loop too, before `admission()`.
- **Rollback to 54818ba.** 54818ba classifies objects with neither e, d, lg, mf nor mp as orphans (54818ba
  `store.rs` 495–512), and `sweep()` deletes orphans older than a day (1393–1406). Membership records (`ms`) and
  B4 ceilings (`ck`) are both such objects. A rollback lasting more than a day erases them, and the roll-forward
  is then in P1/P2 territory. Document "no rollback below the membership build", or teach a 0.2.x point release
  both purposes.
- **`Index::complete()` with B2.** A superseded unread manifest delays admission by one pass until `purge_dead`.
  That is safe. The handoff gives the optional predicate.

## What holds (bounded model results)

[MODEL-RESULTS]

## Reproduce

```
cd work/storage-protocol-audit
PYTHONHASHSEED=0 python3 joint_traces.py                         # MP1, M1, M2, M2-live, RC: "0 unexpected outcomes"
PYTHONHASHSEED=0 python3 ms_model.py legacy:2:-:2                # P1 and P4(a), shortest traces (BFS)
PYTHONHASHSEED=0 python3 ms_model.py recorded:0:C,T1,T2:2        # P4(b), shortest trace (BFS)
PYTHONHASHSEED=0 REPLAY=traces/P2-legacy-commit-without-seal.steps python3 ms_model.py legacy:1:-:2
PYTHONHASHSEED=0 FIX=legacy,sealall,stamp REPLAY=traces/S1-stamped-epochs-are-unsafe.steps python3 ms_model.py legacy:1:-:2
./run_checks.sh                                                  # the bounded checks (one at a time, 190 MB, 15 min each)
```

The universe syntax is `<universe>:<writes>:<configs or ->:<max epoch>`. `FIX` takes a comma list of `legacy`,
`sealall`, `resolve`, `stamp` and `epoch` (each is described at the top of `ms_model.py`). Run each command under
`ulimit -v 190000`.
