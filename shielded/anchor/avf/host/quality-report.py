#!/usr/bin/env python3
"""Read a quality-compare.sh output directory and report two SEPARATE things about the masked path.

**Decode agreement** -- does the masked path produce the same tokens as the unmasked CPU decode of the same
GGUF? Greedy decoding compounds, so one flipped argmax changes everything after it, and the honest
statistic is WHERE the two arms first part rather than a per-character rate. The CPU arm is a different
quantisation, not a bit-exact oracle: agreement is strong evidence the lane arithmetic is faithful,
disagreement is not by itself proof that it is wrong.

**Task correctness** -- is the answer actually right? This is scored by quality_checks.py, which runs
semantic checks (executing extracted code against cases, requiring N distinct items, exact numbers in
order) and reports SMOKE for a regex shape and REVIEW for an open-ended task. It never calls either of
those correctness. An earlier version of this file scored a regex match as correctness and passed
"def reverse_string(s): return s", "Brazil" for three countries, and "banana" for a haiku.

A reply that stopped at the token cap is TRUNCATED and cannot be a completed task, however well it agrees.

EVERY prompt stays in the denominator. A run that crashed, produced no answer, or has no log is counted as
a failure with its reason printed; it is never skipped into a smaller and flattering total.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quality_checks import FAIL, PASS, REVIEW, SMOKE, check  # noqa: E402

D = sys.argv[1] if len(sys.argv) > 1 else "/tmp/quality-compare"
# Optional: the canonical prompts file. Scoring specs are then taken from it, matched by prompt text,
# rather than from the per-run .expect copies -- so a results directory is never rewritten to re-score it.
SPECS = {}
if len(sys.argv) > 2:
    for line in open(sys.argv[2], errors="replace"):
        line = line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#") or "\t" not in line:
            continue
        pr, _, sp = line.partition("\t")
        SPECS[pr.strip()] = sp.strip()


def load_manifest(d):
    """The ONLY source of which artifact belongs to which row.

    An earlier version globbed `NN.*.arm.log` and took the lexicographically last hash. That put the
    relabelling defect back, one layer further out: with a current key holding a wrong answer and an old
    key holding the right one for a DIFFERENT prompt, the sort picked the old file and reported PASS.
    Sort order is not evidence of anything. The producer now writes a manifest binding each row's id and
    key to its prompt, its settings and the binary digest, with a per-arm status, and this reads only
    that. A directory without one is refused rather than guessed at."""
    mf = os.path.join(d, "MANIFEST.tsv")
    if not os.path.exists(mf):
        return None, None
    rows, expect_rows = [], None
    for line in open(mf, errors="replace"):
        line = line.rstrip("\n")
        if not line.strip():
            continue
        if line.startswith("#"):
            f = line.split("\t")
            if f[0].strip() == "# expect_rows" and len(f) > 1 and f[1].strip().isdigit():
                expect_rows = int(f[1].strip())
            continue
        f = line.split("\t")
        if len(f) < 6:
            # NOT skipped. A truncated line is a row whose result is unknown, and dropping it shrinks the
            # denominator -- the same arithmetic that turns an abandoned run into a flattering score.
            rows.append(dict(id=(f[0] if f else "??"), key="", tpu="malformed", cpu="malformed",
                             prompt=(f[4] if len(f) > 4 else "<malformed manifest row>"), expect=""))
            continue
        rows.append(dict(id=f[0], key=f[1], tpu=f[2], cpu=f[3], prompt=f[4], expect=f[5]))
    return rows, expect_rows


def read(path):
    return open(path, errors="replace").read() if os.path.exists(path) else None


def answer(path):
    """(reply, stop_reason, error). stop_reason: eos | budget | unknown; error explains a missing reply."""
    txt = read(path)
    if txt is None:
        return None, "missing", "no log file"
    st = re.findall(r"status=(\w+)", txt)
    stop = st[0] if st else "unknown"
    m = re.findall(r"LOCAL turn \d+ A: (.*)", txt)
    if not m:
        for bad in ("HOST FAIL", "VM error", "LOCAL failed", "PHONE NOT AWAKE", "SIGABRT", "refused"):
            if bad in txt:
                return None, stop, bad
        return None, stop, "no A: line"
    return m[0].rstrip(), stop, None


def main():
    rows_mf, expect_rows = load_manifest(D)
    if rows_mf is None:
        print(f"REFUSING: no MANIFEST.tsv in {D}.\n"
              f"Which log belongs to which prompt is not inferable from filenames, and guessing it by\n"
              f"sort order produced a false PASS once already. Re-run host/quality-compare.sh, which\n"
              f"writes the manifest.")
        return 2
    if expect_rows is None:
        print(f"REFUSING: {D}/MANIFEST.tsv declares no expect_rows.\n"
              f"Without the count fixed before the run, a manifest cut short by an interrupted or failed\n"
              f"run is indistinguishable from a complete one, and scoring only the rows present turns an\n"
              f"abandoned run into a flattering total. Re-run host/quality-compare.sh.")
        return 2
    if not rows_mf and expect_rows == 0:
        print(f"no rows in {D}/MANIFEST.tsv")
        return 1
    # Every prompt the run SET OUT to do stays in the denominator. A row the producer never reached is a
    # failure with a stated reason, never an excluded row.
    seen = {r["id"] for r in rows_mf}
    for k in range(1, expect_rows + 1):
        i = f"{k:02d}"
        if i not in seen:
            rows_mf.append(dict(id=i, key="", tpu="missing", cpu="missing",
                                prompt="<row missing from the manifest: the run did not reach it>",
                                expect=""))
    rows_mf.sort(key=lambda r: r["id"])
    build = read(os.path.join(D, "BUILD"))
    if build:
        print("binary identity recorded with these results:")
        for line in build.strip().splitlines():
            print("  " + line)
        print()

    rows = []
    for r in rows_mf:
        i, prompt = r["id"], r["prompt"]
        spec = SPECS.get(prompt, r["expect"])
        def arm(which):
            if r[which] != "ok":        # failed / missing / malformed -- all are failures, none are skips
                return None, "failed", f"the producer recorded this arm as {r[which]}"
            return answer(os.path.join(D, f"{i}.{r['key']}.{which}.log"))
        a, sa, ea = arm("tpu")
        b, sb, eb = arm("cpu")
        rows.append((i, prompt, spec, a, sa, ea, b, sb, eb))

    def verdict(reply, stop, err, spec):
        if reply is None:
            return FAIL, f"no reply ({err})"
        if stop != "eos":
            return FAIL, f"stopped at the token cap ({stop}): truncated, not a completed task"
        return check(spec, reply)

    print(f"{'#':3} {'tpu':>7} {'cpu':>7} {'agreement':>14}  prompt")
    n = len(rows)
    tp = cp = 0
    smoke = rev = trunc = broken = 0
    agree_ident = 0
    agree_den = 0
    details = []
    for i, prompt, spec, a, sa, ea, b, sb, eb in rows:
        va, da = verdict(a, sa, ea, spec)
        vb, db = verdict(b, sb, eb, spec)
        tp += va == PASS
        cp += vb == PASS
        smoke += va == SMOKE
        rev += va == REVIEW
        if a is None or b is None:
            broken += 1
            mark = "no comparison"
        else:
            if sa != "eos" or sb != "eos":
                trunc += 1
            k = 0
            while k < min(len(a), len(b)) and a[k] == b[k]:
                k += 1
            agree_den += 1
            if k == len(a) == len(b):
                agree_ident += 1
                mark = "identical"
            else:
                mark = f"char {k}"
            details.append((i, prompt, a, b, k))
        print(f"{i:3} {va:>7} {vb:>7} {mark:>14}  {prompt[:50]}")
        if va != PASS:
            print(f"{'':3} {'':7} {'':7} {'':14}    tpu: {da}")
        if vb != PASS and vb != va:
            print(f"{'':3} {'':7} {'':7} {'':14}    cpu: {db}")

    print(f"\nTASK CORRECTNESS, out of {n} prompts (a semantic check ran and the answer satisfied it):")
    print(f"  tpu {tp}/{n}    cpu {cp}/{n}")
    if smoke or rev:
        print(f"  not counted as correctness: {smoke} SMOKE (regex shape only), {rev} REVIEW (needs a human)")
    print(f"  {broken} prompt(s) produced no comparable answer on at least one arm; "
          f"{trunc} hit the token cap")
    if agree_den:
        print(f"DECODE AGREEMENT, out of {agree_den} comparable pairs: {agree_ident} identical")
    print("\nSMOKE and REVIEW are NOT correctness. A truncated or missing reply is a failure, not an "
          "excluded row.")

    for i, prompt, a, b, k in details:
        print(f"\n--- {i}  {prompt}")
        print(f"    agree: {a[:k]!r}")
        print(f"    TPU  : {a[k:]!r}")
        print(f"    CPU  : {b[k:]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
