#!/usr/bin/env python3
"""ONE complete validation of a bench run, from its own artifacts.

Used by the runner (to print VALID) and by pairs.py (to accept an arm), so the
two can never disagree about what a valid run is.

Every artifact is REQUIRED, and so is every field a check reads. A missing
file, a missing field or an unparseable value is a REJECT: an unknown observer,
correctness or contamination state must never read as a clean one. (The
previous pairs.py treated a missing .meta as empty and a missing obs_fail as
zero, and accepted a copied clean run with no .meta at all.)

  validate.py LABEL [--rc N]      prints "VALID ..." or "INVALID: reason"; exit 0/1

--rc gives the exit status directly (the runner knows it before any queue log
line exists). Without it, the rc is read from the queue log that recorded the
run; no record is a REJECT.
"""
import re, sys, json, os, glob

B = os.path.dirname(os.path.abspath(__file__))

JSON_REQUIRED = ("decode_tok_s", "text_identical", "first_diff_token", "obs_fail",
                 "k", "prompt_tokens", "generated", "plain_generated", "rounds")
META_REQUIRED = ("intruder", "refusalA", "refusalB")

def queue_rc(label):
    """(rc, intruder_flag) from whichever queue log recorded the run, or (None, None)."""
    for lg in glob.glob(f"{B}/*.log"):
        for line in open(lg, errors="replace"):
            if line.startswith(label + " "):
                m = re.search(r"rc=(\d+)", line)
                return (int(m.group(1)) if m else None), ("INTRUDER" in line)
    return None, None

def validate(label, rc=None):
    """Return (True, info) or (False, reason). info = (tok_s, workload tuple)."""
    jf, ef, mf = (f"{B}/{label}.{x}" for x in ("json", "err", "meta"))
    for f in (jf, ef, mf):
        if not os.path.exists(f): return False, f"missing {os.path.basename(f)}"

    # exit status
    q_intr = None
    if rc is None:
        rc, q_intr = queue_rc(label)
        if rc is None: return False, "no queue log records this run's rc"
    if rc != 0: return False, f"rc={rc}"
    if q_intr: return False, "INTRUDER in queue log"

    # meta: every field present and clean
    meta = open(mf).read()
    kv = dict(re.findall(r"(\w+)=(\S+)", meta))
    for k in META_REQUIRED:
        if k not in kv: return False, f".meta lacks {k}"
    if kv["intruder"] != "none": return False, f"intruder={kv['intruder']}"
    for k in ("refusalA", "refusalB", "splitrefused", "cpuonly"):
        if k in kv:
            if not kv[k].isdigit(): return False, f".meta {k}={kv[k]} not a count"
            if int(kv[k]): return False, f"{k}={kv[k]}"

    # err: bench summary line and every refusal form, read from the log itself
    txt = open(ef, errors="replace").read()
    nsplit = len(re.findall(r"\] split: \S+ slice \d+\.\.\d+ refused on card", txt))
    if nsplit: return False, f"split refusals={nsplit}"
    if "all operations stay on CPU" in txt: return False, "invalid worker pool: all operations on CPU"
    if "exceeds the budget" in txt: return False, "budget refusal in .err"
    if "cannot reserve" in txt: return False, "reservation refusal in .err"
    ms = re.findall(r"\[bench\] shielded: offloaded=(\d+) local=(\d+) GMAC=[\d.]+ verify_fail=(\d+)", txt)
    if not ms: return False, "no bench summary line in .err"
    off, loc, vf = (int(v) for v in ms[-1])
    if vf: return False, f"verify_fail={vf}"
    if "verification FAILED" in txt: return False, "verification FAILED in .err"
    if loc: return False, f"local fallback={loc}"
    if not off: return False, "offloaded=0"

    # json: parseable, every field present, correctness clean
    try:
        d = json.loads(open(jf).read().strip().splitlines()[-1])
    except Exception as e:
        return False, f"unreadable json ({e})"
    for k in JSON_REQUIRED:
        if k not in d: return False, f"json lacks {k}"
    if d["text_identical"] is not True: return False, f"output differed at token {d['first_diff_token']}"
    if not isinstance(d["obs_fail"], int) or d["obs_fail"] != 0: return False, f"obs_fail={d['obs_fail']}"
    if not isinstance(d["decode_tok_s"], (int, float)) or d["decode_tok_s"] <= 0:
        return False, f"decode_tok_s={d['decode_tok_s']}"
    w = (d["k"], d["prompt_tokens"], d["generated"], d["plain_generated"], off)
    return True, (d["decode_tok_s"], w)

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: print(__doc__); sys.exit(2)
    rc = None
    if "--rc" in a:
        i = a.index("--rc"); rc = int(a[i + 1]); del a[i:i + 2]
    ok, info = validate(a[0], rc)
    if ok: print(f"VALID tok_s={info[0]:.2f} workload={info[1]}")
    else:  print(f"INVALID: {info}")
    sys.exit(0 if ok else 1)
