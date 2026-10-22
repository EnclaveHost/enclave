#!/usr/bin/env python3
"""G8 bounded model: two post-raise clones (A, B) of one fenced writer share its ballot and receipt.

What is modelled (and what is not) is stated in work/claude-storage-clone-resolution-result.txt, section 4.
In short: N replicas (indexers), write quorum W. After the fork both clones hold the same pre-fork view (key k
absent) and each issues ONE conditional create of k ("If-None-Match: *"), value a (clone A) or b (clone B). The host
controls the network: every clone->replica message may be delivered or dropped, and on each replica the delivered
messages may arrive in either order. A clone answers 200 only with W acknowledgements. Version stamps: either order.

Protocols:
  V0  today: a replica applies any mutation carrying the installed credential (exact fence + receipt).
  V1  per-replica CAS: each mutation also carries the replica's expected account head (indexd event_seq); the replica
      applies it only if its head still equals it (first writer wins per replica).
  V2  V1 plus a commit phase: phase 1 pins the version TENTATIVE (CAS); only after W phase-1 acks does the clone send
      phase 2 (re-pin as COMMITTED, CAS on the head its own phase 1 produced); 200 only after W phase-2 acks.
  V2x a commit phase WITHOUT the CAS (shows the CAS is the part that excludes the second clone).
Recovery (a later writer lists a boot set S of R replicas):
  merge-by-version   today's rule: the visible version with the highest stamp wins.
  committed-only     adopt only COMMITTED versions visible in S (V2/V2x).
  fast-quorum        adopt a version only if it MAY have reached W (count_in_S >= W - (N - R)); two such: wait.
Properties checked:
  P1  at most one of the two conditional creates is acknowledged;
  P2  no stale read: a clone can answer a read only after a freshness round that finds W replicas whose head is the
      head it knows (V1/V2), or W replicas with its credential (V0);
  P3  recovery never shows a value other than an acknowledged one, and never loses an acknowledged one;
  P4  liveness note: how often recovery must wait (fast-quorum) for a given R.
"""
import itertools, json, sys

def outcomes_per_replica():
    # per replica: which messages are delivered and in which order -> which clone's mutation applies there (the
    # first delivered; under CAS the second is refused; without CAS both apply and the later one is the last write)
    # returns tuples (applied_set_in_order)
    return [(), ("A",), ("B",), ("A", "B"), ("B", "A")]

def run(N, W, protocol):
    R_classic = N - W + 1
    R_fast = 2 * N - 2 * W + 1
    stats = {"executions": 0, "P1_both_acked": 0, "P2_stale_read": 0,
             "P3_violations": {}, "P4_waits": {}, "P3_examples": {}}
    boot_sets_by_R = {}
    for R in sorted({R_classic, min(R_fast, N), N}):
        boot_sets_by_R[R] = list(itertools.combinations(range(N), R))
    per = outcomes_per_replica()
    for net in itertools.product(per, repeat=N):
        # phase-2 delivery (V2/V2x): for each replica, is the committing clone's phase-2 message delivered?
        p2_choices = [()] if protocol in ("V0", "V1") else list(itertools.product([True, False], repeat=N))
        for p2 in p2_choices:
            for stamp_a_higher in (True, False):
                stats["executions"] += 1
                # replica state after phase 1
                tent = []          # per replica: list of (clone) applied in order
                for r in range(N):
                    arrived = net[r]
                    if protocol in ("V1", "V2"):
                        applied = arrived[:1]          # CAS: first wins, second refused (expected head moved)
                    else:
                        applied = arrived              # no CAS: both apply (last write wins on that replica)
                    tent.append(applied)
                ack1 = {c: sum(1 for r in range(N) if c in tent[r]) for c in "AB"}
                committed = [set() for _ in range(N)]
                if protocol in ("V0", "V1"):
                    acked = {c: ack1[c] >= W for c in "AB"}
                    for r in range(N):
                        committed[r] = set(tent[r])    # no commit phase: whatever is pinned is final
                else:
                    acked = {}
                    for c in "AB":
                        if ack1[c] >= W:
                            for r in range(N):
                                # phase 2 goes to the replicas where its phase 1 applied; under CAS it applies only if
                                # the replica's head is still the one phase 1 produced (no other mutation since)
                                if c in tent[r] and p2[r]:
                                    if protocol == "V2" and tent[r][-1] != c:
                                        continue
                                    committed[r].add(c)
                        acked[c] = sum(1 for r in range(N) if c in committed[r]) >= W
                # P1
                if acked["A"] and acked["B"]:
                    stats["P1_both_acked"] += 1
                # P2: clone B reads k after A was acknowledged; B's view lacks a. It may answer only after a round
                # that confirms W replicas (V0: credential only; V1/V2: head unchanged since B's last knowledge)
                if acked["A"]:
                    if protocol in ("V0", "V2x"):
                        confirms = N
                    else:
                        # B knows the heads its own mutations produced; a replica confirms B unless A's landed there
                        confirms = sum(1 for r in range(N) if "A" not in tent[r])
                    if confirms >= W:
                        stats["P2_stale_read"] += 1
                # P3/P4 per recovery rule and boot set
                rules = ["merge-by-version"] if protocol in ("V0", "V1") else ["committed-only"]
                if protocol == "V1":
                    rules.append("fast-quorum")
                for rule in rules:
                    for R, sets in boot_sets_by_R.items():
                        key = f"{rule} R={R}"
                        for S in sets:
                            if rule == "merge-by-version":
                                vis = {c for r in S for c in committed[r]}
                                if not vis:
                                    result = None
                                elif len(vis) == 1:
                                    result = next(iter(vis))
                                else:
                                    result = "A" if stamp_a_higher else "B"
                            elif rule == "committed-only":
                                vis = {c for r in S for c in committed[r]}
                                result = None if not vis else ("A" if (len(vis) == 1 and "A" in vis) or (len(vis) == 2 and stamp_a_higher) else "B")
                            else:  # fast-quorum
                                need = W - (N - R)
                                may = [c for c in "AB" if sum(1 for r in S if c in committed[r]) >= max(need, 1)]
                                if len(may) == 2:
                                    stats["P4_waits"][key] = stats["P4_waits"].get(key, 0) + 1
                                    continue
                                result = may[0] if may else None
                            # an acknowledged create must be what recovery shows; with none acknowledged, anything
                            # (one of them, or nothing) is a legal outcome of two 503s
                            ok = True
                            for c in "AB":
                                if acked[c] and result != c:
                                    ok = False
                            if not ok:
                                stats["P3_violations"][key] = stats["P3_violations"].get(key, 0) + 1
                                if key not in stats["P3_examples"]:
                                    stats["P3_examples"][key] = {"replicas_phase1": [list(t) for t in tent],
                                                                 "committed": [sorted(c) for c in committed],
                                                                 "acked": acked, "stamp_a_higher": stamp_a_higher,
                                                                 "boot_set": list(S), "recovered": result}
                        stats["P3_violations"].setdefault(key, 0)
    return stats

def evasion_trace():
    """Multi-operation trace for V1 with per-operation tags (ballot, writer op number n, predecessor digest) and a
    classic boot set: the host drops traffic so the two branches never touch a common replica and never reuse a
    number visible in the boot set. N=3, W=2, boot set {r1, r2}."""
    r0 = [("A", 10, "w1"), ("A", 11, "w2"), ("A", 12, "w3:create k=a")]   # A's n=10,11 reach r0 only (503s)
    r1 = [("A", 12, "w3:create k=a")]                                      # n=12 reaches r0 and r1: acknowledged
    r2 = [("B", 10, "l1:create k=b")]                                      # B's first op reaches r2 only (503)
    boot = {"r1": r1, "r2": r2}
    numbers = {}
    collision = False
    for ops in boot.values():
        for clone, n, what in ops:
            if n in numbers and numbers[n] != what:
                collision = True
            numbers[n] = what
    # w3's predecessor digest names w2 (n=11), which is not in the boot set; l1 is n=10: nothing to compare
    return {"boot_set": boot, "same_number_collision_visible": collision,
            "predecessor_link_checkable": False,
            "merge_by_version_may_show": "b (when B's stamp is higher), although a was acknowledged and b's condition was false"}

if __name__ == "__main__":
    out = {}
    for N, W in [(3, 2), (3, 3), (4, 3), (5, 3), (5, 4), (3, 1), (4, 2)]:
        for proto in ("V0", "V1", "V2x", "V2"):
            out[f"N={N} W={W} {proto}"] = run(N, W, proto)
    out["evasion_trace_V1_op_tags_classic_boot"] = evasion_trace()
    with open(sys.argv[1], "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")
