

# ======================================================================================================================
# FAILURE AFTER ENROLMENT, BEFORE READY (root's cutover review, 2026-10-23). The same interop16.py helpers (one REAL indexd
# built from the c2-enclave source at schema v28, 30 loopback RHP4 hosts, the exact live 0.1.8 and the final 00e9cde0).
#   P  0.1.8 writes a legacy object (unenrolled account);
#   E  the corrected C2 config boots under a lease16 fact and is SIGKILLed the moment it logs the installed fence - it is
#      never ready - yet the account IS enrolled (CAS mode, the claim's fence): readiness is not the rollback criterion;
#   D  tools/cutover.py rollback-decision on the live enrolment state read from indexd says FORWARD_ONLY;
#   O  redeploying 0.1.8 is not a rollback: it cannot write, and indexd is unchanged;
#   F  the forward repair: C2 restarted under the same claim becomes ready and serves the legacy bytes and new writes.
# FIXTURE, loopback only: it proves the ordering on the real components, not production timing.
# ======================================================================================================================
sys.path.insert(0, os.path.join(RELEASE, "package", "tools"))
import cutover  # noqa: E402


def enrolment_state(pg):
    """what vm-state.sh reads on the live primary, from this run's indexer database"""
    return "\n".join([f"dbVersion={pg.q('SELECT db_version FROM global_settings')}",
                      f"fencedAccounts={pg.q('SELECT count(*) FROM accounts WHERE fence IS NOT NULL')}",
                      f"casEnrolledAccounts={pg.q('SELECT count(*) FROM accounts WHERE cas_mode')}"]) + "\n"


def main():
    global EGRESS
    preconditions()
    pg = PG()
    h = None
    EGRESS = None
    try:
        h = Harness(pg, hosts=30, indexers=1)
        EGRESS = Egress()
        url = h.post("/manifest")["indexers"][0]["url"]
        seed = hashlib.sha256(f"{run_id}/enrollfail-app-key".encode()).digest()
        pk = pubkey_hex(seed)
        h.post(f"/register?idx=0&pk={pk}")
        cw = {k: precompile(k) for k in ART}
        prod = json.load(open(CATALOG_C2))
        cfg018 = {"indexer": url, "appKey": seed.hex(), "region": REGION, "buckets": BUCKETS, "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}]}
        env = (f"SIA_APP_KEY={seed.hex()}", f"S3_ACCESS_KEY_ID={AK}", f"S3_SECRET_ACCESS_KEY={SK}",
               "SIAS3_REPLICAS=" + json.dumps([{"name": "r0", "indexer": url, "appKey": "$SIA_APP_KEY"}], separators=(",", ":")))

        old = Instance("v018-writer", "v018", cfg018, cw["v018"])
        if not check("P: the exact 0.1.8 is ready on the v28 indexer (unenrolled account)", old.wait_ready()):
            return
        st, _, _ = put(old, "ipfs", "legacy/one", "legacy1", 3 * MIB)
        check("P: 0.1.8 PUT ipfs/legacy/one", st == 200, st)
        old.stop()
        R["stateBefore"] = enrolment_state(pg)
        check("P: rollback-decision before any C2 boot: LEGACY_REDEPLOY_SAFE", cutover.rollback_decision(R["stateBefore"])["decision"] == "LEGACY_REDEPLOY_SAFE", R["stateBefore"])

        # ---------------- E: killed after the fence is installed, before readiness ----------------
        c2 = Instance("c2-killed-before-ready", "final", prod, cw["final"], (*env, *front_env(lease16(*CLAIM1))))
        t0, killed_at, text = time.time(), None, ""
        while time.time() - t0 < 600 and c2.alive():
            text = open(c2.log_path, errors="replace").read()
            if "installed on 1 of 1 replicas" in text:
                os.kill(c2.p.pid, signal.SIGKILL)
                killed_at = round(time.time() - t0, 3)
                break
            time.sleep(0.01)
        c2.stop()
        text = open(c2.log_path, errors="replace").read()
        R["killedAfterSeconds"] = killed_at
        check("E: C2 was killed right after logging its installed fence, and NEVER reported ready",
              killed_at is not None and "[sia-s3] ready" not in text, text[-800:])
        R["stateAfterKill"] = enrolment_state(pg)
        a = acct_row(pg, pk)
        check("E: yet the account IS enrolled: CAS mode and the claim's lease16 fence installed",
              a["casMode"] and a["seqEnabled"] and gen_matches(a["fenceGeneration"], gen16(*CLAIM1)), a)

        # ---------------- D: the decision reads the enrolment state, not readiness ----------------
        d = cutover.rollback_decision(R["stateAfterKill"])
        R["decision"] = d
        check("D: rollback-decision on that state: FORWARD_ONLY (never a legacy redeploy)", d["decision"] == "FORWARD_ONLY", d)

        # ---------------- O: 0.1.8 is not a rollback after enrolment ----------------
        before = acct_row(pg, pk)
        o = Instance("v018-after-kill", "v018", cfg018, cw["v018"])
        o.wait_ready(timeout=300)
        st = None
        if o.alive():
            try:
                st, _, _ = s3(o, "PUT", "ipfs", "by-0.1.8-after-enrolment", body=b"must be refused", timeout=300)
            except Exception as e:
                log("old client request error:", e)
        o.stop()
        check("O: a redeployed 0.1.8 cannot write to the enrolled account, and indexd is unchanged", st != 200 and acct_row(pg, pk) == before,
              {"PUT": st, "before": before, "after": acct_row(pg, pk)})

        # ---------------- F: forward repair ----------------
        f = Instance("c2-forward-repair", "final", prod, cw["final"], (*env, *front_env(lease16(*CLAIM1))))
        if check("F: C2 restarted under the same claim becomes ready", f.wait_ready()):
            verify_all(f, "F: the legacy bytes", ranges=False)
            st, _, _ = put(f, "jot", "after-repair", "repair", 1 * MIB)
            check("F: and writes", st == 200, st)
        f.stop()
    finally:
        for i in ALL:
            if i.alive():
                i.stop()
        if EGRESS:
            EGRESS.close()
        if h:
            h.close()
        pg.close()
        for d in (os.path.join(RUN, "harness", "hosts"), pg.data):
            shutil.rmtree(d, ignore_errors=True)
        for f in os.listdir(RUN):
            if f.endswith(".cwasm"):
                os.remove(os.path.join(RUN, f))
        R["cleanup"] = {"hostSectorsRemoved": not os.path.exists(os.path.join(RUN, "harness", "hosts")), "pgDataRemoved": not os.path.exists(pg.data),
                        "pgSocketDirRemoved": not os.path.exists(pg.sock),
                        "pidsLeftInNamespace": sorted(int(p) for p in os.listdir("/proc") if p.isdigit() and int(p) != os.getpid())}
        R["finished"] = time.time()
        R["passed"] = sum(c["ok"] for c in R["checks"])
        R["failed"] = sum(not c["ok"] for c in R["checks"])
        save()
        log("checks passed", R["passed"], "failed", R["failed"], "cleanup", R["cleanup"])


def acct_row(pg, pk):
    row = pg.q(f"SELECT encode(fence, 'hex'), cas_mode, seq_enabled, event_seq FROM accounts WHERE public_key = decode('{pk}', 'hex')")
    f, c, s, e = row.split("|")
    return {"fenceGeneration": f"0x{f[:16]}" if f else None, "casMode": c == "t", "seqEnabled": s == "t", "eventSeq": int(e)}


signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("driver wall bound 3000 s")))
signal.alarm(3000)
main()
sys.exit(0 if R.get("failed", 1) == 0 and R["checks"] else 1)
