#!/usr/bin/env python3
"""Exhaustive bounded model of the revised writer-fencing protocol (work/storage-writer-fencing-proposal.md, §3-§5).

N indexers, all voters, write quorum W, fence quorum P = N - W + 1, read-confirmation quorum Q = W.
Writer A is the old writer: ready, its ballot installed everywhere. Writers B and C are NEW contenders started at the
same time under the same lease, both having observed A's ballot, so both choose the next counter. In the proposed
protocol they differ only by a unique instance id, so their ballots differ (B < C). In the "same" variant they are
identical.

Every request is a message delivered at any later time, and so is every response. Nothing is cancelled. A replica
holds one installed ballot and the register's highest version. Versions are the writer's ballot (B4 orders a newer
writer's versions above an older writer's).

Client operations (at most one each, then the writer is done):
  create  put-if-absent. Success needs W replicas applying the write. If the writer's view is not empty the answer
          is 412, a READ result, which needs a confirmation round.
  read    returns the view's version, after a confirmation round.
Replica rules (proposed):
  raise(b)    install if b > installed; if b == installed answer ok (an idempotent retry); else refuse with the
              installed ballot. ok carries the replica's value AT INSTALL (the seq snapshot).
  write(b)    apply only if b == installed exactly; else 409 with the installed ballot.
  confirm(b)  answer the installed ballot.
Writer rules: a refusal or 409 naming a HIGHER ballot stops it for good (no further answers). A contender is ready
after P ok raises. Its view is the highest version among those snapshots. A confirmation needs Q answers equal to
its ballot.

Linearizability checks on the history (versions are unique per writer, so they identify writes):
  DOUBLE    two creates both answered success.
  STALE     an answer (a read or 412) observed version v, while a create with a version != v answered success
            before that operation was invoked. With put-if-absent the register never changes after the first
            successful create.
  REGRESS   an answer observed nothing (absent) after another operation that completed before it observed a value.
  LOST      a contender became ready with a view lacking a create that answered success before readiness.
Variants: proposed | same (no unique id) | noconfirm (reads answered from the view) | smallP (P = N - W)
          | geq (writes accepted if b >= installed, not exact).
"""
import sys
from collections import deque

SCENARIOS = {
    # S1 conflicting creates: the old writer and both contenders try put-if-absent
    "S1": {"A": ("create",), "B": ("create",), "C": ("create",)},
    # S2 stale reads: the old writer reads, a contender creates and the other reads
    "S2": {"A": ("read",), "B": ("create",), "C": ("read",)},
    # S3 takeover: the old writer creates then reads; one contender creates and reads (C only raises)
    "S3": {"A": ("create", "read"), "B": ("create", "read"), "C": ()},
    # lighter scenarios for N = 3 with W = 2, 3 (the three-writer ones exceed the state table there)
    # S4 two new contenders, same lease, same observed maximum, both creating (A idle)
    "S4": {"A": (), "B": ("create",), "C": ("create",)},
    # S5 the old writer reads while a new contender creates
    "S5": {"A": ("read",), "B": ("create",), "C": ()},
    # S6 the old writer's create (its acknowledgement may arrive after the new boot) against the new writer's read
    "S6": {"A": ("create",), "B": ("read",), "C": ()},
}

def run(N, W, variant, scen="S1", limit=12_000_000):
    OPS = SCENARIOS[scen]
    P = N - W + 1 - (1 if variant == "smallP" else 0)
    if P < 1:
        return None, "n/a (P < 1)", None
    Q = W
    BAL = {"A": 1, "B": 2, "C": 2 if variant == "same" else 3}
    # replica: (installed, value)  value = 0 none, else the ballot of the writer whose create it holds
    reps0 = tuple((1, 0) for _ in range(N))
    # writer: (phase, oks, view, op, opcount, cnt, done_ops)
    #   phase: 0 idle (contender not started), 1 raising, 2 ready, 3 stopped
    #   op: None | ("create", invoked_at) | ("412", invoked_at) | ("read", invoked_at)
    ws0 = {"A": (2, frozenset(range(N)), 0, None, 0, frozenset()), "B": (0, frozenset(), 0, None, 0, frozenset()),
           "C": (0, frozenset(), 0, None, 0, frozenset())}
    names = ("A", "B", "C")
    start = (reps0, tuple(ws0[n] for n in names), frozenset(), ())
    # state: (replicas, writers, inflight messages, history, clock)
    # history entries: (kind, writer, invoked, answered, observed_version)  kind in create_ok | read | 412

    def bad(state):
        hist = state[3]
        oks = [h for h in hist if h[0] == "create_ok"]
        if len(oks) >= 2:
            return f"DOUBLE: put-if-absent creates of {oks[0][1]} and {oks[1][1]} both succeeded"
        for h in hist:
            if h[0] in ("read", "412"):
                for w in h[2]:
                    if h[4] != BAL[w]:
                        return f"STALE: {h[1]}'s {h[0]} observed {h[4] or 'nothing'}, invoked after {w}'s create (version {BAL[w]}) had succeeded"
                if h[3] and not h[4]:
                    return f"REGRESS: {h[1]}'s {h[0]} observed nothing, invoked after another operation had completed observing a value"
        return None

    def invoke_ctx(hist):
        known = frozenset(h[1] for h in hist if h[0] == "create_ok")
        seen = any(h[0] == "create_ok" or h[4] for h in hist)
        return known, seen

    def W_of(ws, n):
        return ws[names.index(n)]

    def set_w(ws, n, v):
        l = list(ws); l[names.index(n)] = v; return tuple(l)

    def steps(state):
        reps, ws, infl, hist = state
        out = []
        for n in names:
            phase, oks, view, op, opcount, done = W_of(ws, n)
            b = BAL[n]
            if n != "A" and phase == 0:
                msgs = frozenset(("raise", n, r) for r in range(N))
                out.append((f"{n} starts: raise({b}) sent to all", (reps, set_w(ws, n, (1, frozenset(), 0, None, opcount, done)), infl | msgs, hist)))
            if phase == 2 and op is None:
                ctx = invoke_ctx(hist)
                if "create" in OPS[n] and "create" not in done:
                    if view:
                        if variant == "noconfirm":
                            out.append((f"{n} create -> 412 (view {view}, unconfirmed)", (reps, set_w(ws, n, (phase, oks, view, None, opcount + 1, done | {"create"})), infl, hist + (("412", n, ctx[0], ctx[1], view),))))
                        else:
                            msgs = frozenset(("confirm", n, r, opcount + 1) for r in range(N))
                            out.append((f"{n} create: view has {view}, confirming before 412", (reps, set_w(ws, n, (phase, frozenset(), view, ("412", ctx), opcount + 1, done | {"create"})), infl | msgs, hist)))
                    else:
                        msgs = frozenset(("write", n, r, opcount + 1) for r in range(N))
                        out.append((f"{n} create: view empty, write({b}) sent to all", (reps, set_w(ws, n, (phase, frozenset(), view, ("create", ctx), opcount + 1, done | {"create"})), infl | msgs, hist)))
                if "read" in OPS[n] and "read" not in done:
                    if variant == "noconfirm":
                        out.append((f"{n} read -> {view or 'nothing'} (unconfirmed)", (reps, set_w(ws, n, (phase, oks, view, None, opcount + 1, done | {"read"})), infl, hist + (("read", n, ctx[0], ctx[1], view),))))
                    else:
                        msgs = frozenset(("confirm", n, r, opcount + 1) for r in range(N))
                        out.append((f"{n} read: confirming", (reps, set_w(ws, n, (phase, frozenset(), view, ("read", ctx), opcount + 1, done | {"read"})), infl | msgs, hist)))
        for m in sorted(infl, key=repr):
            rest = infl - {m}
            kind = m[0]
            if kind in ("raise", "write", "confirm"):
                n, r = m[1], m[2]
                b = BAL[n]
                inst, val = reps[r]
                if kind == "raise":
                    if b > inst or b == inst:
                        nr = list(reps); nr[r] = (b, val)
                        resp = ("raise_ok", n, r, val)
                        out.append((f"replica {r} installs {n}'s ballot {b}" + (" (equal: idempotent)" if b == inst else ""), (tuple(nr), ws, rest | {resp}, hist)))
                    else:
                        out.append((f"replica {r} refuses {n}'s raise({b}): installed {inst}", (reps, ws, rest | {("raise_no", n, r, inst)}, hist)))
                elif kind == "write":
                    okw = (b == inst) if variant != "geq" else (b >= inst)
                    if okw:
                        nr = list(reps); nr[r] = (inst, max(val, b))
                        out.append((f"replica {r} applies {n}'s write({b})", (tuple(nr), ws, rest | {("write_ok", n, r, m[3])}, hist)))
                    else:
                        out.append((f"replica {r} answers 409 to {n}'s write({b}): installed {inst}", (reps, ws, rest | {("write_no", n, r, inst, m[3])}, hist)))
                else:
                    out.append((f"replica {r} answers {n}'s confirm: installed {inst}", (reps, ws, rest | {("conf", n, r, inst, m[3])}, hist)))
            else:
                n = m[1]
                phase, oks, view, op, opcount, done = W_of(ws, n)
                b = BAL[n]
                if phase == 3:
                    out.append((f"{n} (stopped) drops a response", (reps, ws, rest, hist)))
                    continue
                if kind == "raise_ok" and phase == 1:
                    noks = oks | {m[2]}
                    nview = max(view, m[3])
                    if len(noks) >= P:
                        out.append((f"{n} gets raise ok from {m[2]} (snapshot {m[3]}): READY, view {nview or 'empty'}", (reps, set_w(ws, n, (2, noks, nview, None, opcount, done)), rest, hist)))
                    else:
                        out.append((f"{n} gets raise ok from {m[2]} (snapshot {m[3]})", (reps, set_w(ws, n, (1, noks, nview, None, opcount, done)), rest, hist)))
                elif kind == "raise_no":
                    if m[3] > b:
                        out.append((f"{n} learns ballot {m[3]} > {b}: stops", (reps, set_w(ws, n, (3, oks, view, None, opcount, done)), rest, hist)))
                    else:
                        out.append((f"{n} gets a refusal naming {m[3]}", (reps, ws, rest, hist)))
                elif kind in ("write_ok", "write_no", "conf"):
                    if op is None or m[-1] != opcount:
                        out.append((f"{n} drops a stale response", (reps, ws, rest, hist)))
                        continue
                    if kind == "write_no" or (kind == "conf" and m[3] != b):
                        if m[3] > b:
                            out.append((f"{n} learns ballot {m[3]} > {b}: stops (operation unanswered)", (reps, set_w(ws, n, (3, oks, view, None, opcount, done)), rest, hist)))
                        else:
                            out.append((f"{n} gets {kind} naming {m[3]} (not counted)", (reps, ws, rest, hist)))
                        continue
                    noks = oks | {m[2]}
                    need = W if kind == "write_ok" else Q
                    if len(noks) >= need:
                        if op[0] == "create":
                            h = ("create_ok", n, op[1][0], op[1][1], b)
                            out.append((f"{n}'s create SUCCEEDS (W={W} applied)", (reps, set_w(ws, n, (2, frozenset(), b, None, opcount, done)), rest, hist + (h,))))
                        else:
                            h = (op[0], n, op[1][0], op[1][1], view)
                            out.append((f"{n} answers {op[0]}: observed {view or 'nothing'} (confirmed by {Q})", (reps, set_w(ws, n, (2, frozenset(), view, None, opcount, done)), rest, hist + (h,))))
                    else:
                        out.append((f"{n} counts {kind} from {m[2]}", (reps, set_w(ws, n, (2, noks, view, op, opcount, done)), rest, hist)))
                else:
                    out.append((f"{n} drops {kind}", (reps, ws, rest, hist)))
        return out

    import os
    if os.environ.get("BFS"):
        parent = {start: None}
        dq = deque([start])
        while dq:
            st = dq.popleft()
            why = bad(st)
            if why:
                labels = []
                while parent[st] is not None:
                    st, lab = parent[st]
                    labels.append(lab)
                return len(parent), why, list(reversed(labels))
            for lab, nxt in steps(st):
                if nxt not in parent:
                    parent[nxt] = (st, lab)
                    dq.append(nxt)
            if len(parent) > 1_500_000:
                return len(parent), "STOPPED (BFS limit): NOT exhaustive", None
        return len(parent), None, None
    from array import array
    bits = int(os.environ.get("BITS", "23"))
    mask = (1 << bits) - 1
    table = array("Q", [0]) * (1 << bits)
    count = 0
    def add(st):
        nonlocal count
        k = (hash(st) & 0xFFFFFFFFFFFFFFFF) or 1
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
    path = [(start, None, None)]  # (state, successor list, label)
    try:
        while path:
            s, succ, label = path[-1]
            if succ is None:
                why = bad(s)
                if why:
                    return count, why, [p[2] for p in path[1:]]
                succ = steps(s)
                path[-1] = (s, succ, label)
            while succ:
                lab, nxt = succ.pop()
                if add(nxt):
                    path.append((nxt, None, lab))
                    break
            else:
                path.pop()
            if count > limit:
                return count, "STOPPED at the state limit: NOT exhaustive", None
    except MemoryError as e:
        return count, f"STOPPED ({e}): NOT exhaustive", None
    return count, None, None

if __name__ == "__main__":
    import resource
    args = sys.argv[1:]
    scens = [a for a in args if a.startswith("S")] or ["S1", "S2", "S3"]
    variants = [a for a in args if not a[0].isdigit() and not a.startswith("S")] or ["proposed", "same", "noconfirm", "smallP", "geq"]
    configs = [tuple(map(int, a.split(","))) for a in args if a[0].isdigit()] or [(1, 1), (2, 1), (2, 2), (3, 1), (3, 2), (3, 3)]
    for v in variants:
      for sc in scens:
        for N, W in configs:
            n, why, trace = run(N, W, v, sc)
            if n is None:
                print(f"== {v} {sc} N={N} W={W}: {why}")
                continue
            print(f"== {v} {sc} N={N} W={W}: {n} states: " + ("no violation (exhaustive within bounds)" if why is None else why), flush=True)
            if trace:
                for k, label in enumerate(trace, 1):
                    print(f"   {k:2}. {label}")
    print(f"peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MiB")
