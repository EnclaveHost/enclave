#!/usr/bin/env python3
"""Exhaustive bounded model of writer fencing at indexers (work/storage-writer-fencing-proposal.md).

Three indexers, W = 2, N - W + 1 = 2. Writer A (the old one) holds token 1 and is ALIVE: nobody stopped it. Writer B
(the new one) takes over with token 2. Every request is a message that each indexer may process at any later time, in
any order (network delay, a paused VM, a proxy holding the connection). Nothing cancels a request that was sent.

Writer B: raise the fence on all 3 (requests), wait for N - W + 1 acknowledgements, then list those replicas (the
listing happens at the indexer when processed; B's view is the union), then serve.
Writer A: may send pins of writes w0, w1 at any time (before or after B starts). It acknowledges a write to its client
once W pins are acknowledged. A 409 Fenced answer stops A for good.

Variants:
  strict   indexd with the proposed fence: a pin is applied only if its token >= the account's fence, checked in the
           same transaction. The listing includes unpublished events.
  none     indexd 0.6.0: no fence. B's raise is a no-op marker. The listing includes everything committed.
  sametoken  the strict fence, but A is a duplicate instance holding B's token (no per-instance nonce): its pins pass.
  nopub    the strict fence, but the listing omits pins not yet published (indexd 0.6.0 listing, U1). Publication is
           an independent step per pin.
Invariant (no split brain, no lost acknowledgement): every write A acknowledged is in B's boot view, once B has booted.
Not modelled: B's own writes (they carry token 2 and are never refused by a fence that only B raised). Model only; it
says nothing about Byzantine indexers.
"""
import sys
from collections import deque, namedtuple

N, W = 3, 2
RQ = N - W + 1
WRITES = 2
S = namedtuple("S", "fence applied published inflight a_acks a_acked a_stopped a_sent b_fence_acks b_listed b_view b_phase")
# fence: per indexer; applied: per indexer frozenset of writes; published: per indexer frozenset (for nopub)
# inflight: frozenset of messages ("pin", w, i) | ("fence", i) | ("list", i)
# a_acks: per write frozenset of indexers that acknowledged; a_acked: frozenset of writes A acknowledged to its client
# b_phase: 0 not started, 1 raising, 2 listing, 3 booted

def init():
    e = tuple(frozenset() for _ in range(N))
    return S((0,) * N, e, e, frozenset(), tuple(frozenset() for _ in range(WRITES)), frozenset(), False, frozenset(),
             frozenset(), frozenset(), frozenset(), 0)

def steps(s, mode):
    out = []
    # A sends write w to every indexer (once), unless stopped
    if not s.a_stopped:
        for w in range(WRITES):
            if w not in s.a_sent:
                out.append((f"A sends pin(w{w}, token 1) to all", s._replace(
                    a_sent=s.a_sent | {w}, inflight=s.inflight | {("pin", w, i) for i in range(N)})))
    # B starts: raise the fence everywhere
    if s.b_phase == 0:
        out.append(("B sends fence(2) to all", s._replace(b_phase=1, inflight=s.inflight | {("fence", i) for i in range(N)})))
    # deliver any in-flight message
    for m in sorted(s.inflight):
        rest = s.inflight - {m}
        if m[0] == "pin":
            _, w, i = m
            # sametoken: A is a duplicate instance holding the SAME token as B (no nonce): token 2 >= fence 2 passes
            a_token = 2 if mode == "sametoken" else 1
            fenced = mode in ("strict", "nopub", "sametoken") and s.fence[i] > a_token
            if fenced:
                # 409 Fenced: A stops (if its process sees the answer); nothing applied
                out.append((f"indexer {i} refuses A's pin(w{w}): fenced", s._replace(inflight=rest, a_stopped=True)))
            else:
                applied = list(s.applied); applied[i] = applied[i] | {w}
                acks = list(s.a_acks); acks[w] = acks[w] | {i}
                acked = s.a_acked | ({w} if len(acks[w]) >= W and not s.a_stopped else set())
                out.append((f"indexer {i} applies A's pin(w{w})", s._replace(inflight=rest, applied=tuple(applied),
                                                                         a_acks=tuple(acks), a_acked=acked)))
        elif m[0] == "fence":
            i = m[1]
            fence = list(s.fence); fence[i] = max(fence[i], 2)
            nb = s.b_fence_acks | {i}
            ns = s._replace(inflight=rest, fence=tuple(fence), b_fence_acks=nb)
            if s.b_phase == 1 and len(nb) >= RQ:
                # B lists exactly the replicas that acknowledged its fence
                ns = ns._replace(b_phase=2, inflight=ns.inflight | {("list", j) for j in sorted(nb)[:RQ]})
            out.append((f"indexer {i} raises the fence to 2", ns))
        elif m[0] == "list":
            i = m[1]
            seen = s.published[i] if mode == "nopub" else s.applied[i]
            nl = s.b_listed | {i}
            ns = s._replace(inflight=rest, b_listed=nl, b_view=s.b_view | seen)
            if len(nl) >= RQ:
                ns = ns._replace(b_phase=3)
            out.append((f"indexer {i} answers B's listing: {sorted(seen)}", ns))
    if mode == "nopub":
        for i in range(N):
            for w in sorted(s.applied[i] - s.published[i]):
                pub = list(s.published); pub[i] = pub[i] | {w}
                out.append((f"indexer {i} publishes w{w}", s._replace(published=tuple(pub))))
    return out

def bad(s):
    return s.b_phase == 3 and not s.a_acked <= s.b_view

def explore(mode):
    start = init()
    parent = {start: None}
    q = deque([start])
    while q:
        s = q.popleft()
        if bad(s):
            path = []
            while parent[s] is not None:
                s, label = parent[s]
                path.append(label)
            return len(parent), list(reversed(path))
        for label, t in steps(s, mode):
            if t not in parent:
                parent[t] = (s, label)
                q.append(t)
    return len(parent), None

if __name__ == "__main__":
    import resource
    for mode in sys.argv[1:] or ["strict", "none", "nopub", "sametoken"]:
        n, trace = explore(mode)
        print(f"== {mode}: {n} states, peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MiB")
        if trace is None:
            print("   invariant holds in every reachable state (exhaustive within these bounds)")
        else:
            print("   VIOLATION: A acknowledged a write that B's boot view lacks. Shortest trace:")
            for k, label in enumerate(trace, 1):
                print(f"   {k:2}. {label}")
