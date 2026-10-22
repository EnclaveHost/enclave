#!/usr/bin/env python3
"""Directed, deterministic counterexamples for the membership protocol's joint points with multipart uploads (MP1)
and with B4 version-range ceilings (M1, M2, M2-liveness, RC). Membership states come from ms_model.membership(), a
transcription of the snapshot's Cluster::membership(). Every other rule used is quoted from the snapshot
(work/storage-protocol-audit/snapshot) or from the B4 worktree (work/storage-safety-review/sia-s3), with line numbers.

Model: one writer at a time, fail-stop indexers, durable acknowledgements, abandoned calls that may be applied later.
It shows that the listed rules can lose an acknowledged write or deadlock, and that the proposed rule prevents that
particular trace. It is not a proof of the fixed protocol, and says nothing about concurrent writers or Byzantine
indexers.
"""
import sys
from ms_model import Cfg, Def, Rec, membership

HOUR = 3_600_000
RANGE = 6 * HOUR  # B4 VERSION_RANGE_MS
failures = 0

def say(*a):
    print(*a)

def expect(cond, what):
    global failures
    say(("   ok: " if cond else "   UNEXPECTED: ") + what)
    if not cond:
        failures += 1

# ------------------------------------------------------------------------------------------------ MP1
def mp1(fixed):
    """Multipart catch-up accepts a stale part variant (snapshot replica.rs 1471-1477 repair_parts `fine`,
    1561-1566 caught_up parts, store.rs 1305-1313 stage_complete, replica.rs 1185-1205 complete_upload)."""
    say(f"\n== MP1 multipart part variants across a membership change ({'proposed rule' if fixed else 'snapshot rules'})")
    C = Def(1, 2, ("a", "b", "c"))
    T = Cfg("T{d,e}w2 + a,b,c retiring", ("d", "e"), 2, ("a", "b", "c"))
    recs = {r: frozenset({Rec("a", C, None)}) for r in "abc"} | {r: frozenset() for r in "de"}
    st = membership(T, recs)
    say(f"   config {T.name}, loaded a..e: phase {st['phase']}, voters {st['voters']}, need {st['need']}, sources {st['sources']}")
    expect(st["phase"] == "Migrating" and st["voters"] == ("a", "b", "c") and st["need"] == 2, "Migrating under C, a,b,c vote, W=2")
    targets = ["a", "b", "c", "d", "e"]  # replica.rs 469-472: voters and configured members
    parts = {r: {} for r in targets}     # replica -> {part number: etag}
    # UploadPart 1 = X, acknowledged everywhere; then UploadPart 1 = Y (a retry with other bytes), acknowledged by a,b
    for r in targets:
        parts[r][1] = "X"
    say("   UploadPart(1, X): every target stores it; acknowledged")
    for r in ("a", "b"):
        parts[r][1] = "Y"
    votes = sum(1 for r in ("a", "b") if r in st["voters"])
    expect(votes >= st["need"], "UploadPart(1, Y): a,b store it (c, d, e fail) -> 2 of 2 needed votes -> acknowledged; client keeps ETag Y")
    # source_parts over sources a,b,c: variants of part 1
    variants = {}
    for r in st["sources"]:
        variants.setdefault(parts[r][1], []).append(r)
    say(f"   source variants of part 1: {variants}")
    def caught_up_part(r):
        if fixed:
            # proposed: the variants must agree (or carry an order and the newest is required)
            return len(variants) == 1 and parts[r].get(1) in variants
        return parts[r].get(1) in variants  # snapshot: any variant a source holds
    for r in ("d", "e"):
        fine = parts[r].get(1) is not None and (r in st["voters"] or parts[r][1] in variants)
        say(f"   repair_parts for {r}: holds {parts[r].get(1)}, `fine`={fine} -> {'kept' if fine else 'replaced'}")
    admit = all(caught_up_part(r) for r in ("d", "e"))
    if not fixed:
        expect(admit, "caught_up(d), caught_up(e): part 1 = X is 'a variant a source holds' -> commit seals a,b,c, admits d,e")
        T_recs = {r: frozenset({Rec("a", C, None), Rec("s", Def(2, 2, ("d", "e")), C)}) for r in "abc"}
        T_recs |= {r: frozenset({Rec("a", Def(2, 2, ("d", "e")), C)}) for r in "de"}
        st2 = membership(T, T_recs)
        say(f"   after the commit: phase {st2['phase']}, voters {st2['voters']}")
        holders = [r for r in st2["voters"]]  # retiring replicas are no longer targets
        ok = [r for r in holders if parts[r].get(1) == "Y"]
        say(f"   CompleteMultipartUpload([(1, Y)]): stage_complete on {holders}: {['ok' if r in ok else 'InvalidPart' for r in holders]}")
        expect(len(ok) < st2["need"], "the acknowledged part Y cannot be completed: InvalidPart (acknowledged write lost)")
    else:
        expect(not admit, "proposed: two variants among the sources -> not caught up -> no commit; C keeps serving")
        ok = [r for r in st["voters"] if parts[r].get(1) == "Y"]
        expect(len(ok) >= st["need"], "CompleteMultipartUpload([(1, Y)]) under C: a,b hold Y -> completes")

# ------------------------------------------------------------------------------------------------ B4 helpers
class Rep:
    def __init__(self, name):
        self.name = name
        self.ceiling = 0
        self.live = {}   # key -> highest live version held
        self.tomb = {}   # key -> highest deletion version held
        self.late = []   # abandoned calls, applied when the scenario says so
    def put(self, k, h):
        self.live[k] = max(self.live.get(k, 0), h)
    def delete(self, k, h):
        self.tomb[k] = max(self.tomb.get(k, 0), h)

def visible(reps, loaded, k):
    live = max((reps[r].live.get(k, 0) for r in loaded), default=0)
    tomb = max((reps[r].tomb.get(k, 0) for r in loaded), default=0)
    return live > tomb

class Writer:
    """B4 writer state (B4 worktree replica.rs: stamp 366-378, ensure_range 392-418, rebuild 529-566)."""
    def __init__(self, name, reps, cfg, recs, loaded, now):
        self.name, self.reps, self.cfg, self.loaded, self.now = name, reps, cfg, list(loaded), now
        self.ms = membership(cfg, {r: recs[r] for r in loaded})
        self.ceiling = 0
        self.observed = max(reps[r].ceiling for r in loaded)
        clock = max([v for r in loaded for v in list(reps[r].live.values()) + list(reps[r].tomb.values())], default=0)
        if self.observed > self.ceiling:
            clock = max(clock, self.observed)
        self.clock = clock
        say(f"   {name} boots: config {cfg.name}, loaded {self.loaded}, phase {self.ms['phase']}, voters {self.ms['voters']}, "
            f"need {self.ms['need']}, observed ceiling {self.observed}, clock {self.clock}, wall clock {now}")
    def ensure_range(self, acks, rule):
        """acks: replicas whose ceiling pin is acknowledged. rule: 'merged-naive' counts every loaded ack against the
        configured write quorum (B4 as written); 'M1' counts voters among the acknowledgers against need()."""
        c = max(self.now, self.clock, self.observed) + RANGE
        for r in acks:
            self.reps[r].ceiling = max(self.reps[r].ceiling, c)
        if rule == "merged-naive":
            ok = len([r for r in acks if r in self.loaded]) >= self.cfg.w
        else:
            ok = sum(1 for r in acks if r in self.ms["voters"]) >= max(self.ms["need"], 1)
        if ok:
            self.ceiling = max(self.ceiling, c)
        say(f"   {self.name} reserves ceiling {c}: acknowledged by {sorted(acks)} -> {'counted' if ok else 'refused'} ({rule})")
        return ok
    def stamp(self):
        t = max(self.now, self.clock + 1)
        assert t <= self.ceiling, "nothing is stamped above the acknowledged ceiling"
        self.clock = t
        return t

def b4_m1(fixed):
    say(f"\n== M1 reservation acknowledgements counted among non-voters ({'M1 rule' if fixed else 'B4 merged as written: loaded vs writeQuorum'})")
    reps = {r: Rep(r) for r in "abc"}
    A = Def(1, 1, ("a",))
    recs = {"a": frozenset({Rec("a", A, None)}), "b": frozenset(), "c": frozenset()}
    reps["a"].put("k", 1_000)  # k exists, acknowledged long ago
    T = Cfg("T{b,c}w2 + a retiring", ("b", "c"), 2, ("a",))
    w1 = Writer("writer 1", reps, T, recs, "abc", now=10 * HOUR)
    ok = w1.ensure_range({"b", "c"}, "merged-naive" if not fixed else "M1")
    if not ok:
        expect(fixed, "M1: b,c do not vote (only a does) -> no range -> the PUT answers 503 before stamping; nothing in flight")
        return
    h = w1.stamp()
    say(f"   writer 1 PUT k stamped {h}: pin on a abandoned (applied later), b,c fail -> 0 of 1 votes -> 503")
    reps["a"].late.append(("put", "k", h))
    L1 = Cfg("L1{a}w1 (the migration is called off)", ("a",), 1, ())
    w2 = Writer("writer 2", reps, L1, recs, "a", now=10 * HOUR - 2 * HOUR)  # another host, its clock 2 h behind
    w2.ensure_range({"a"}, "M1")
    t = w2.stamp()
    reps["a"].delete("k", t)
    say(f"   writer 2 DELETE k stamped {t}: acknowledged by a")
    for op, k, v in reps["a"].late:
        reps["a"].put(k, v)
    say(f"   a applies writer 1's abandoned PUT k@{h}")
    expect(visible(reps, ["a"], "k"), f"the acknowledged DELETE is undone: k@{h} > deletion {t} (the ceiling was only on non-voters b,c)")

def b4_m2(fixed):
    say(f"\n== M2 admission without the version ceiling ({'M2 predicate' if fixed else 'no M2 predicate'})")
    reps = {r: Rep(r) for r in "abc"}
    A = Def(1, 1, ("a",))
    recs = {"a": frozenset({Rec("a", A, None)}), "b": frozenset(), "c": frozenset()}
    reps["a"].put("k", 1_000)
    T = Cfg("T{b,c}w2 + a retiring", ("b", "c"), 2, ("a",))
    w1 = Writer("writer 1", reps, T, recs, "abc", now=10 * HOUR)
    w1.ensure_range({"a"}, "M1")  # b and c were briefly unreachable: the reservation and the maintenance copy missed them
    h = w1.stamp()
    say(f"   writer 1 PUT k stamped {h}: a fails, b's pin abandoned (applied later), c fails -> 503")
    reps["b"].late.append(("put", "k", h))
    for r in "bc":
        reps[r].put("k", 1_000)  # backfill: b, c hold the view (k at 1000)
    say("   repair backfills k@1000 to b and c; they are caught up with the view")
    need = max(w1.ceiling, w1.observed)
    m2 = all(reps[r].ceiling >= need for r in "bc")
    say(f"   admission: M2 needs ceiling >= {need} on b, c: they hold {reps['b'].ceiling}, {reps['c'].ceiling}")
    if fixed and not m2:
        say("   M2: not admitted yet; maintenance copies max(own ceiling, observed) to b and c, then the commit runs")
        for r in "bc":
            reps[r].ceiling = max(reps[r].ceiling, need)
    elif not fixed:
        say("   no M2: commit seals a, admits b and c")
    S = Def(2, 2, ("b", "c"))
    recs = {"a": recs["a"] | {Rec("s", S, A)}, "b": frozenset({Rec("a", S, A)}), "c": frozenset({Rec("a", S, A)})}
    T2 = Cfg("T{b,c}w2 (a removed)", ("b", "c"), 2, ())
    w2 = Writer("writer 2", reps, T2, recs, "bc", now=10 * HOUR - 2 * HOUR)
    w2.ensure_range({"b", "c"}, "M1")
    t = w2.stamp()
    for r in "bc":
        reps[r].delete("k", t)
    say(f"   writer 2 DELETE k stamped {t}: acknowledged by b, c")
    for op, k, v in reps["b"].late:
        reps["b"].put(k, v)
    say(f"   b applies writer 1's abandoned PUT k@{h}")
    if fixed:
        expect(not visible(reps, ["b", "c"], "k"), f"k stays deleted: writer 2 started above the carried ceiling, so {t} > {h}")
    else:
        expect(visible(reps, ["b", "c"], "k"), f"the acknowledged DELETE is undone: k@{h} > deletion {t}")

def b4_m2_liveness(fixed):
    say(f"\n== M2 liveness in Pending ({'copy max(ceiling, observed)' if fixed else 'B4 ceilings() as written: returns while ceiling == 0'})")
    reps = {r: Rep(r) for r in "abcd"}
    C = Def(1, 2, ("a", "b", "c"))
    for r in "abc":
        reps[r].ceiling = 50 * HOUR  # the previous writer's acknowledged range
    T1 = Def(2, 2, ("a", "b", "d"))
    recs = {r: frozenset({Rec("a", C, None), Rec("s", T1, C)}) for r in "ab"} | {"c": frozenset({Rec("a", C, None)}), "d": frozenset()}
    T = Cfg("T1{a,b,d}w2 + c retiring", ("a", "b", "d"), 2, ("c",))
    w = Writer("writer 2", reps, T, recs, "abcd", now=10 * HOUR)
    expect(w.ms["phase"] == "Pending" and not w.ms["ready"], "seals durable, no admission yet: Pending, not ready, maintenance runs in the boot loop")
    for attempt in range(3):
        if w.ceiling == 0 and not fixed:
            pass  # ceilings(): `if self.ceiling.get() == 0 { return; }`; ensure_range cannot run: no voters
        else:
            c = max(w.ceiling, w.observed)
            for r in "abd":
                reps[r].ceiling = max(reps[r].ceiling, c)
        m2 = reps["d"].ceiling >= max(w.ceiling, w.observed)
        say(f"   pass {attempt + 1}: d's ceiling {reps['d'].ceiling}, needed {max(w.ceiling, w.observed)} -> {'admitted' if m2 else 'not admitted'}")
    if fixed:
        expect(m2, "d receives the observed ceiling and is admitted: the change finishes")
    else:
        expect(not m2, "d never receives a ceiling: the change never finishes and nothing is served (permanent 503)")

def b4_rc(fixed):
    say(f"\n== RC a reservation that completes during a commit ({'admission holds `reserving`, M2 re-checked' if fixed else 'M1 + M2 checked once, reservation not excluded'})")
    reps = {r: Rep(r) for r in "abcd"}
    C = Def(1, 2, ("a", "b", "c"))
    recs = {r: frozenset({Rec("a", C, None)}) for r in "abc"} | {"d": frozenset()}
    for r in "abc":
        reps[r].put("k", 1_000)
    T = Cfg("T1{a,b,d}w2 + c retiring", ("a", "b", "d"), 2, ("c",))
    w1 = Writer("writer 1", reps, T, recs, "abcd", now=10 * HOUR)
    w1.ensure_range({"a", "b", "c", "d"}, "M1")
    reps["d"].put("k", 1_000)
    c0 = w1.ceiling
    say(f"   admission (write lock held): M2 holds for d (ceiling {reps['d'].ceiling} >= {c0}); seals a, b are pinned (await)")
    if fixed:
        say("   a request's ensure_range waits for `reserving`, which admission holds until it has rebuilt")
        say("   admits a, b, d pinned; rebuild: Stable under T1; the request reserves under T1's voters")
        w1.ms = membership(T, {r: recs[r] | ({Rec("s", Def(2, 2, ('a', 'b', 'd')), C)} if r in "ab" else set()) | ({Rec("a", Def(2, 2, ('a', 'b', 'd')), C)} if r in "abd" else set()) for r in "abcd"})
        w1.clock = max(w1.clock, c0)  # the next stamp needs more range than c0 gives
        w1.now = c0
        ok = w1.ensure_range({"a", "b"}, "M1")
        expect(ok and all(reps[r].ceiling >= w1.ceiling for r in "ab"), "the new ceiling is acknowledged by T1's voters (I1 under T1)")
        return
    # meanwhile a request's reservation completes, counted against C's voters (ms is not rebuilt yet)
    w1.clock = c0  # it needs more range than c0 gives
    w1.now = c0
    w1.ensure_range({"a", "c"}, "M1")
    c2 = w1.ceiling
    w1.now = c0 + HOUR
    say(f"   admits a, b, d pinned; rebuild: T1 acts. d and b never saw ceiling {c2}")
    h = w1.stamp()
    say(f"   the request takes the write lock and stamps PUT k at {h} under T1: d's pin abandoned (applied later), a, b fail -> 503")
    reps["d"].late.append(("put", "k", h))
    recs = {r: recs[r] | ({Rec("s", Def(2, 2, ('a', 'b', 'd')), C)} if r in "ab" else set()) | ({Rec("a", Def(2, 2, ('a', 'b', 'd')), C)} if r in "abd" else set()) for r in "abcd"}
    T2 = Cfg("T1{a,b,d}w2 (c removed)", ("a", "b", "d"), 2, ())
    w2 = Writer("writer 2", reps, T2, recs, "bd", now=c0 - 2 * HOUR)
    w2.ensure_range({"b", "d"}, "M1")
    t = w2.stamp()
    for r in "bd":
        reps[r].delete("k", t)
    say(f"   writer 2 DELETE k stamped {t}: acknowledged by b, d")
    for op, k, v in reps["d"].late:
        reps["d"].put(k, v)
    say(f"   d applies writer 1's abandoned PUT k@{h}")
    expect(visible(reps, ["b", "d"], "k"), f"the acknowledged DELETE is undone: {h} > {t}; ceiling {c2} was acknowledged by C's voters a, c only")

if __name__ == "__main__":
    for fixed in (False, True):
        mp1(fixed)
        b4_m1(fixed)
        b4_m2(fixed)
        b4_m2_liveness(fixed)
        b4_rc(fixed)
    say(f"\n{failures} unexpected outcomes")
    sys.exit(1 if failures else 0)
