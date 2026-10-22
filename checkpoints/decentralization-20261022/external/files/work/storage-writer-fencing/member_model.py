#!/usr/bin/env python3
"""Fencing across a membership change (proposal §6). Exhaustive within bounds; arbitrary delays, late answers.

Three indexers 0, 1, 2. The acting set is C = {0, 1} (W = 2, so rq = 1), and the configured set is T = {1, 2} (W = 2,
rq = 1). Replica 2 is a member being added; replica 0 is retiring.

Old writer A (ballot 1, installed on all three, ready, acting C) may:
  create  put-if-absent, acknowledged by W(acting) voters of its acting set; and
  commit  B1's change, with every record and copy carried as a fenced mutation (exact ballot):
          - seal(e2) to every C voter; it needs W(C) = 2 acknowledgements;
          - then admit(e2) to every T member, each carrying A's current view as its caught-up copy; it needs all of T.
          After the last admission A acts under T.
New contender B (ballot 2) raises on all three. Each ok carries the replica's (value, record) at install. B computes
its acting set from those records (B1 rules, reduced):
  - an admission seen gives T;
  - a seal without an admission gives Pending, and B does not serve;
  - nothing gives C.
B is ready once its installed oks cover rq(acting) voters of that set. It then creates or reads, with quorums over its
acting set, and a read confirms on W(acting) voters.
Checks: DOUBLE (two successful creates), STALE (a read or 412 observing other than an earlier successful create),
LOST (B ready with a view lacking a create that had succeeded).
Variants: proposed | nofence_commit (A's seal/admit/copy records ignore fences, i.e. records as plain pins)
          | loaded_quorum (B's readiness counts any rq voters of C among oks, ignoring what it computed as acting)
"""
import sys
from collections import deque

C, T = frozenset({0, 1}), frozenset({1, 2})
WQ = {C: 2, T: 2}
RQ = {C: 1, T: 1}

def run(variant, scen):
    # replica: (installed, value, rec) rec 0 none, 1 sealed, 2 admitted
    reps0 = ((1, 0, 0), (1, 0, 0), (1, 0, 0))
    # A: (acting, stage, acks, view, op, done)  stage: 0 normal, 1 sealing, 2 admitting, 9 stopped
    # B: (phase, oks, snaps, op, acks, view, acting, done)  phase 0 idle, 1 raising, 2 ready, 3 stopped, 4 pending
    A0 = (C, 0, frozenset(), 0, None, frozenset())
    B0 = (0, frozenset(), (), None, frozenset(), 0, None, frozenset())
    start = (reps0, A0, B0, frozenset(), ())
    opsA = {"create", "commit"} if scen == "M1" else {"commit"}
    opsB = {"create"} if scen == "M1" else {"read"}

    def bad(st):
        hist = st[4]
        oks = [h for h in hist if h[0] == "ok"]
        if len(oks) >= 2:
            return "DOUBLE: both creates succeeded"
        for h in hist:
            if h[0] in ("read", "412"):
                for w in h[2]:
                    if h[3] != {"A": 1, "B": 2}[w]:
                        return f"STALE: B's {h[0]} observed {h[3] or 'nothing'} after {w}'s create succeeded"
        return None

    def acting_of(snaps):
        recs = [r for (_, _, r) in snaps]
        if 2 in recs:
            return T
        if 1 in recs:
            return None  # Pending
        return C

    def steps(st):
        reps, A, B, infl, hist = st
        out = []
        known = frozenset(h[1] for h in hist if h[0] == "ok")
        act, stage, acks, view, op, done = A
        if stage == 0 and op is None:
            if "create" in opsA and "create" not in done and not view:
                out.append(("A create: write(1) to all", (reps, (act, 0, frozenset(), view, ("create", known), done | {"create"}), B,
                            infl | {("w", "A", r) for r in range(3)}, hist)))
            if "commit" in opsA and "commit" not in done and act == C and (op is None):
                out.append(("A commit: seal(e2) to C voters", (reps, (act, 1, frozenset(), view, None, done | {"commit"}), B,
                            infl | {("seal", "A", r) for r in C}, hist)))
        bp, boks, bsnaps, bop, backs, bview, bact, bdone = B
        if bp == 0:
            out.append(("B starts: raise(2) to all", (reps, A, (1,) + B[1:], infl | {("raise", "B", r) for r in range(3)}, hist)))
        if bp == 2 and bop is None:
            if "create" in opsB and "create" not in bdone:
                if bview:
                    out.append(("B create: view non-empty, confirm before 412", (reps, A, (2, boks, bsnaps, ("412", known), frozenset(), bview, bact, bdone | {"create"}),
                                infl | {("conf", "B", r) for r in bact}, hist)))
                else:
                    out.append(("B create: write(2) to all", (reps, A, (2, boks, bsnaps, ("create", known), frozenset(), bview, bact, bdone | {"create"}),
                                infl | {("w", "B", r) for r in range(3)}, hist)))
            if "read" in opsB and "read" not in bdone:
                out.append(("B read: confirm", (reps, A, (2, boks, bsnaps, ("read", known), frozenset(), bview, bact, bdone | {"read"}),
                            infl | {("conf", "B", r) for r in bact}, hist)))
        for m in sorted(infl):
            rest = infl - {m}
            kind, who, r = m[0], m[1], m[2]
            b = 1 if who == "A" else 2
            inst, val, rec = reps[r]
            if kind in ("w", "seal", "admit", "raise", "conf"):
                nr = list(reps)
                exact = b == inst
                if kind == "raise":
                    if b > inst:
                        nr[r] = (b, val, rec)
                        out.append((f"replica {r} installs B (snapshot value {val}, record {rec})", (tuple(nr), A, B, rest | {("rok", who, r, val, rec)}, hist)))
                    else:
                        out.append((f"replica {r} refuses B", (reps, A, B, rest | {("rno", who, r, inst)}, hist)))
                    continue
                if kind == "conf":
                    out.append((f"replica {r} confirms installed {inst} to {who}", (reps, A, B, rest | {("cf", who, r, inst)}, hist)))
                    continue
                fence_ok = exact or (variant == "nofence_commit" and kind in ("seal", "admit"))
                if not fence_ok:
                    out.append((f"replica {r} answers 409 to {who}'s {kind}", (reps, A, B, rest | {("no", who, r, inst, kind)}, hist)))
                    continue
                if kind == "w":
                    nr[r] = (inst, max(val, b), rec)
                elif kind == "seal":
                    nr[r] = (inst, val, max(rec, 1))
                else:  # admit carries A's caught-up copy (m[3])
                    nr[r] = (inst, max(val, m[3]), 2)
                out.append((f"replica {r} applies {who}'s {kind}", (tuple(nr), A, B, rest | {("ok", who, r, kind)}, hist)))
                continue
            # answers to writers
            if who == "A":
                act, stage, acks, view, op, done = A
                if stage == 9:
                    out.append(("A (stopped) drops an answer", (reps, A, B, rest, hist)))
                    continue
                if kind == "no":
                    if m[3] > 1:
                        out.append((f"A learns ballot {m[3]}: stops", (reps, (act, 9, acks, view, None, done), B, rest, hist)))
                    else:
                        out.append(("A ignores 409", (reps, A, B, rest, hist)))
                    continue
                if kind == "ok":
                    what = m[3]
                    nacks = acks | {r}
                    if what == "w" and op and op[0] == "create":
                        if len(nacks & act) >= WQ[act]:
                            h = ("ok", "A", op[1])
                            out.append(("A's create SUCCEEDS", (reps, (act, stage, frozenset(), 1, None, done), B, rest, hist + (h,))))
                        else:
                            out.append(("A counts a write ack", (reps, (act, stage, nacks, view, op, done), B, rest, hist)))
                    elif what == "seal" and stage == 1:
                        if len(nacks & C) >= WQ[C]:
                            out.append(("A: W(C) seals durable; admit(e2)+copy to T", (reps, (act, 2, frozenset(), view, op, done), B,
                                        rest | {("admit", "A", rr, view) for rr in T}, hist)))
                        else:
                            out.append(("A counts a seal", (reps, (act, 1, nacks, view, op, done), B, rest, hist)))
                    elif what == "admit" and stage == 2:
                        if nacks >= T:
                            out.append(("A: every T member admitted, acts under T", (reps, (T, 0, frozenset(), view, op, done), B, rest, hist)))
                        else:
                            out.append(("A counts an admission", (reps, (act, 2, nacks, view, op, done), B, rest, hist)))
                    else:
                        out.append(("A drops a stale ack", (reps, A, B, rest, hist)))
                    continue
                out.append((f"A drops {kind}", (reps, A, B, rest, hist)))
                continue
            bp, boks, bsnaps, bop, backs, bview, bact, bdone = B
            if bp in (3, 4):
                out.append(("B (not serving) drops an answer", (reps, A, B, rest, hist)))
                continue
            if kind == "rok" and bp == 1:
                noks = boks | {r}
                nsn = bsnaps + ((r, m[3], m[4]),)
                a = acting_of([(x, y, z) for (x, y, z) in nsn])
                if a is None:
                    out.append(("B sees a seal without admission: Pending (does not serve)", (reps, A, (4,) + B[1:], rest, hist)))
                    continue
                cover = noks & (C if variant == "loaded_quorum" else a)
                need = RQ[C] if variant == "loaded_quorum" else RQ[a]
                if len(cover) >= need:
                    v = max(y for (_, y, _) in nsn)
                    out.append((f"B ok from {r}: READY acting {'T' if a == T else 'C'}, view {v or 'empty'}",
                                (reps, A, (2, noks, nsn, None, frozenset(), v, a, bdone), rest, hist)))
                else:
                    out.append((f"B ok from {r}", (reps, A, (1, noks, nsn, None, frozenset(), bview, bact, bdone), rest, hist)))
                continue
            if kind == "rno":
                out.append(("B refused by a higher ballot: stops" if m[3] > 2 else "B refused", (reps, A, (3,) + B[1:] if m[3] > 2 else B, rest, hist)))
                continue
            if bp == 2 and bop is not None and kind in ("ok", "cf"):
                if kind == "cf" and m[3] != 2:
                    out.append(("B confirm mismatch", (reps, A, B, rest, hist)))
                    continue
                nacks = backs | {r}
                need = WQ[bact]
                if len(nacks & bact) >= need:
                    if bop[0] == "create":
                        h = ("ok", "B", bop[1])
                        out.append(("B's create SUCCEEDS", (reps, A, (2, boks, bsnaps, None, frozenset(), 2, bact, bdone), rest, hist + (h,))))
                    else:
                        h = (bop[0], "B", bop[1], bview)
                        out.append((f"B answers {bop[0]}: {bview or 'nothing'}", (reps, A, (2, boks, bsnaps, None, frozenset(), bview, bact, bdone), rest, hist + (h,))))
                else:
                    out.append(("B counts an answer", (reps, A, (2, boks, bsnaps, bop, nacks, bview, bact, bdone), rest, hist)))
                continue
            out.append((f"B drops {kind}", (reps, A, B, rest, hist)))
        return out

    import os
    from array import array
    bits = int(os.environ.get("BITS", "24"))
    mask = (1 << bits) - 1
    table = array("Q", [0]) * (1 << bits)
    count = 0
    def add(x):
        nonlocal count
        k = (hash(x) & 0xFFFFFFFFFFFFFFFF) or 1
        i = k & mask
        while True:
            v = table[i]
            if v == 0:
                if count > mask * 0.7:
                    raise MemoryError("state table full")
                table[i] = k; count += 1
                return True
            if v == k:
                return False
            i = (i + 1) & mask
    add(start)
    path = [(start, None, None)]
    try:
        while path:
            st, succ, lab = path[-1]
            if succ is None:
                why = bad(st)
                if why:
                    return count, why, [p[2] for p in path[1:]]
                succ = steps(st)
                path[-1] = (st, succ, lab)
            while succ:
                l2, nxt = succ.pop()
                if add(nxt):
                    path.append((nxt, None, l2))
                    break
            else:
                path.pop()
    except MemoryError as e:
        return count, f"STOPPED ({e}): NOT exhaustive", None
    return count, None, None

if __name__ == "__main__":
    import resource
    for variant in sys.argv[1:] or ["proposed", "nofence_commit", "loaded_quorum"]:
        for scen in ("M1", "M2"):
            n, why, trace = run(variant, scen)
            what = {"M1": "A creates and commits C->T; B creates", "M2": "A commits C->T; B reads"}[scen]
            print(f"== {variant} {scen} ({what}): {n} states: " + ("no violation (exhaustive within bounds)" if why is None else why), flush=True)
            if trace:
                for k, lab in enumerate(trace, 1):
                    print(f"   {k:2}. {lab}")
    print(f"peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MiB")
