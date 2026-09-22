#!/usr/bin/env python3
"""One table for the three lanes, scored against ONE set of contracts.

    three-lane-report.py <masked-dir> <google-dir> <prompts.txt>

The masked directory is quality-compare.sh's output (the masked TPU arm and the in-VM CPU arm of the
SAME GGUF); the google directory is google-lane-run.sh's (Google's NPU lane, a DIFFERENT model package
with its own quantisation and tokenizer). So this compares LANES on task outcomes, never tokens: no
token-level agreement between the masked pair and Google's lane is meaningful and none is computed.

What it refuses to do, because each of these has produced a wrong number here before:
  * guess which artifact belongs to which row -- it reads MANIFEST.tsv and nothing else;
  * score only the rows it finds -- the denominator is the count each producer DECLARED before it ran,
    and a row missing from a manifest is a failure with a reason, not an excluded row;
  * quietly compare different prompt sets -- if the two manifests disagree about what row N asked, it
    says so and stops.

An asymmetry it cannot fix, and therefore states: the masked and CPU lanes are capped at MAXNEW tokens
and report a stop reason, so a reply that ran out of budget is visible and counted as truncated. The
runner Google ships exposes no token-limit flag at all, so its lane is UNCAPPED and no equivalent
status exists. A long answer that the capped lanes truncate, Google's lane may finish. That biases the
comparison in Google's favour, and the only remedy is to run the capped lanes with a budget large
enough that the cap does not bind.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quality_checks import FAIL, PASS, REVIEW, SMOKE, check  # noqa: E402


def load(path, ncols, arms):
    """(rows, expect_rows). A malformed line becomes a row whose arms are all 'malformed'."""
    mf = os.path.join(path, "MANIFEST.tsv")
    if not os.path.exists(mf):
        sys.exit("REFUSING: no MANIFEST.tsv in %s; re-run its producer, which writes one." % path)
    rows, expect = [], None
    for line in open(mf, errors="replace"):
        line = line.rstrip("\n")
        if not line.strip():
            continue
        if line.startswith("#"):
            f = line.split("\t")
            if f[0].strip() == "# expect_rows" and len(f) > 1 and f[1].strip().isdigit():
                expect = int(f[1].strip())
            continue
        f = line.split("\t")
        if len(f) < ncols:
            rows.append(dict(kind="malformed", id=(f[0] if f else "??"), key="", prompt="<malformed manifest row>",
                             expect="", **{a: "malformed" for a in arms}))
            continue
        r = dict(kind="real", id=f[0], key=f[1], prompt=f[2 + len(arms)], expect=f[3 + len(arms)])
        for i, a in enumerate(arms):
            r[a] = f[2 + i]
        rows.append(r)
    if expect is None:
        sys.exit("REFUSING: %s/MANIFEST.tsv declares no expect_rows, so a run cut short cannot be "
                 "told from a complete one." % path)
    # Every row binds to a contract by its OWN id, never by where it sits in the file, so a missing or
    # malformed line cannot shift the rows after it onto the wrong question. That only holds if the ids
    # are trustworthy: well formed, in range, and unique. Anything else is refused, because a row that
    # cannot be bound to exactly one question cannot be scored against any.
    seen = set()
    for r in rows:
        i = r["id"]
        if not (i.isdigit() and i == "%02d" % int(i) and 1 <= int(i) <= expect):
            sys.exit("REFUSING: %s/MANIFEST.tsv has a row id %r that is not one of 01..%02d, so it cannot "
                     "be bound to a question." % (path, i, expect))
        if i in seen:
            sys.exit("REFUSING: %s/MANIFEST.tsv has row %s twice; which answer belongs to it is not "
                     "decidable." % (path, i))
        seen.add(i)
    for k in range(1, expect + 1):
        i = "%02d" % k
        if i not in seen:
            rows.append(dict(kind="missing", id=i, key="", prompt="<row missing: the run did not reach it>",
                             expect="", **{a: "missing" for a in arms}))
    rows.sort(key=lambda r: r["id"])
    return rows, expect


def read(p):
    return open(p, errors="replace").read() if os.path.exists(p) else None


def vm_answer(d, r, arm):
    """(reply, stop, error) for a masked/CPU arm."""
    if r[arm] != "ok":
        return None, "failed", "the producer recorded this arm as %s" % r[arm]
    txt = read(os.path.join(d, "%s.%s.%s.log" % (r["id"], r["key"], arm)))
    if txt is None:
        return None, "missing", "no log file"
    st = re.findall(r"status=(\w+)", txt)
    m = re.findall(r"LOCAL turn \d+ A: (.*)", txt)
    if not m:
        return None, (st[0] if st else "unknown"), "no A: line"
    return m[0].rstrip(), (st[0] if st else "unknown"), None


def npu_answer(d, r):
    if r["npu"] != "ok":
        return None, "n/a", "the producer recorded this row as %s" % r["npu"]
    txt = read(os.path.join(d, "%s.%s.txt" % (r["id"], r["key"])))
    if txt is None:
        return None, "n/a", "no reply file"
    txt = txt.strip()
    return (txt, "n/a", None) if txt else (None, "n/a", "empty reply")


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    MD, GD, PF = sys.argv[1], sys.argv[2], sys.argv[3]
    # The prompts FILE is the authority on what row N asked and how it is scored. Taking the prompt
    # from a manifest instead meant that when one producer's run was short, its placeholder row text
    # matched no spec, and the OTHER lane's perfectly good answer was scored against an empty
    # contract and came back REVIEW -- a missing row on one lane silently degraded the others.
    canon = []                       # [(prompt, contract)] in file order; row NN is canon[NN-1]
    for line in open(PF, errors="replace"):
        line = line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#") or "\t" not in line:
            continue
        pr, _, sp = line.partition("\t")
        canon.append((pr.strip(), sp.strip()))

    mrows, mexp = load(MD, 6, ["tpu", "cpu"])
    grows, gexp = load(GD, 5, ["npu"])
    if mexp != gexp:
        sys.exit("REFUSING: the two runs declared different row counts (%d and %d), so they did not "
                 "run the same prompt set." % (mexp, gexp))
    gby = {r["id"]: r for r in grows}
    for r in mrows:
        g = gby.get(r["id"])
        if g and g["prompt"] != r["prompt"] and not r["prompt"].startswith("<") \
                and not g["prompt"].startswith("<"):
            sys.exit("REFUSING: row %s asks different things in the two runs:\n  masked: %r\n  "
                     "google: %r" % (r["id"], r["prompt"], g["prompt"]))

    # ...and each run must have asked the questions THIS prompts file asks, in this order, under these
    # contracts. Resolving the contract by ordinal without this check scored an answer against a
    # question that was never put: both manifests asked "2 plus 2", every reply said 391, the prompts
    # file's row 01 was "17 times 23" with numeric=391 -- and the report printed PASS PASS PASS beside
    # the 2+2 question. Two runs agreeing with each other is not them agreeing with the contract.
    if mexp != len(canon):
        sys.exit("REFUSING: the runs declared %d rows but %s has %d prompts, so they were not produced "
                 "from it." % (mexp, PF, len(canon)))
    for label, rows_ in (("masked + CPU", mrows), ("google NPU", grows)):
        for r in rows_:
            if r["kind"] != "real":
                continue
            q, contract = canon[int(r["id"]) - 1]
            if r["prompt"] != q:
                sys.exit("REFUSING: row %s of the %s run asked\n  %r\nbut row %s of %s is\n  %r\n"
                         "An answer cannot be scored against a question it was not asked."
                         % (r["id"], label, r["prompt"], r["id"], PF, q))
            # EXACT equality, empty included. "if r['expect'] and ..." let a real row with a BLANK recorded
            # contract skip the check entirely, so it was then scored against whatever the prompts file
            # says -- a row that recorded no contract cannot be shown to have been produced under this one.
            if r["expect"] != contract:
                sys.exit("REFUSING: row %s of the %s run was produced under the contract %r, but %s says "
                         "%r for the same question." % (r["id"], label, r["expect"], PF, contract))

    for name, d in (("masked + CPU", MD), ("google NPU", GD)):
        b = read(os.path.join(d, "BUILD"))
        print("== %s, identity recorded with these results" % name)
        for line in (b or "  <no BUILD file>").strip().splitlines():
            print("  " + line)
        print()

    def verdict(reply, stop, err, spec):
        if reply is None:
            return FAIL, "no reply (%s)" % err
        if stop not in ("eos", "n/a"):
            return FAIL, "stopped at the token cap (%s): truncated, not a completed task" % stop
        return check(spec, reply)

    tot = {"tpu": 0, "cpu": 0, "npu": 0}
    other = {"tpu": 0, "cpu": 0, "npu": 0}
    capped = 0
    print("%-3s %-7s %-7s %-7s  %s" % ("#", "masked", "cpu", "npu", "prompt"))
    for r in mrows:
        g = gby.get(r["id"], dict(id=r["id"], key="", npu="missing", prompt=r["prompt"], expect=""))
        spec = canon[int(r["id"]) - 1][1]   # ids were validated and every real row matched it
        a, sa, ea = vm_answer(MD, r, "tpu")
        b, sb, eb = vm_answer(MD, r, "cpu")
        c, sc, ec = npu_answer(GD, g)
        va, _ = verdict(a, sa, ea, spec)
        vb, _ = verdict(b, sb, eb, spec)
        vc, _ = verdict(c, sc, ec, spec)
        for k, v in (("tpu", va), ("cpu", vb), ("npu", vc)):
            tot[k] += v == PASS
            other[k] += v in (SMOKE, REVIEW)
        if "budget" in (sa, sb):
            capped += 1
        # the row's OWN text is shown, placeholder and all: a missing or malformed row has to stay
        # visible as such. Only the SPEC comes from the canonical prompt.
        print("%-3s %-7s %-7s %-7s  %s" % (r["id"], va, vb, vc, r["prompt"][:46]))

    n = mexp
    print("\nTASK CORRECTNESS, out of %d declared prompts (a semantic check ran and the answer "
          "satisfied it):" % n)
    print("  masked TPU %d/%d    in-VM CPU %d/%d    Google NPU %d/%d"
          % (tot["tpu"], n, tot["cpu"], n, tot["npu"], n))
    print("  not counted as correctness (SMOKE shape / REVIEW needs a human): %d, %d, %d"
          % (other["tpu"], other["cpu"], other["npu"]))
    if capped:
        print("  %d row(s) hit the masked/CPU token cap and are counted as failures on those two "
              "lanes.\n  Google's lane is UNCAPPED -- its runner exposes no token-limit flag -- so the "
              "same row\n  may complete there. Raise MAXNEW until this line reads 0 before comparing "
              "the totals." % capped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
