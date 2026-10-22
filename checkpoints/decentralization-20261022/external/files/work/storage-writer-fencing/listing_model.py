#!/usr/bin/env python3
"""Can a paginated listing of one account's objects on one indexer be trusted to be complete and consistent?

Exhaustive interleavings of a small account. Each listing strategy is checked against two properties:
  COMPLETE  every object state committed before the listing started is reflected: its key is present with that
            version or a newer one, or deleted by a later committed delete.
  SNAPSHOT  the resulting view equals the account's committed state at one instant during the listing.

Strategies:
  L0  indexd 0.6.0: pages of (updated_at, key) > cursor over published rows only (objects.go 198-205).
  L1  the rejected earlier proposal: L0 until an empty page, then the account's unpublished (NULL) rows.
  L2  the proposed per-account commit sequence: every mutation of the account takes seq = account.event_seq + 1 under
      the account row lock, held to commit. Pages are seq > cursor, until an empty page.

The indexd publisher (objects.go 508-560) assigns one new position, greater than every existing one, to a batch of
NULL rows ordered by key. The batch limit is modelled as 1 to cover overflow and skipped locked rows. Page size is 1.
Concurrent mutations model the writer's own writes during an in-process re-read. A boot under the fence has none.
"""
import sys
from collections import deque, namedtuple

KEYS = ("a", "b")
St = namedtuple("St", "rows pubpos seq cursor phase view snaps muts started pre")
# rows: tuple per key of (version, deleted, pos or None, seq). version 0 = never existed.
# phase: 0 not started, 1 published traversal, 2 NULL tail (L1), 3 done.
# view: tuple per key of (version, deleted) or None. snaps: committed states seen during the listing.

def state_of(rows):
    return tuple((v, d) if v else None for (v, d, _, _) in rows)

def init(pre):
    # pre: committed before the listing. a: published v1. b: committed v1, still unpublished.
    rows = (
        (1, False, 1, 1),
        (1, False, None, 2),
    ) if pre == "unpub" else (
        (1, False, 1, 1),
        (1, False, 1, 2),
    )
    return St(rows, 1, 2, (0, ""), 0, (None, None), frozenset(), 0, False, None)

def mutate(s, k, delete):
    i = KEYS.index(k)
    v, d, pos, sq = s.rows[i]
    rows = list(s.rows)
    rows[i] = (v + 1 if not delete else v, delete, None, s.seq + 1)
    ns = s._replace(rows=tuple(rows), seq=s.seq + 1, muts=s.muts + 1)
    return ns._replace(snaps=ns.snaps | {state_of(ns.rows)}) if ns.started and ns.phase < 3 else ns

def steps(s, strat, max_muts):
    out = []
    if s.phase < 3:
        nulls = [i for i, r in enumerate(s.rows) if r[2] is None and r[0]]
        if nulls:
            i = min(nulls)  # one row per batch (batch limit / SKIP LOCKED), key order
            rows = list(s.rows); v, d, _, sq = rows[i]; rows[i] = (v, d, s.pubpos + 1, sq)
            out.append((f"publisher: {KEYS[i]} gets position {s.pubpos + 1}", s._replace(rows=tuple(rows), pubpos=s.pubpos + 1)))
        if s.muts < max_muts:
            for k in KEYS:
                out.append((f"commit re-pin {k}", mutate(s, k, False)))
                out.append((f"commit delete {k}", mutate(s, k, True)))
    if s.phase == 0:
        out.append(("listing starts", s._replace(phase=1, started=True, snaps=frozenset({state_of(s.rows)}), pre=state_of(s.rows))))
    elif s.phase in (1, 2):
        out.append(("listing: next page", page(s, strat)))
    return out

def page(s, strat):
    view = list(s.view)
    if strat in ("L0", "L1") and s.phase == 1:
        cands = sorted(((r[2], KEYS[i]), i) for i, r in enumerate(s.rows) if r[2] is not None and r[0] and (r[2], KEYS[i]) > s.cursor)
        if not cands:
            return s._replace(phase=2 if strat == "L1" else 3)
        (cur, i) = cands[0]
        v, d, _, _ = s.rows[i]
        view[i] = (v, d)
        return s._replace(view=tuple(view), cursor=cur)
    if strat == "L1" and s.phase == 2:
        for i, r in enumerate(s.rows):
            if r[2] is None and r[0]:
                view[i] = (r[0], r[1])
        return s._replace(view=tuple(view), phase=3)
    if strat == "L2":
        cands = sorted((r[3], i) for i, r in enumerate(s.rows) if r[0] and r[3] > s.cursor[0])
        if not cands:
            return s._replace(phase=3)
        sq, i = cands[0]
        v, d, _, _ = s.rows[i]
        view[i] = (v, d)
        return s._replace(view=tuple(view), cursor=(sq, ""))
    raise AssertionError

def check(s, _unused):
    if s.phase != 3:
        return None
    for i, want in enumerate(s.pre):
        got = s.view[i]
        later_delete = got is not None and got[1] and got[0] >= want[0] if want is not None else False
        if want is not None and not later_delete and (got is None or got[0] < want[0] or (got[1] and not want[1] and got[0] < want[0])):
            return f"COMPLETE violated: {KEYS[i]} committed before the listing as v{want[0]}, view has {got}"
    if s.view not in s.snaps:
        return f"SNAPSHOT violated: view {s.view} equals no committed state during the listing {sorted(s.snaps)}"
    return None

def run(strat, pre, max_muts):
    start = init(pre)
    pre_state = state_of(start.rows)
    parent = {start: None}
    q = deque([start])
    while q:
        s = q.popleft()
        bad = check(s, pre_state)
        if bad:
            path = []
            while parent[s] is not None:
                s, label = parent[s]
                path.append(label)
            return len(parent), bad, list(reversed(path))
        for label, t in steps(s, strat, max_muts):
            if t not in parent:
                parent[t] = (s, label)
                q.append(t)
    return len(parent), None, None

if __name__ == "__main__":
    import resource
    cases = [("L0", "unpub", 0), ("L1", "unpub", 0), ("L1", "pub", 1), ("L2", "unpub", 0), ("L2", "unpub", 2), ("L2", "pub", 3)]
    for strat, pre, muts in cases:
        n, bad, trace = run(strat, pre, muts)
        print(f"== {strat}, before the listing: a published v1, b {'UNPUBLISHED' if pre == 'unpub' else 'published'} v1; "
              f"concurrent mutations <= {muts}: {n} states")
        if bad:
            print(f"   {bad}")
            for k, label in enumerate(trace, 1):
                print(f"   {k:2}. {label}")
        else:
            print("   COMPLETE and SNAPSHOT hold in every interleaving (exhaustive within these bounds)")
    print(f"peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MiB")
