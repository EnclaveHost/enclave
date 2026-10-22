#!/usr/bin/env python3
"""ROOT-ONLY, READ-ONLY: ONE snapshot of minipc's network runtime AFTER root's `root-node-hold.py --restart-agent` (the G4+AI
NETWORK group). Prepared by Claude 60543494; never run by its author. No background polling: one snapshot per invocation.

  root-g4-network-observe.py --baseline <helper/runs/preflight-P2.json> --restart <helper/runs/restart-agent-result-R.json>

Remote reads, all existing reviewed read-only texts, loaded by EXACT pinned sha:
  - root-node-hold.py 0829847e preflight(): its IDN / CFGS / ACLS / FIL / COV texts through the pinned transport
    c50aac8e. These give process identities, the manager and Hyper-V VM identities, file shas, config shas and key NAMES,
    status age and walletAdmission, coverage ids, and the policy-unavailable COUNT.
  - root-g4-probe.py 58fa86b7: its `base` + `checks` texts verbatim (hs2 config sha, listeners, ACME account existence, and
    the local GET /health / HEAD bootstrap / challenge-404 / unknown-host-421 status codes). Its expected values come from
    hs2's authoritative probe-after receipt.
Never read or stored: config values, keys, log lines (only the reviewed pattern COUNT).
The snapshot receipt keeps metadata only. Key names are reduced to presence booleans.

Exit codes:
  0 OBSERVATION_COMPLETE_HEALTHY: every check passes and >= 30 min since the new agent started.
  2 INITIAL_HEALTHY: every check passes, but < 30 min.
  3 UNHEALTHY: a check failed.
  4 UNAVAILABLE: a source or field could not be read; this is never a pass."""
import argparse, ast, calendar, hashlib, importlib.util, json, os, pathlib, re, sys, time

H = pathlib.Path(__file__).resolve().parent; W = H.parent; OUT = H / "runs"
HELPER = (W / "g4-node-ai-final-20261021/helper/root-node-hold.py", "0829847e90cd090948af9e74ca053045aef4e630193881ce2a48e3e54947cd02")
PROBE = (W / "challenge-host-tls-20261021/g4/root-g4-probe.py", "58fa86b733c6bfb620851fe5d2314d3fd7f3ac950b238bebd39d79065766f275")
HS_AFTER = (W / "challenge-host-tls-20261021/g4/root-g4/probe-after-20261021T223653Z.json", "13b218a665c1e6216e1852b3576ed21903722997c7b3866addc90869db39fe2e")
OBSERVE_S = 1800
NETWORK = ("ingress", "privacy", "worker")
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def ts(s):
    """remote ISO-8601 (with or without fraction / Z) -> epoch seconds, or None"""
    m = re.match(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$", str(s or ""))
    return calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")) + float(m.group(2) or 0) if m else None

def load_pinned():
    bad = [str(p) for p, h in (HELPER, PROBE, HS_AFTER) if not p.exists() or sha(p) != h]
    if bad: raise SystemExit(f"local pins differ: {bad}")
    s = importlib.util.spec_from_file_location("rnh", HELPER[0]); R = importlib.util.module_from_spec(s); s.loader.exec_module(R)
    R.verify_local()                                    # the helper's own pins (transport, scripts, bundles); loads m.ps once
    texts = {t.targets[0].id: ast.literal_eval(t.value) for t in ast.parse(PROBE[0].read_text()).body
             if isinstance(t, ast.Assign) and isinstance(t.targets[0], ast.Name) and t.targets[0].id in ("base", "checks")}
    if set(texts) != {"base", "checks"}: raise SystemExit("root-g4-probe.py: base/checks texts not found")
    return R, texts["base"] + texts["checks"] + "$o|ConvertTo-Json -Depth 5 -Compress"

def snapshot(R, hs_text):
    """the ONLY remote part: the helper's read-only preflight + the hs2 probe text (one call each)"""
    pre = R.preflight()
    try: hs = R.m.ps(hs_text, 90)
    except Exception as e: hs = {"error": str(e)[:200]}
    return pre, hs

def reduce(pre, hs):
    """metadata only: drop key names (presence booleans instead), SDDLs and record internals"""
    i = dict(pre.get("identities") or {}); en = i.pop("enKeys", None)
    i["enKeyFlags"] = None if not isinstance(en, list) else {k: k in en for k in ("walletAdmission", "hostServices", "challengeReplica")}
    i["enKeyCount"] = len(en) if isinstance(en, list) else None
    for k in ("cfgAcl", "localAcl"): i.pop(k, None)
    return {"identities": i, "state": pre.get("state"), "files": pre.get("files"), "keepUnchanged": pre.get("keepUnchanged"),
            "coverage": {k: (pre.get("coverage") or {}).get(k) for k in ("expectedIds", "blockers", "staleEnrolledWithoutVm")},
            "gate": pre.get("gate"), "errors": pre.get("errors"), "hostServices": hs}

def evaluate(base, restart, snap, hs_ref, helper_files):
    """pure: (baseline preflight, restart-agent receipt, reduced snapshot, hs2 probe-after receipt) -> report"""
    checks = []
    def chk(name, ok, detail=None): checks.append({"check": name, "ok": ok, **({"detail": detail} if detail is not None else {})})
    def unk(name, why): checks.append({"check": name, "ok": None, "detail": why})
    B, S, rr = base.get("identities") or {}, snap.get("identities") or {}, (restart.get("result") or {})
    # inputs
    chk("baseline is the post-apply preflight (ingress/privacy/worker new)", base.get("what") == "preflight" and all((base.get("state") or {}).get(k) == "new" for k in NETWORK))
    if restart.get("what") != "result" or not isinstance(rr, dict): unk("restart receipt", "not a restart-agent result receipt")
    else:
        chk("restart receipt: decision restarted, alive, new agent script, no wallet admission",
            rr.get("decision") == "restarted" and rr.get("alive") is True and rr.get("agentScript") == helper_files["privacy"][3] and rr.get("statusWallet") is False,
            {k: rr.get(k) for k in ("decision", "alive", "statusWallet")} | {"agentScript": str(rr.get("agentScript"))[:8]})
        bp = (B.get("privacy") or [{}])[0]
        chk("restart replaced the baseline privacy agent (new PID/start differ, start after the baseline)",
            rr.get("newPid") not in (None, bp.get("pid")) and rr.get("newStart") != bp.get("start") and (ts(rr.get("newStart")) or 0) > (ts(B.get("at")) or 9e18))
    # sources
    errs = snap.get("errors")
    if errs is None or errs: unk("preflight sources", f"errors {errs}")
    for k in ("vms", "hyperv"):
        if S.get(k) in (None, "", "unavailable"): unk(f"{k} source", f"{k} unavailable")
    hs = snap.get("hostServices") or {}
    if not isinstance(hs, dict) or "error" in hs or "http" not in hs: unk("hs2 probe source", str(hs.get("error") if isinstance(hs, dict) else hs)[:120])
    # identities: node cmd, agent, manager unchanged; VMs unchanged (full identity strings)
    for k in ("cmd", "agent"):
        if not isinstance(S.get(k), list): unk(f"node {k} identity", "missing")
        else: chk(f"node {k} identity unchanged (pid+start)", S[k] == B.get(k) and len(S[k]) == 1, S[k])
    chk("manager identity unchanged", bool(S.get("manager")) and S.get("manager") == B.get("manager"), S.get("manager"))
    if S.get("vms") not in (None, "", "unavailable"): chk("manager VM identities unchanged (full id|name|status set)", S.get("vms") == B.get("vms"), f"{len(str(S.get('vms')).split(','))} vs {len(str(B.get('vms')).split(','))}")
    if S.get("hyperv") not in (None, "", "unavailable"): chk("Hyper-V VM identities unchanged (full GUID|name|state set)", S.get("hyperv") == B.get("hyperv"), f"{len(str(S.get('hyperv')).split(','))} vs {len(str(B.get('hyperv')).split(','))}")
    # the pinned new privacy agent alive
    pa = S.get("privacy")
    if not isinstance(pa, list): unk("privacy agent identity", "missing")
    else: chk("exactly one privacy agent and it is the restart's pinned PID+start", len(pa) == 1 and pa[0].get("pid") == rr.get("newPid") and pa[0].get("start") == rr.get("newStart"), pa)
    # files: the 3 network files new, the control group as in the baseline, the 2 native binaries unchanged
    st = snap.get("state") or {}
    if not st: unk("file states", "missing")
    else:
        for k in NETWORK: chk(f"{k} file is the new sha {helper_files[k][3][:8]}", st.get(k) == "new" and (snap.get("files") or {}).get(helper_files[k][1]) == helper_files[k][3], st.get(k))
        chk("control-group files unchanged from the baseline (not yet applied)", {k: v for k, v in st.items() if k not in NETWORK} == {k: v for k, v in (base.get("state") or {}).items() if k not in NETWORK})
    kp = snap.get("keepUnchanged")
    if not isinstance(kp, dict) or len(kp) != 2: unk("native binaries", "keepUnchanged missing")
    else: chk("enclave-wg.exe and enclave-circuit-firewall.exe are the pinned binaries", all(v is True for v in kp.values()))
    # coverage
    cov = snap.get("coverage") or {}
    if not isinstance(cov.get("expectedIds"), list) or not isinstance(cov.get("blockers"), list): unk("coverage", "missing")
    else:
        chk("coverage: the same nine deployment ids, zero blockers", cov["expectedIds"] == (base.get("coverage") or {}).get("expectedIds") and len(cov["expectedIds"]) == 9 and cov["blockers"] == [], f"{len(cov['expectedIds'])} ids, {len(cov['blockers'])} blockers")
    # wallet admission still OFF; configs unchanged; fresh status; no policy-unavailable
    fl = S.get("enKeyFlags")
    if not isinstance(fl, dict) or "flag" not in S or "wallet" not in S or "statusWallet" not in S: unk("wallet admission state", "missing")
    else:
        chk("wallet admission absent: no flag, no wallet-admission.json, no walletAdmission config key, status walletAdmission null/false",
            S["flag"] is False and S["wallet"] == "absent" and fl.get("walletAdmission") is False and S["statusWallet"] in (None, False), {"flag": S["flag"], "wallet": S["wallet"], "statusWallet": S["statusWallet"]})
        chk("G4 stays inert: hostServices/challengeReplica config keys as in the baseline", {k: fl.get(k) for k in ("hostServices", "challengeReplica")} == {k: k in (B.get("enKeys") or []) for k in ("hostServices", "challengeReplica")}, fl)
    for k in ("cfg", "local", "runNode"):
        if k in S: chk(f"{k} sha unchanged from the baseline", S[k] == B.get(k))
        else: unk(f"{k} sha", "missing")
    age = S.get("statusAgeMs")
    if not isinstance(age, int) or age < 0: unk("network status freshness", f"statusAgeMs {age!r}")
    else: chk("network status fresh (< 5 s)", age < 5000, age)
    g = (snap.get("gate") or {}).get("policyUnavailable30min")
    if not isinstance(g, int): unk("policy-unavailable count", f"{g!r}")
    else: chk("no 'policy unavailable / chain quorum unavailable' node.log lines in the last 30 min (count only)", g == 0, g)
    # host-service metadata (hs2 is LIVE a02e9ecd; never repeated): the exact readings of its probe-after receipt
    if isinstance(hs, dict) and "http" in hs:
        chk("hs2 config sha unchanged (a02e9ecd)", hs.get("config") == hs_ref.get("config"), str(hs.get("config"))[:8])
        chk("hs2 listeners as in its probe-after", hs.get("listeners") == hs_ref.get("listeners"), hs.get("listeners"))
        chk("hs2 local HTTP readiness as in its probe-after (GET /health, HEAD bootstrap, challenge 404, unknown host 421)", hs.get("http") == hs_ref.get("http"), hs.get("http"))
        chk("no ACME account file", hs.get("accountExists") is False)
    # time since the restart, on ONE clock (both the new agent's start and the snapshot are minipc's)
    t0, t1 = ts(rr.get("newStart")), ts(S.get("at"))
    elapsed = round(t1 - t0, 1) if t0 is not None and t1 is not None else None
    if elapsed is None: unk("elapsed since restart", "newStart or snapshot time unreadable")
    # the restart starts the privacy agent's channel EMPTY (root's 23:20Z receipts: egress apps 9 -> 6 -> 7 within 96 s); the
    # >= 30-min observation is complete only once the egress routes are back to the baseline app count
    ea, eb = S.get("egressApps"), B.get("egressApps")
    if elapsed is not None and elapsed >= OBSERVE_S:
        if not isinstance(ea, int) or ea < 0 or not isinstance(eb, int): unk("egress routes at 30 min", f"egressApps {ea!r} / baseline {eb!r}")
        else: chk("egress routes back to the baseline app count (required for completion)", ea >= eb, f"{ea} of {eb}")
    info = {"wg": {"baseline": B.get("wg"), "now": S.get("wg"), "restartBefore": rr.get("wgBefore"), "restartAfter60s": rr.get("wgAfter60s")},
            "egressApps": {"baseline": B.get("egressApps"), "now": S.get("egressApps"), "recovering": isinstance(S.get("egressApps"), int) and isinstance(B.get("egressApps"), int) and S.get("egressApps") < B.get("egressApps")}, "shortLeases": (snap.get("gate") or {}).get("shortLeases"),
            "tasksChanged": sorted(set(S.get("tasks") or []) ^ set(B.get("tasks") or [])), "updateTask": S.get("update")}
    failed, unknown = [c for c in checks if c["ok"] is False], [c for c in checks if c["ok"] is None]
    status = ("UNHEALTHY" if failed else "UNAVAILABLE" if unknown else "OBSERVATION_COMPLETE_HEALTHY" if elapsed >= OBSERVE_S else "INITIAL_HEALTHY")
    return {"status": status, "elapsedSinceRestartSec": elapsed, "observationWindowSec": OBSERVE_S,
            "remainingSec": None if elapsed is None else max(0, round(OBSERVE_S - elapsed, 1)), "checks": checks, "informational": info}

EXIT = {"OBSERVATION_COMPLETE_HEALTHY": 0, "INITIAL_HEALTHY": 2, "UNHEALTHY": 3, "UNAVAILABLE": 4}

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument("--baseline", required=True); a.add_argument("--restart", required=True); o = a.parse_args(argv)
    bb, rb = pathlib.Path(o.baseline).read_bytes(), pathlib.Path(o.restart).read_bytes(); base, restart = json.loads(bb), json.loads(rb)
    R, hs_text = load_pinned(); hs_ref = json.loads(HS_AFTER[0].read_text())
    pre, hs = snapshot(R, hs_text); snap = reduce(pre, hs)
    rep = evaluate(base, restart, snap, hs_ref, R.FILES)
    prior = [json.loads(p.read_text()) for p in sorted(OUT.glob("observe-*.json"))] if OUT.exists() else []
    rep["priorSnapshotsForThisRestart"] = [{"at": p["at"], "status": p["report"]["status"], "elapsed": p["report"]["elapsedSinceRestartSec"]}
                                           for p in prior if p.get("restart", {}).get("sha256") == hashlib.sha256(rb).hexdigest()]
    rec = {"what": "observe", "at": now(), "baseline": {"path": o.baseline, "sha256": hashlib.sha256(bb).hexdigest()},
           "restart": {"path": o.restart, "sha256": hashlib.sha256(rb).hexdigest()}, "observer": sha(__file__), "snapshot": snap, "report": rep}
    OUT.mkdir(exist_ok=True); p = OUT / f"observe-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    with open(p, "x") as fh: json.dump(rec, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print(json.dumps({"receipt": str(p), "status": rep["status"], "elapsedSinceRestartSec": rep["elapsedSinceRestartSec"], "remainingSec": rep["remainingSec"],
                      "failed": [c for c in rep["checks"] if c["ok"] is False], "unavailable": [c for c in rep["checks"] if c["ok"] is None],
                      "informational": rep["informational"], "priorSnapshots": rep["priorSnapshotsForThisRestart"]}, indent=1))
    return EXIT[rep["status"]]

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
