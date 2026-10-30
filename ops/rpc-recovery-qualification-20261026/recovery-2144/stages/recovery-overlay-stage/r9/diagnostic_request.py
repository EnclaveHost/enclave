#!/usr/bin/env python3
"""recovery-overlay-stage/r8 diagnostic_request.py (prepared by Claude 1707; NOT run by Claude). Standard library only.

AUTHORIZATION of a DIAGNOSTIC read-only exposure. This is NOT the acceptance GO (jobs/root-expose-real.sh keeps r7's strict GO check
unchanged). The request is an explicit, root-written statement that the post-deletion history is NOT accepted (it is BLOCKED) and
that the view exists only for a FULL READ-ONLY validation with the pinned validator - never production use, never a recovery claim:

  {"format": "recovery-overlay-diagnostic-request/v1",
   "purpose": "full-readonly-mdbx-validation",
   "recoveryAccepted": false,                       (JSON false exactly; anything else refuses)
   "productionUse": false,                          (JSON false exactly)
   "planSha256": "<the offline plan.json sha256>",
   "journalSha256": "d95d81fc...",
   "history": {"path": "<the pinned BLOCKED result.json>", "sha256": "<its sha256>", "verdict": "BLOCKED"},
   "validator": {"chkSha256": "<pinned mdbx_chk>", "wrapperSha256": "<pinned mdbx_check.py>"},
   "requestedBy": "<who>", "note": "<free text <= 1000>"}

Every value is compared with what the CALLER pins (the job), and the history file is re-hashed and re-read: its own `verdict` must be
"BLOCKED" and equal the request's. A history that has PASSED is refused here (an accepted history goes through the strict GO path,
never a diagnostic one). A GO file is refused (other format), and the GO check refuses a diagnostic request (tested both ways).

    diagnostic_request.py --request R --request-sha256 H --plan-sha256 H --journal-sha256 H --history PATH --history-sha256 H
                          --chk-sha256 H --wrapper-sha256 H
Exit 0 authorized (JSON on stdout: diagnostic only, recoveryAccepted false); 3 refused; 2 usage.
"""
import argparse, hashlib, json, os, re, stat, sys

FORMAT = "recovery-overlay-diagnostic-request/v1"
PURPOSE = "full-readonly-mdbx-validation"
KEYS = {"format", "purpose", "recoveryAccepted", "productionUse", "planSha256", "journalSha256", "history", "validator", "requestedBy", "note"}
GO_FORMAT = "recovery-overlay-go/v1"
HEX64 = re.compile(r"[0-9a-f]{64}")
LABEL = ("DIAGNOSTIC READ-ONLY EXPOSURE: recoveryAccepted=false; post-deletion history BLOCKED; no data-integrity, recovery or "
         "production claim; only the pinned read-only validator reads the view")


class Refused(Exception):
    pass


def read_bounded(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            raise Refused(f"{path}: not a regular file of at most {limit} bytes")
        b = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(b) > limit:
        raise Refused(f"{path} grew beyond {limit} bytes")
    return b


def sha(b):
    return hashlib.sha256(b).hexdigest()


def check_request(req_path, req_sha, *, plan_sha, journal_sha, history_path, history_sha, chk_sha, wrapper_sha):
    for name, v in (("request", req_sha), ("plan", plan_sha), ("journal", journal_sha), ("history", history_sha), ("chk", chk_sha),
                    ("wrapper", wrapper_sha)):
        if not isinstance(v, str) or not HEX64.fullmatch(v):
            raise Refused(f"the pinned {name} sha256 is not 64 lowercase hex characters")
    b = read_bounded(req_path, 64 << 10)
    if sha(b) != req_sha:
        raise Refused("the request is not the pinned sha256")
    try:
        r = json.loads(b)
    except ValueError:
        raise Refused("the request is not JSON")
    if not isinstance(r, dict) or set(r) != KEYS:
        raise Refused(f"the request must have exactly the keys {sorted(KEYS)}")
    if r["format"] != FORMAT:
        raise Refused(f"not a {FORMAT} request (an acceptance GO file is never a diagnostic request)")
    if r["purpose"] != PURPOSE:
        raise Refused(f"purpose must be exactly {PURPOSE!r}")
    if r["recoveryAccepted"] is not False:
        raise Refused("recoveryAccepted must be JSON false: a diagnostic exposure never accepts the recovery")
    if r["productionUse"] is not False:
        raise Refused("productionUse must be JSON false: the view is never used in production")
    if r["planSha256"] != plan_sha or r["journalSha256"] != journal_sha:
        raise Refused("the request is not bound to the pinned plan and journal")
    h = r["history"]
    if not isinstance(h, dict) or set(h) != {"path", "sha256", "verdict"}:
        raise Refused("history must be exactly {path, sha256, verdict}")
    if h["path"] != history_path or h["sha256"] != history_sha:
        raise Refused("the request does not name the pinned history result")
    hb = read_bounded(history_path, 16 << 20)
    if sha(hb) != history_sha:
        raise Refused("the history result is not its pinned sha256")
    try:
        actual = json.loads(hb).get("verdict")
    except (ValueError, AttributeError):
        raise Refused("the history result is not a JSON object")
    if actual != "BLOCKED" or h["verdict"] != actual:
        raise Refused(f"the history verdict is {actual!r} (request says {h['verdict']!r}): a diagnostic request binds ONLY a BLOCKED history; "
                      "an accepted history uses the strict GO path")
    v = r["validator"]
    if not isinstance(v, dict) or set(v) != {"chkSha256", "wrapperSha256"} or v["chkSha256"] != chk_sha or v["wrapperSha256"] != wrapper_sha:
        raise Refused("the request does not name the pinned validator")
    if not isinstance(r["requestedBy"], str) or not 0 < len(r["requestedBy"]) <= 64 or not isinstance(r["note"], str) or len(r["note"]) > 1000:
        raise Refused("requestedBy (1..64) and note (<= 1000) must be strings")
    return {"authorized": True, "diagnostic": True, "recoveryAccepted": False, "productionUse": False, "label": LABEL,
            "requestSha256": req_sha, "planSha256": plan_sha, "historyVerdict": actual, "historySha256": history_sha}


def check_go(go_path, plan_sha, journal_sha):
    """the r7 acceptance GO rule, verbatim in meaning (jobs/root-expose-real.sh keeps its own inline copy): used by the tests to show
    that a diagnostic request is never a GO file and a GO file is never a diagnostic request"""
    g = json.loads(read_bounded(go_path, 64 << 10))
    return (isinstance(g, dict) and g.get("format") == GO_FORMAT and g.get("pass") is True and g.get("planSha256") == plan_sha
            and g.get("journalSha256") == journal_sha and HEX64.fullmatch(str(g.get("gateReceiptSha256"))) is not None)


def main(argv=None):
    ap = argparse.ArgumentParser()
    for k in ("request", "history"):
        ap.add_argument(f"--{k}", required=True)
    for k in ("request-sha256", "plan-sha256", "journal-sha256", "history-sha256", "chk-sha256", "wrapper-sha256"):
        ap.add_argument(f"--{k}", required=True)
    a = ap.parse_args(argv)
    try:
        out = check_request(a.request, a.request_sha256, plan_sha=a.plan_sha256, journal_sha=a.journal_sha256, history_path=a.history,
                            history_sha=a.history_sha256, chk_sha=a.chk_sha256, wrapper_sha=a.wrapper_sha256)
    except (Refused, OSError, KeyError, TypeError) as e:
        print(json.dumps({"authorized": False, "refused": f"{type(e).__name__}: {e}"}))
        return 3
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
