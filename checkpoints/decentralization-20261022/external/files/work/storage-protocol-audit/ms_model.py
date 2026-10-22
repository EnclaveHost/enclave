#!/usr/bin/env python3
"""Deterministic model of the sia-s3 membership protocol (snapshot replica.rs, taken 2026-10-19T19:16:59-07:00).

A transcription of Cluster::membership() and Cluster::admission()/admissible()/caught_up()/view_complete() at
record granularity, plus an exhaustive bounded explorer. Model only: one writer, fail-stop indexers, acknowledged
pins durable, abandoned pins that may land at any later time. It proves nothing about concurrent writers or Byzantine
indexers, and nothing beyond its bounds.

Abstractions (each one only makes the model MORE adversarial for the property checked):
  - a "write" is any acknowledged mutation (PUT, DELETE floor, part); it is held by exactly the `need` voters that
    acknowledged it (no extra copies), and only ever added to a replica (repair copies one write at a time);
  - unacknowledged writes are left out: they cannot make an acknowledged write disappear from the view;
  - a restart may pick any configuration from the universe and any non-empty subset of the listed replicas as loaded
    (boot order is arbitrary; attach never unloads, so every running state is some restart state);
  - every record pin of an admission pass either succeeds, fails, or is abandoned (and may land later).
Checked: whenever membership() says ready, the merged view (union of loaded replicas) holds every acknowledged write.
Reported separately: reachable Refused states whose top-epoch records disagree (no configuration recovers them).
"""
import sys
from collections import namedtuple, deque
from itertools import combinations, product

Def = namedtuple("Def", "s w m")  # m: sorted tuple of member names
Rec = namedtuple("Rec", "k d p")  # k: "a" | "s"
Cfg = namedtuple("Cfg", "name members w retiring")  # configured order: members, then retiring

import os
FIX = set(filter(None, os.environ.get("FIX", "").split(",")))
# FIX=legacy  : a record-less N>1 configuration is never ready (writes wait for the commit's records)
# FIX=epoch   : the record-less N>1 commit uses epoch 2, never the N=1 auto-admit's epoch 1
# FIX=sealall : a change from a record-less deployment seals EVERY listed replica (all n), not only retiring ones
# FIX=stamp   : a change's epoch is a fresh number above every epoch ever issued (B4 version stamps give this
#               across writers whose boot sets meet the previous writer's ceiling quorum; the model idealizes it)
# FIX=resolve : at the top epoch, if every record names a previous set and exactly one membership has
#               admissions, seal-only records of the others are void

def rq(d):
    return len(d.m) + 1 - d.w

def listed(cfg):
    return cfg.members + cfg.retiring

# ---------------------------------------------------------------- membership() (replica.rs 481-598)
def membership(cfg, recs):
    """recs: dict loaded replica -> frozenset(Rec). Returns a dict mirroring MsState."""
    reps = listed(cfg)
    n = len(reps)
    target = Def(2 if ("epoch" in FIX and n > 1) else 1, cfg.w, tuple(sorted(cfg.members)))
    loaded = [r for r in reps if r in recs]
    retiring = list(cfg.retiring)
    st = dict(phase="Loading", ready=False, voters=(), need=cfg.w, acting=None, target=target, prev=None,
              sources=(), sources_needed=0, seal_to=(), seal_needed=0, commit=False, why="")
    if not loaded:
        return st
    tops = [r.d.s for i in loaded for r in recs[i]]
    if not tops:
        st.update(phase="Legacy", commit=True, sources=tuple(loaded))
        if n == 1:
            st.update(sources_needed=1, ready=True)
        else:
            st.update(sources_needed=n, seal_to=tuple(i for i in retiring if i in loaded), seal_needed=len(retiring),
                      ready=len(loaded) == n and "legacy" not in FIX)
            if "sealall" in FIX:
                st.update(seal_to=tuple(loaded), seal_needed=n)
        if st["ready"]:
            st["voters"] = tuple(loaded)
        if not st["ready"] and len(loaded) == n:
            st["phase"] = "Legacy"  # FIX=legacy: not serving, but the commit may run
        return st
    top = max(tops)
    at_top = [(i, r) for i in loaded for r in sorted(recs[i], key=repr) if r.d.s == top]
    cur, prev = at_top[0][1].d, at_top[0][1].p
    if "resolve" in FIX and all(r.p is not None for _, r in at_top):
        # only among changes of a recorded set: their admissions follow w(prev) acknowledged seals, so at most one
        # membership per epoch can ever have admissions (record-less changes and the N=1 auto-admit have no barrier)
        with_admit = {(r.d, r.p) for _, r in at_top if r.k == "a"}
        if len(with_admit) == 1:
            cur, prev = next(iter(with_admit))
            at_top = [(i, r) for i, r in at_top if (r.d, r.p) == (cur, prev)]
    bad = lambda d: d.w == 0 or d.w > len(d.m)
    if any(r.d != cur or r.p != prev for _, r in at_top) or bad(cur) or (prev is not None and bad(prev)):
        st.update(phase="Refused", why="disagree")
        return st
    admitted = sorted({i for i, r in at_top if r.k == "a" and i in cur.m})
    unseen = sum(1 for m in cur.m if m not in loaded)
    configured = cur.m == target.m and cur.w == target.w
    st["acting"] = cur
    if len(admitted) >= rq(cur):
        st.update(ready=True, voters=tuple(admitted), need=cur.w, sources=tuple(admitted), sources_needed=rq(cur))
        if configured:
            st.update(phase="Stable", target=cur, prev=prev)
        else:
            st.update(phase="Migrating", commit=True, target=Def(top + 1, target.w, target.m),
                      seal_to=tuple(i for i in loaded if i in cur.m), seal_needed=cur.w, prev=cur)
    elif len(admitted) + unseen >= rq(cur):
        st.update(phase="Waiting")
    elif not configured:
        st.update(phase="Refused", why="unfinished")
    else:
        st.update(phase="Pending", target=cur, prev=prev)
        if admitted:
            st.update(sources=tuple(admitted), sources_needed=1)
        elif prev is None:
            st.update(sources=tuple(loaded), sources_needed=n, seal_to=tuple(i for i in retiring if i in loaded),
                      seal_needed=len(retiring))
            if "sealall" in FIX:
                st.update(seal_to=tuple(loaded), seal_needed=n)
        else:
            p = prev
            def newest(i):
                rs = sorted(recs[i], key=lambda r: (r.d.s, r.k == "a"))
                return rs[-1] if rs else None
            src = tuple(i for i in loaded if i in p.m and newest(i) is not None
                        and (newest(i).d.s == top or (newest(i).k == "a" and newest(i).d == p)))
            st.update(sources=src, sources_needed=rq(p), seal_to=tuple(i for i in loaded if i in p.m),
                      seal_needed=p.w)
    return st

# ---------------------------------------------------------------- world state
# recs: tuple(frozenset(Rec)) per replica; inflight: frozenset((replica, Rec)) abandoned pins;
# held: tuple(frozenset(write ids)); acked: frozenset(write ids); cfg: index; loaded: frozenset(replica)
State = namedtuple("State", "recs inflight held acked cfg loaded ep", defaults=(0,))

class World:
    def __init__(self, replicas, configs, max_writes=2, max_epoch=3):
        self.R = replicas
        self.idx = {r: k for k, r in enumerate(replicas)}
        self.configs = configs
        self.max_writes = max_writes
        self.max_epoch = max_epoch

    def recs_of(self, s):
        return {r: s.recs[self.idx[r]] for r in s.loaded}

    def ms(self, s):
        return membership(self.configs[s.cfg], self.recs_of(s))

    def view(self, s):
        out = set()
        for r in s.loaded:
            out |= s.held[self.idx[r]]
        return frozenset(out)

    def with_recs(self, s, adds):
        recs = list(s.recs)
        for r, rec in adds:
            recs[self.idx[r]] = recs[self.idx[r]] | {rec}
        return s._replace(recs=tuple(recs))

    # admission() (replica.rs 1590-1719), one maintenance pass, every pin outcome branched
    def admission(self, s):
        cfg = self.configs[s.cfg]
        st = self.ms(s)
        if st["phase"] not in ("Legacy", "Stable", "Migrating", "Pending"):
            return []
        if not (st["sources_needed"] > 0 and sum(1 for i in st["sources"] if i in s.loaded) >= st["sources_needed"]):
            return []
        if "stamp" in FIX and st["commit"]:
            st = dict(st, target=st["target"]._replace(s=max(st["target"].s, s.ep + 1)))
        if st["target"].s > self.max_epoch:
            return []
        recs = self.recs_of(s)
        holds = lambda i, admit: any(r.d == st["target"] and (not admit or r.k == "a") for r in recs[i])
        todo = []
        for i in cfg.members:
            if i in s.loaded:
                if not holds(i, True):
                    todo.append(i)
            elif st["commit"]:
                return []
        if not todo:
            return []
        v = self.view(s)
        ok = [i for i in todo if s.held[self.idx[i]] >= v]  # caught_up (keys, deletions, parts: all "writes")
        if st["commit"] and len(ok) < len(todo):
            return []
        if not ok:
            return []
        seals = [i for i in st["seal_to"] if not holds(i, False)] if st["seal_needed"] > 0 else []
        already = sum(1 for i in st["seal_to"] if holds(i, False)) if st["seal_needed"] > 0 else 0
        mk = lambda k: Rec(k, st["target"], st["prev"])
        if "stamp" in FIX:
            s = s._replace(ep=max(s.ep, st["target"].s))
        out = []
        for so in product("ofx", repeat=len(seals)):  # o: acknowledged, f: failed, x: abandoned (may land later)
            s1 = self.with_recs(s, [(i, mk("s")) for i, o in zip(seals, so) if o == "o"])
            s1 = s1._replace(inflight=s1.inflight | {(i, mk("s")) for i, o in zip(seals, so) if o == "x"})
            sealed = already + so.count("o")
            if st["seal_needed"] > 0 and sealed < st["seal_needed"]:
                out.append((f"admission: seals {dict(zip(seals, so))} -> {sealed}/{st['seal_needed']} durable, stop", s1))
                continue
            for ao in product("ofx", repeat=len(ok)):
                s2 = self.with_recs(s1, [(i, mk("a")) for i, o in zip(ok, ao) if o == "o"])
                s2 = s2._replace(inflight=s2.inflight | {(i, mk("a")) for i, o in zip(ok, ao) if o == "x"})
                out.append((f"admission to {fmt_def(st['target'])}: seals {dict(zip(seals, so))}, admits {dict(zip(ok, ao))}", s2))
        return out

    def steps(self, s):
        st = self.ms(s)
        cfg = self.configs[s.cfg]
        out = []
        # client write, acknowledged by exactly `need` voters (the fewest the code accepts)
        if st["ready"] and len(s.acked) < self.max_writes and st["voters"]:
            w = len(s.acked)
            for ack in combinations(st["voters"], st["need"]):
                held = list(s.held)
                for i in ack:
                    held[self.idx[i]] = held[self.idx[i]] | {w}
                out.append((f"write w{w} acknowledged by {','.join(ack)} (voters {','.join(st['voters'])}, need {st['need']})",
                            s._replace(held=tuple(held), acked=s.acked | {w})))
        # repair: copy one write of the view to a loaded configured member lacking it
        if st["ready"] or st["phase"] in ("Pending", "Legacy"):
            v = self.view(s)
            for i in cfg.members:
                if i in s.loaded:
                    for w in sorted(v - s.held[self.idx[i]]):
                        held = list(s.held)
                        held[self.idx[i]] = held[self.idx[i]] | {w}
                        out.append((f"repair copies w{w} to {i}", s._replace(held=tuple(held))))
        out += self.admission(s)
        # an abandoned pin lands
        for (i, rec) in sorted(s.inflight, key=repr):
            s1 = self.with_recs(s, [(i, rec)])
            out.append((f"late pin lands: {rec.k}({fmt_def(rec.d)}) on {i}", s1._replace(inflight=s.inflight - {(i, rec)})))
        # restart with any configuration and any non-empty loaded subset of its listed replicas
        for ci, c in enumerate(self.configs):
            reps = listed(c)
            for k in range(1, len(reps) + 1):
                for L in combinations(reps, k):
                    out.append((f"restart: config {c.name}, loaded {{{','.join(L)}}}", s._replace(cfg=ci, loaded=frozenset(L))))
        return out

def fmt_def(d):
    return f"{{{','.join(d.m)}}}w{d.w}@{d.s}"

def describe(world, s):
    st = world.ms(s)
    recs = "; ".join(f"{r}:[{','.join(sorted(x.k + fmt_def(x.d) for x in s.recs[world.idx[r]]))}]" for r in world.R)
    held = " ".join(f"{r}={sorted(s.held[world.idx[r]])}" for r in world.R)
    return (f"    phase={st['phase']}{'(ready)' if st['ready'] else ''} voters={list(st['voters'])} need={st['need']}"
            f" config={world.configs[s.cfg].name} loaded={sorted(s.loaded)}\n    records {recs}\n    holds {held}; acked {sorted(s.acked)}")

from array import array

class Seen:
    """Open-addressing table of 64-bit state hashes -> (parent hash, step number): about 18 bytes a state, so a few
    million states fit the 200 MiB budget. Distinct states with equal 64-bit hashes would be merged (probability about
    n^2 / 2^65: negligible at these sizes, and it could only hide a trace, never invent one: every printed trace is
    replayed from the initial state and checked)."""
    def __init__(self, bits=22, parents=True):
        self.mask = (1 << bits) - 1
        self.keys = array("Q", [0]) * (1 << bits)
        self.parents = parents
        if parents:
            self.par = array("Q", [0]) * (1 << bits)
            self.step = array("I", [0]) * (1 << bits)
        self.n = 0
    @staticmethod
    def h(state):
        return (hash(state) & 0xFFFFFFFFFFFFFFFF) or 1
    def add(self, k, parent, step):
        i = k & self.mask
        while True:
            have = self.keys[i]
            if have == 0:
                if self.n > self.mask * 0.7:
                    raise MemoryError("state table full")
                self.keys[i] = k
                if self.parents:
                    self.par[i], self.step[i] = parent, step
                self.n += 1
                return True
            if have == k:
                return False
            i = (i + 1) & self.mask
    def get(self, k):
        i = k & self.mask
        while self.keys[i] != k:
            i = (i + 1) & self.mask
        return self.par[i], self.step[i]
    def __len__(self):
        return self.n

def explore(world, init):
    """Breadth-first search of every state reachable within the bounds."""
    seen = Seen()
    seen.add(Seen.h(init), 0, 0)
    q = deque([init])
    bad, refused = None, None
    try:
        while q:
            s = q.popleft()
            st = world.ms(s)
            if st["ready"] and not s.acked <= world.view(s) and bad is None:
                bad = s
            if st["phase"] == "Refused" and st["why"] == "disagree" and refused is None:
                refused = s
            if bad is not None and refused is not None:
                break
            hs = Seen.h(s)
            for k, (label, t) in enumerate(world.steps(s)):
                if len(t.inflight) > MAX_INFLIGHT:
                    continue
                if seen.add(Seen.h(t), hs, k):
                    q.append(t)
    except MemoryError as e:
        print(f"STOPPED ({e}) after {len(seen)} states: the search is NOT exhaustive")
    return (init, seen), bad, refused

def verify(world, init):
    """Depth-first search of every reachable state (memory: the hash table and one path). Returns a violating path
    (not necessarily the shortest) or None."""
    seen = Seen(bits=24, parents=False)  # 128 MiB of hashes, about 11.7 million states
    seen.add(Seen.h(init), 0, 0)
    path = [(init, 0, None)]  # (state, next step index, label that reached it)
    found = {}
    import signal
    def stop(*_):
        raise MemoryError("time limit")
    signal.signal(signal.SIGTERM, stop)
    try:
        while path:
            s, k, label = path[-1]
            if k == 0:
                st = world.ms(s)
                if st["ready"] and not s.acked <= world.view(s) and "bad" not in found:
                    found["bad"] = list(path)
                if st["phase"] == "Refused" and st["why"] == "disagree" and "refused" not in found:
                    found["refused"] = list(path)
                if len(found) == 2:
                    break
            steps = world.steps(s)
            while k < len(steps):
                lab, t = steps[k]
                k += 1
                if len(t.inflight) <= MAX_INFLIGHT and seen.add(Seen.h(t), 0, 0):
                    path[-1] = (s, k, label)
                    path.append((t, 0, lab))
                    break
            else:
                path.pop()
    except MemoryError as e:
        print(f"STOPPED ({e}) after {len(seen)} states: the search is NOT exhaustive")
    return len(seen), found

def trace(world, parent, s):
    init, seen = parent
    chain = []
    h = Seen.h(s)
    while h != Seen.h(init):
        ph, k = seen.get(h)
        chain.append(k)
        h = ph
    cur = init
    lines = [describe(world, cur)]
    for k in reversed(chain):
        label, cur = world.steps(cur)[k]
        lines.append(f"  -> {label}")
        lines.append(describe(world, cur))
    assert cur == s, "replayed trace does not reach the reported state"
    return "\n".join(lines)

def run(name, world, init):
    parent, bad, refused = explore(world, init)
    import resource
    print(f"== {name} FIX={','.join(sorted(FIX)) or '(none: the snapshot as written)'} writes<={world.max_writes} epochs<={world.max_epoch}"
          f" inflight<={MAX_INFLIGHT}: {len(parent[1])} states explored, peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MiB")
    if bad is not None:
        print("SAFETY VIOLATION: ready, and the merged view lacks an acknowledged write. Shortest trace:")
        print(trace(world, parent, bad))
    else:
        print("no lost acknowledged write in any reachable ready state (within these bounds)")
    if refused is not None:
        print("Refused with disagreeing top-epoch records is reachable. Shortest trace:")
        print(trace(world, parent, refused))
    print()
    return bad, refused

def check(name, world, init):
    import resource
    n, found = verify(world, init)
    print(f"== {name} FIX={','.join(sorted(FIX)) or '(none: the snapshot as written)'} writes<={world.max_writes} epochs<={world.max_epoch}"
          f" inflight<={MAX_INFLIGHT}: {n} states, depth-first, peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MiB")
    for what, msg in (("bad", "lost acknowledged write while ready"), ("refused", "Refused with disagreeing top-epoch records")):
        if what in found:
            print(f"  REACHABLE: {msg} (depth-first path of {len(found[what]) - 1} steps; rerun breadth-first for the shortest)")
            if os.environ.get("PATHS"):
                fn = f"{os.environ['PATHS']}-{what}.steps"
                with open(fn, "w") as f:
                    f.write(f"# {name} FIX={','.join(sorted(FIX))}: depth-first path to: {msg}\n")
                    for _, _, label in found[what][1:]:
                        f.write(label + "\n")
                print(f"  path written to {fn} (replay with REPLAY={fn})")
        else:
            print(f"  unreachable within these bounds: {msg}")

def replay(world, init, labels):
    """Follow a trace given as step labels (one per line, exactly as printed) from the initial state."""
    cur = init
    print(describe(world, cur))
    for want in labels:
        nxt = [t for label, t in world.steps(cur) if label == want]
        if not nxt:
            raise SystemExit(f"step not available here: {want}")
        cur = nxt[0]
        st = world.ms(cur)
        print(f"  -> {want}")
        print(describe(world, cur))
    st = world.ms(cur)
    lost = st["ready"] and not cur.acked <= world.view(cur)
    print(f"END: ready={st['ready']} lost acknowledged write={lost} refused-disagree={st['phase'] == 'Refused' and st['why'] == 'disagree'}")

def universe(which):
    if which == "recorded":
        # {a,b,c} w2 admitted at epoch 1; d is a new indexer
        R = ("a", "b", "c", "d")
        C = Cfg("C{a,b,c}w2", ("a", "b", "c"), 2, ())
        T1 = Cfg("T1{a,b,d}w2+c retiring", ("a", "b", "d"), 2, ("c",))
        T2 = Cfg("T2{a,c,d}w2+b retiring", ("a", "c", "d"), 2, ("b",))
        T1x = Cfg("T1x{a,b,d}w2 (c dropped)", ("a", "b", "d"), 2, ())
        byname = {"C": C, "T1": T1, "T2": T2, "T1x": T1x}
        configs = [byname[x] for x in CONFIGS] if CONFIGS else [C, T1, T2]
        e1 = Def(1, 2, ("a", "b", "c"))
        recs = tuple(frozenset({Rec("a", e1, None)}) if r != "d" else frozenset() for r in R)
        init = State(recs, frozenset(), tuple(frozenset() for _ in R), frozenset(), 0, frozenset({"a", "b", "c"}))
        return World(R, configs, max_writes=WRITES, max_epoch=MAX_EPOCH), init
    if which == "legacy":
        # a record-less single indexer a; b, c new
        R = ("a", "b", "c")
        L1 = Cfg("L1{a}w1", ("a",), 1, ())
        M = Cfg("M{b,c}w2+a retiring", ("b", "c"), 2, ("a",))
        M3 = Cfg("M3{a,b,c}w2", ("a", "b", "c"), 2, ())
        configs = [L1, M, M3]
        init = State(tuple(frozenset() for _ in R), frozenset(), tuple(frozenset() for _ in R), frozenset(), 0, frozenset({"a"}))
        return World(R, configs, max_writes=WRITES, max_epoch=MAX_EPOCH), init
    raise SystemExit(f"unknown universe {which}")

WRITES = 2
MAX_INFLIGHT = 2
CONFIGS = None
MAX_EPOCH = 2
FIND_REFUSED = True

if __name__ == "__main__":
    for which in sys.argv[1:] or ["legacy", "recorded:1"]:
        CONFIGS = None
        if ":" in which:
            parts = which.split(":")
            which, WRITES = parts[0], int(parts[1])
            if len(parts) > 2:
                CONFIGS = parts[2].split(",")
            if len(parts) > 3:
                MAX_EPOCH = int(parts[3])
        w, init = universe(which)
        if os.environ.get("REPLAY"):
            replay(w, init, [l.strip() for l in open(os.environ["REPLAY"]) if l.strip() and not l.startswith("#")])
        else:
            (check if os.environ.get("MODE") == "dfs" else run)(which, w, init)
