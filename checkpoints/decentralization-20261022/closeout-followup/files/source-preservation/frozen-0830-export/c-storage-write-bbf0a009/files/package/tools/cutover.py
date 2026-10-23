#!/usr/bin/env python3
"""Storage distributed-write cutover: the owner's per-stage replica secret and root's step verifiers (CUTOVER.md).

Pure functions over files root captures with the EXISTING reviewed read-only tools: nothing here opens a network
connection, reads a key, or changes anything. Exit 0 = GO / PASS, 1 = NO-GO / FAIL (reasons printed as JSON), 2 = usage.

  cutover.py replicas --stage t1|t2|t4a|t4b --inputs replicas.json
      the exact $SIAS3_REPLICAS value for the stage (the sia-s3 C2 catalog config f6b48940 has NO writeQuorum, so the
      component takes the majority of the listed non-retiring members: t1 W=1/N=1; t2 primary + k new (k = 2..8), W = majority;
      t4a/t4b the k new (k >= 3: W=2 of N=3 tolerates one loss); 2 new are enough only while the primary stays a member)
  cutover.py t1-preflight --vm-state vm-state.out --backup <...-integrity-v2.json> --now <ISO8601+zone>
            --legacy-stopped-at <ISO8601+zone> --live-counts counts.json [--max-capture-age-hours 2] [--max-verify-age-hours 2]
      GO only for the live primary EXACTLY as prepared (release 2c0e5b06, schema 28, quiet, NO account fenced or enrolled),
      the legacy writer stopped BEFORE a fresh coupled v28 capture of the running release, and nothing written since
  cutover.py rollback-decision --vm-state vm-state.out
      LEGACY_REDEPLOY_SAFE / FORWARD_ONLY / UNKNOWN from the live fenced/CAS counts (never from readiness)
  cutover.py verify --stage t1|t2|t4a|t4b --healthz healthz.json --fact lease16.json --inputs replicas.json [--account-row row.txt]
      the public /healthz of the C2 deployment (and, for t1, root's read-only account row) against the stage's expectation
"""
import datetime, json, re, sys

RELEASE = "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7"   # the live primary's indexd (c2-enclave, schema 28)
LEDGER16D = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b"                       # live EnclaveDeployments rev 16d (Base 8453)
DO_ONLY = {"sia.enclave.host", "ipfs.enclave.host"}                               # resolve ONLY to the four DigitalOcean machines today
DO_ADDRESSES = {"134.199.235.187", "134.209.248.172", "165.245.191.129", "146.190.246.39"}
NAME = re.compile(r"[A-Za-z0-9_.-]{1,32}$")
KEYREF = re.compile(r"\$(\{[A-Z_][A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*)$")


class Refused(Exception):
    pass


def canonical(url):
    """sia-s3 config.rs canonical_indexer, restated: scheme, lowercase host without a trailing dot, port only when not the
    default, path without a trailing slash"""
    m = re.fullmatch(r"([Hh][Tt][Tt][Pp][Ss]?)://([^/:?#@]+)(?::(\d{1,5}))?(/[^?#]*)?", str(url))
    if not m:
        raise Refused(f"indexer URL {url!r}: http(s)://host[:port][/path] without credentials, query or fragment")
    scheme, host, port, path = m.group(1).lower(), m.group(2).lower().rstrip("."), m.group(3), (m.group(4) or "").rstrip("/")
    if port and int(port) == (443 if scheme == "https" else 80):
        port = None
    return f"{scheme}://{host}{':' + port if port else ''}{path}", host


def load_inputs(path, fixture_loopback=False):
    """replicas.json: {"appKeyRef": "$SIA_APP_KEY", "primary": {"name", "indexer"}, "new": [{"name", "indexer"}, {...}]}
    fixture_loopback: TESTS ONLY (never set by the CLI): new replicas on http://127.0.0.1 (the rehearsal's loopback indexers)"""
    with open(path) as f:
        j = json.load(f)
    ref = j.get("appKeyRef")
    if not isinstance(ref, str) or not KEYREF.fullmatch(ref):
        raise Refused("appKeyRef must be a $NAME reference to the deployment's existing app-key secret (never the key itself)")
    p, new = j.get("primary"), j.get("new")
    if not isinstance(p, dict) or not isinstance(new, list) or not 2 <= len(new) <= 8:
        raise Refused("inputs: one primary (the existing indexer) and 2 to 8 new replicas")
    seen_names, seen_urls = set(), set()
    out = []
    for role, r in [("primary", p)] + [("new", x) for x in new]:
        if not isinstance(r, dict) or set(r) != {"name", "indexer"}:
            raise Refused(f"{role} replica: exactly {{name, indexer}}")
        if not NAME.fullmatch(str(r["name"])) or r["name"] in seen_names:
            raise Refused(f"replica name {r['name']!r}: 1-32 of [A-Za-z0-9_.-], distinct")
        url, host = canonical(r["indexer"])
        if url in seen_urls:
            raise Refused(f"{url}: listed twice (one endpoint must never count as two quorum votes)")
        if role == "new":
            if not url.startswith("https://") and not (fixture_loopback and host == "127.0.0.1"):
                raise Refused(f"new replica {r['name']}: https only")
            if host in DO_ONLY or host in DO_ADDRESSES:
                raise Refused(f"new replica {r['name']}: {host} reaches only DigitalOcean today; a new replica needs a non-DigitalOcean ingress")
        seen_names.add(r["name"]); seen_urls.add(url)
        out.append({"name": r["name"], "indexer": url})
    return {"appKeyRef": ref, "primary": out[0], "new": out[1:]}


def stage_replicas(inp, stage, min_final_members=3):
    """min_final_members: retiring the existing primary must leave at least this many members (W = 2 of N = 3 tolerates one
    loss; 2 of 2 tolerates none). Only a fixture-scale check lowers it, explicitly."""
    p, n, ref = inp["primary"], inp["new"], inp["appKeyRef"]
    if stage in ("t4a", "t4b") and len(n) < min_final_members:
        raise Refused(f"retiring the existing primary would leave {len(n)} members (< {min_final_members}): no write fault tolerance; add a new replica or keep the primary as a member")
    entry = lambda r, retiring=False: {"name": r["name"], "indexer": r["indexer"], "appKey": ref, **({"retiring": True} if retiring else {})}
    if stage == "t1":
        return [entry(p)]
    if stage == "t2":
        return [entry(p)] + [entry(r) for r in n]
    if stage == "t4a":
        return [entry(p, True)] + [entry(r) for r in n]
    if stage == "t4b":
        return [entry(r) for r in n]
    raise Refused(f"unknown stage {stage!r}")


def write_quorum(reps):
    members = sum(1 for r in reps if not r.get("retiring"))
    return members, members // 2 + 1


# ---------------- T1 pre-enrollment preflight ----------------

def parse_kv(text):
    kv = {}
    for line in text.splitlines():
        line = line.strip()
        if "=" in line and not line.startswith(("#", "==")):
            k, v = line.split("=", 1)
            kv.setdefault(k.strip(), v.strip())
    return kv


def when(v, what):
    """an ISO-8601 time WITH its zone ('Z' or an offset) -> aware datetime; a naive or malformed time is refused"""
    try:
        t = datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        raise Refused(f"{what} {v!r} is not ISO 8601")
    if t.tzinfo is None:
        raise Refused(f"{what} {v!r} has no time zone")
    return t


SKEW = datetime.timedelta(seconds=60)


def t1_preflight(vm_text, receipt, now, legacy_stopped_at, live_counts, max_capture_age_h=2.0, max_verify_age_h=2.0,
                 expect_accounts=1, min_objects=1491, release=RELEASE):
    """GO only when, at `now`:
      - the live primary is exactly as prepared (vm-state.sh): release 2c0e5b06 current and running, schema 28, quiet, NO
        account fenced or CAS-enrolled;
      - the legacy writer (sia-s3 0.1.8 and anything else writing) was stopped at `legacy_stopped_at`, BEFORE the coupled
        backup was CAPTURED, and nothing was written since: the live counts root read now equal the backup's;
      - (release: the pinned live release; only the fixture tests pass their own binary's hash)
      - the backup is a v2 integrity result (package/backup/local/verify_archive.v2.py) that passed every check, is bound to
        its run, bundles the running release 2c0e5b06 with a schema-28 database from the minipc VM, and was CAPTURED (the
        authenticated manifest time, never the verification time) at most max_capture_age_h ago, not in the future, and
        verified after the capture and at most max_verify_age_h ago."""
    kv, why = parse_kv(vm_text), []
    want = {"current": release, "currentSha": release, "runningExeSha": release, "dbVersion": "28", "unit.ActiveState": "active",
            "unit.SubState": "running", "fencedAccounts": "0", "casEnrolledAccounts": "0", "scratchDatabases": "", "controllerSessions": "",
            "toolSessions": ""}
    for k, v in want.items():
        if kv.get(k) != v:
            why.append(f"{k} = {kv.get(k)!r}, need {v!r}")
    if not str(kv.get("lockHeld", "")).startswith("no"):
        why.append(f"lockHeld = {kv.get('lockHeld')!r}, need no")
    if kv.get("unit.NeedDaemonReload") not in (None, "no"):
        why.append("unit needs a daemon reload")
    r = receipt or {}
    if r.get("format") != "storage-fresh-backup-integrity/v2":
        why.append(f"backup: format {r.get('format')!r}: only a v2 integrity result carries the authenticated capture time")
    if r.get("pass") is not True or r.get("problems"):
        why.append(f"backup: pass {r.get('pass')!r}, problems {r.get('problems')!r}")
    for k in ("allMemberHashesMatch", "archiveSha256MatchesReceipt", "authenticatedDecryptionPassed", "membersExactlyExpected",
              "manifestEqualsPullTimeManifest", "coupledAndResumed", "manifestBoundToRun", "captureTimeAuthenticated"):
        if r.get(k) is not True:
            why.append(f"backup: {k} is not true")
    if r.get("plaintextPersistedLocally") is not False:
        why.append("backup: plaintext must not be persisted locally")
    if r.get("manifestRunId") != r.get("runId"):
        why.append(f"backup: manifest run {r.get('manifestRunId')!r} != receipt run {r.get('runId')!r}")
    if str(r.get("dbVersion")) != "28":
        why.append(f"backup: dbVersion {r.get('dbVersion')!r}; the pre-enrolment backup must be taken AFTER the v28 migration")
    if r.get("binarySha256") != release:
        why.append(f"backup: bundled indexd {r.get('binarySha256')!r} is not the running release {release[:8]} (a v26 binary with a v28 database cannot restore)")
    if r.get("source") != "minipc / enclave-storage":
        why.append(f"backup: source {r.get('source')!r}")
    counts = r.get("counts") or {}
    if counts.get("accounts") != expect_accounts or not (isinstance(counts.get("objects"), int) and counts["objects"] >= min_objects):
        why.append(f"backup: counts {counts!r}: need {expect_accounts} account(s) and at least {min_objects} objects")
    try:
        cap = when(r.get("capturedAt"), "backup capturedAt")
        ver = when(r.get("verifiedAt"), "backup verifiedAt")
        stop = when(legacy_stopped_at, "legacy-stopped-at")
        if cap > now + SKEW:
            why.append(f"backup: captured in the future ({r['capturedAt']})")
        elif now - cap > datetime.timedelta(hours=max_capture_age_h):
            why.append(f"backup: CAPTURED {(now - cap).total_seconds() / 3600:.2f} h ago (> {max_capture_age_h} h), whenever it was verified")
        if ver < cap:
            why.append("backup: verified before it was captured")
        if ver > now + SKEW:
            why.append("backup: verified in the future")
        elif now - ver > datetime.timedelta(hours=max_verify_age_h):
            why.append(f"backup: verified {(now - ver).total_seconds() / 3600:.2f} h ago (> {max_verify_age_h} h)")
        if stop > now + SKEW:
            why.append("legacy writer: stopped in the future")
        if stop > cap:
            why.append(f"legacy writer stopped at {legacy_stopped_at}, AFTER the capture {r['capturedAt']}: legacy writes may be missing from the backup")
    except Refused as e:
        why.append(str(e))
    lc = live_counts or {}
    if lc.get("objects") != counts.get("objects") or lc.get("accounts") != counts.get("accounts"):
        why.append(f"live counts {lc!r} != the backup's {counts!r}: something wrote after the capture (or the backup is not this database's)")
    return {"verdict": "GO" if not why else "NO-GO", "reasons": why, "release": kv.get("currentSha"), "schema": kv.get("dbVersion"),
            "capturedAt": r.get("capturedAt"), "dataLossBoundary": r.get("capturedAt")}


def rollback_decision(vm_text):
    """What a T1 rollback may do, decided ONLY by the live enrolment state (vm-state.sh), never by readiness: enrolment can
    commit before a later startup or readiness failure."""
    kv = parse_kv(vm_text)
    cas, fenced = kv.get("casEnrolledAccounts"), kv.get("fencedAccounts")
    if kv.get("dbVersion") != "28" or cas is None or fenced is None or not (str(cas).isdigit() and str(fenced).isdigit()):
        return {"decision": "UNKNOWN", "do": "nothing: re-read the state (an unread enrolment state is never 'not enrolled')",
                "state": {"dbVersion": kv.get("dbVersion"), "casEnrolledAccounts": cas, "fencedAccounts": fenced}}
    if cas == "0" and fenced == "0":
        return {"decision": "LEGACY_REDEPLOY_SAFE", "do": "stop any C2 instance, then redeploy 0.1.8: the account is neither fenced nor enrolled",
                "state": {"casEnrolledAccounts": 0, "fencedAccounts": 0}}
    return {"decision": "FORWARD_ONLY",
            "do": "keep C2 (restart it, or stay at N = 1) and repair forward. 0.1.8 cannot write to an enrolled account, and there is no "
                  "online downgrade. Restoring the pre-enrolment backup is NOT a routine rollback: it discards every write acknowledged "
                  "after that backup's capture time - root's explicit decision only, with the writers stopped.",
            "state": {"casEnrolledAccounts": int(cas), "fencedAccounts": int(fenced)}}


# ---------------- step verification from the public /healthz ----------------

def gen16(fact):
    return (16 << 48) | (int(fact["claimBlock"]) << 16) | int(fact["claimLogIndex"])


def fence_gen(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", value):
        return None
    n = int(value[2:], 16)
    return n if n < (1 << 63) else None


def check_fact(fact):
    if not isinstance(fact, dict) or fact.get("source") != "lease16" or fact.get("chainId") != 8453 or str(fact.get("ledger", "")).lower() != LEDGER16D \
            or not re.fullmatch(r"0x[0-9a-f]{64}", str(fact.get("deployment", ""))) or not all(isinstance(fact.get(k), int) and fact[k] >= 0 for k in ("claimBlock", "claimLogIndex")):
        raise Refused("fact: the front's lease16 fact of THIS deployment {source: lease16, chainId: 8453, ledger: rev 16d, deployment, claimBlock, claimLogIndex}")


def verify(stage, hz, fact, inp, account_row=None, min_final_members=3):
    check_fact(fact)
    why = []
    expect = stage_replicas(inp, stage, min_final_members)
    epoch = {"t1": 1, "t2": 2, "t4a": 3, "t4b": 3}[stage]
    wf = hz.get("writerFence") or {}
    auth = f"lease16 chain 8453 ledger {LEDGER16D} deployment {fact['deployment']} claim {fact['claimBlock']}/{fact['claimLogIndex']}"
    if hz.get("ready") is not True:
        why.append("not ready")
    if not str(wf.get("authority", "")).startswith(auth):
        why.append(f"writerFence.authority {wf.get('authority')!r} is not this deployment's lease16 claim ({auth})")
    if wf.get("mode") != "required" or (wf.get("c2") or {}).get("verified") is not True or (wf.get("c2") or {}).get("noCloneAssumed") is not False:
        why.append(f"writerFence: mode {wf.get('mode')!r}, c2 {wf.get('c2')!r}: need required, C2 verified, no clone assumption")
    if wf.get("isolation") not in ("Vbs", "Snp"):
        why.append(f"writerFence.isolation {wf.get('isolation')!r}: the front's constant (Vbs or Snp)")
    if fence_gen((wf.get("ballot") or {}).get("gen")) != gen16(fact):
        why.append(f"ballot generation {(wf.get('ballot') or {}).get('gen')!r} != 16<<48|claimBlock<<16|logIndex = {gen16(fact):#x}")
    if wf.get("superseded"):
        why.append(f"superseded: {wf.get('superseded')!r}")
    reps = hz.get("replicas") or []
    got = [(r.get("name"), canonical(r.get("indexer", ""))[0] if r.get("indexer") else None, bool(r.get("retiring"))) for r in reps]
    want = [(e["name"], e["indexer"], bool(e.get("retiring"))) for e in expect]
    if got != want:
        why.append(f"replica set {got} != the stage's secret {want}")
    members, wq = write_quorum(expect)
    if hz.get("writeQuorum") != wq:
        why.append(f"writeQuorum {hz.get('writeQuorum')!r} != the majority {wq} of {members} members")
    for r in reps:
        m, rec = r.get("membership") or {}, r.get("record") or {}
        if m.get("phase") != "stable" or (m.get("epoch") or 0) < epoch:
            why.append(f"{r.get('name')}: membership {m!r}, need stable at epoch >= {epoch}")
        if not r.get("retiring") and (r.get("loaded") is not True or r.get("behind") != 0 or rec.get("admitted") is not True or (rec.get("epoch") or 0) < epoch
                                      or r.get("voting") is not True or r.get("error") or r.get("forked")):
            why.append(f"{r.get('name')}: loaded {r.get('loaded')!r} behind {r.get('behind')!r} record {rec!r} voting {r.get('voting')!r} error {r.get('error')!r} forked {r.get('forked')!r}")
    if stage == "t1":
        # root's read-only row (vm-state style): "<fence hex>|<cas_mode t/f>|<seq_enabled t/f>|<event_seq>"
        if account_row is None:
            why.append("t1 needs the account row (fence|cas_mode|seq_enabled|event_seq)")
        else:
            parts = account_row.strip().split("|")
            if len(parts) != 4 or fence_gen("0x" + parts[0][:16]) != gen16(fact) or parts[1] != "t" or parts[2] != "t":
                why.append(f"account row {account_row.strip()!r}: need the installed fence = this claim's generation, cas_mode t, seq_enabled t")
    return {"verdict": "PASS" if not why else "FAIL", "stage": stage, "reasons": why, "epoch": epoch, "writeQuorum": wq, "members": members}


def read(path):
    with open(path) as f:
        return f.read()


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="cutover.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("replicas"); a.add_argument("--stage", required=True); a.add_argument("--inputs", required=True)
    b = sub.add_parser("t1-preflight"); b.add_argument("--vm-state", required=True); b.add_argument("--backup", required=True)
    b.add_argument("--now", required=True); b.add_argument("--legacy-stopped-at", required=True); b.add_argument("--live-counts", required=True)
    b.add_argument("--max-capture-age-hours", type=float, default=2.0); b.add_argument("--max-verify-age-hours", type=float, default=2.0)
    d = sub.add_parser("rollback-decision"); d.add_argument("--vm-state", required=True)
    c = sub.add_parser("verify"); c.add_argument("--stage", required=True, choices=["t1", "t2", "t4a", "t4b"]); c.add_argument("--healthz", required=True)
    c.add_argument("--fact", required=True); c.add_argument("--inputs", required=True); c.add_argument("--account-row")
    o = ap.parse_args(argv)
    try:
        if o.cmd == "replicas":
            reps = stage_replicas(load_inputs(o.inputs), o.stage)
            members, wq = write_quorum(reps)
            print(json.dumps(reps, separators=(",", ":")))
            print(json.dumps({"stage": o.stage, "members": members, "writeQuorum": wq}), file=sys.stderr)
            return 0
        if o.cmd == "rollback-decision":
            r = rollback_decision(read(o.vm_state))
            print(json.dumps(r, indent=1))
            return 0 if r["decision"] != "UNKNOWN" else 1
        if o.cmd == "t1-preflight":
            r = t1_preflight(read(o.vm_state), json.loads(read(o.backup)), when(o.now, "--now"), o.legacy_stopped_at, json.loads(read(o.live_counts)),
                             o.max_capture_age_hours, o.max_verify_age_hours)
        else:
            row = read(o.account_row) if o.account_row else None
            r = verify(o.stage, json.loads(read(o.healthz)), json.loads(read(o.fact)), load_inputs(o.inputs), row)
        print(json.dumps(r, indent=1))
        return 0 if r["verdict"] in ("GO", "PASS") else 1
    except Refused as e:
        print(json.dumps({"verdict": "REFUSED", "reason": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
