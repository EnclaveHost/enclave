

# ======================================================================================================================
# ROLLBACK ORDERING (root's review of 6fd7a929, 2026-10-23): observation alone must never authorize a legacy redeploy.
# The same interop16.py helpers; TWO independent indexers (r0, r1: own databases and wallets), 30 loopback RHP4 hosts, the
# exact live 0.1.8 and the final 00e9cde0. One account per indexer, as the live primary has one.
#   U (account A on r0) - the ORIGINAL ordering is unsafe:
#     U1 0.1.8 writes; S0 = a zero snapshot read while indexd RUNS;
#     U2 the ORIGINAL rollback-decision (the exact 6fd7a929 cutover.py) says LEGACY_REDEPLOY_SAFE; the new one says UNKNOWN;
#     U3 C2 activation is still enabled: a C2 instance enrols AFTER S0 (deterministic: started after S0, awaited in the DB);
#     U4 following the original plan ("stop any C2 instance, then redeploy 0.1.8") - 0.1.8 cannot write: the plan was wrong;
#     U5 the NEW procedure (R1 C2 disabled, R2 guard absent, R3 indexd stopped, R4 snapshot) on that state: FORWARD_ONLY.
#   S (account B on r1) - the safe never-enrolled rollback, only with its full preconditions:
#     S1 0.1.8 writes; S2 C2 starts while r1 is down (it cannot enrol); R1-R4: the snapshot behind the barrier has zero counts;
#     S3 the decision: UNKNOWN without the owner's attestation, LEGACY_REDEPLOY_SAFE with it;
#     S4 following it (guard back, indexd started, 0.1.8): 0.1.8 writes and reads; the post-check still shows 0 fenced / 0 CAS.
# The vm-state.v2.sh lines are DERIVED from fixture state: unit/MainPID/writerPids from the harness indexer's up/down, the
# start guard from the driver's own hold, the counts from the indexer's own database. FIXTURE, loopback only.
# ======================================================================================================================
sys.path.insert(0, os.path.join(RELEASE, "package", "tools"))
import cutover  # noqa: E402
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location("cutover_6fd7a929", os.environ["OLD_CUTOVER"])
old_cutover = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(old_cutover)
GUARD = {0: "present", 1: "present"}


def vm_state(pg, h, i):
    """vm-state.v2.sh's lines for indexer i (DERIVED from the fixture, see the header)"""
    up = [x for x in h.post("/manifest")["indexers"]][i]["up"]
    db = f"r{i}"
    return "\n".join([f"dbVersion={pg.q('SELECT db_version FROM global_settings', db)}",
                      f"unit.ActiveState={'active' if up else 'inactive'}", f"unit.SubState={'running' if up else 'dead'}",
                      f"unit.MainPID={'4242' if up else '0'}", f"writerPids={'4242' if up else ''}", f"allowLiveStart={GUARD[i]}",
                      f"fencedAccounts={pg.q('SELECT count(*) FROM accounts WHERE fence IS NOT NULL', db)}",
                      f"casEnrolledAccounts={pg.q('SELECT count(*) FROM accounts WHERE cas_mode', db)}",
                      "controllerSessions=", "toolSessions="]) + "\n"


def cas_of(pg, i):
    return pg.q("SELECT count(*) FROM accounts WHERE cas_mode", f"r{i}")


def main():
    global EGRESS
    preconditions()
    pg = PG()
    h = None
    EGRESS = None
    try:
        h = Harness(pg, hosts=30, indexers=2)
        EGRESS = Egress()
        urls = [x["url"] for x in h.post("/manifest")["indexers"]]
        seeds = [hashlib.sha256(f"{run_id}/rollbackorder-{n}".encode()).digest() for n in ("A", "B")]
        for i in (0, 1):
            h.post(f"/register?idx={i}&pk={pubkey_hex(seeds[i])}")
        cw = {k: precompile(k) for k in ART}
        prod = json.load(open(CATALOG_C2))
        cfg018 = lambda i: {"indexer": urls[i], "appKey": seeds[i].hex(), "region": REGION, "buckets": BUCKETS, "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}]}
        c2env = lambda i: (f"SIA_APP_KEY={seeds[i].hex()}", f"S3_ACCESS_KEY_ID={AK}", f"S3_SECRET_ACCESS_KEY={SK}",
                           "SIAS3_REPLICAS=" + json.dumps([{"name": f"r{i}", "indexer": urls[i], "appKey": "$SIA_APP_KEY"}], separators=(",", ":")),
                           *front_env(lease16(*CLAIM1)))

        # ================= U: the original ordering =================
        o = Instance("U-v018", "v018", cfg018(0), cw["v018"])
        check("U1: 0.1.8 is ready on r0 (account A unenrolled)", o.wait_ready())
        st, _, _ = put(o, "ipfs", "legacy/a", "a1", 2 * MIB); check("U1: 0.1.8 PUT", st == 200, st)
        o.stop()
        s0 = vm_state(pg, h, 0); R["U.S0"] = s0
        d_old, d_new = old_cutover.rollback_decision(s0), cutover.rollback_decision(s0, True)
        R["U.decisionOld"], R["U.decisionNew"] = d_old, d_new
        check("U2: S0 is a zero snapshot read while indexd RUNS; the ORIGINAL 6fd7a929 decision says LEGACY_REDEPLOY_SAFE",
              "casEnrolledAccounts=0" in s0 and "unit.ActiveState=active" in s0 and d_old["decision"] == "LEGACY_REDEPLOY_SAFE", d_old)
        check("U2: the NEW decision on the same unquiesced zero snapshot is UNKNOWN (even with the attestation)", d_new["decision"] == "UNKNOWN", d_new)
        c2 = Instance("U-c2-activation-still-enabled", "final", prod, cw["final"], c2env(0))     # the window: C2 activation not yet disabled
        t0 = time.time()
        while time.time() - t0 < 300 and cas_of(pg, 0) == "0" and c2.alive():
            time.sleep(0.2)
        R["U.enrolledAfterSeconds"] = round(time.time() - t0, 2)
        check("U3: a C2 instance enrols AFTER S0 (account A now in CAS mode)", cas_of(pg, 0) == "1", R["U.enrolledAfterSeconds"])
        c2.stop()                                                                        # the original plan: "stop any C2 instance"
        o2 = Instance("U-v018-redeploy", "v018", cfg018(0), cw["v018"])                 # "...then redeploy 0.1.8"
        o2.wait_ready(timeout=300)
        st = None
        if o2.alive():
            try:
                st, _, _ = s3(o2, "PUT", "ipfs", "after-original-rollback", body=b"must be refused", timeout=300)
            except Exception as e:
                log("0.1.8 request error:", e)
        o2.stop()
        check("U4: following the ORIGINAL decision, the redeployed 0.1.8 CANNOT write (the account is enrolled): the plan was unsafe",
              st != 200, {"PUT": st})
        GUARD[0] = "absent"                                                              # R2 (R1: no C2 instance runs or respawns)
        h.post("/stop?idx=0")                                                            # R3
        s4 = vm_state(pg, h, 0); R["U.R4"] = s4                                          # R4
        d = cutover.rollback_decision(s4, True); R["U.decisionAfterBarrier"] = d
        check("U5: the NEW procedure (barrier first, then the read): FORWARD_ONLY", d["decision"] == "FORWARD_ONLY"
              and "allowLiveStart=absent" in s4 and "unit.ActiveState=inactive" in s4, d)

        # ================= S: the safe never-enrolled rollback =================
        EXP.clear()                                                                      # account B's objects only (r1)
        o = Instance("S-v018", "v018", cfg018(1), cw["v018"])
        check("S1: 0.1.8 is ready on r1 (account B unenrolled)", o.wait_ready())
        st, _, _ = put(o, "git", "legacy/b", "b1", 2 * MIB); check("S1: 0.1.8 PUT", st == 200, st)
        verify_all(o, "S1: 0.1.8 reads", ranges=False)
        o.stop()
        h.post("/stop?idx=1")                                                            # r1 unreachable: C2 cannot enrol
        c2 = Instance("S-c2-cannot-reach", "final", prod, cw["final"], c2env(1))
        ready = c2.wait_ready(timeout=45)
        c2.stop()                                                                        # R1: C2 activation disabled, no instance left
        check("S2: a C2 instance ran while r1 was down, never became ready, and no instance remains", not ready and not c2.alive(), ready)
        GUARD[1] = "absent"                                                              # R2; R3: r1 is stopped
        s4 = vm_state(pg, h, 1); R["S.R4"] = s4
        d_no, d_yes = cutover.rollback_decision(s4, False), cutover.rollback_decision(s4, True)
        R["S.decisionWithoutAttestation"], R["S.decision"] = d_no, d_yes
        check("S3: behind the barrier the counts are zero; WITHOUT the owner's attestation the decision is UNKNOWN",
              "casEnrolledAccounts=0" in s4 and "fencedAccounts=0" in s4 and d_no["decision"] == "UNKNOWN" and d_no["missing"] == ["c2ActivationDisabledAttested"], d_no)
        check("S3: WITH it, LEGACY_REDEPLOY_SAFE", d_yes["decision"] == "LEGACY_REDEPLOY_SAFE", d_yes)
        GUARD[1] = "present"; h.post("/start?idx=1")                                     # follow it: guard back, indexd started
        # run r1 showed the live 0.1.8 PANICKING on its first GET right after its indexer restarted (sia_storage download.rs:336
        # "index out of bounds: the len is 27 but the index is 28"): the node respawns a crashed app, so do the same, bounded,
        # until a GET of the legacy object answers; every attempt and panic is recorded
        attempts, o, served = [], None, False
        for n in range(12):
            o = Instance(f"S-v018-redeploy-{n}", "v018", cfg018(1), cw["v018"])
            ok = o.wait_ready(timeout=300)
            st = None
            if ok and o.alive():
                try:
                    st = s3(o, "GET", "git", "legacy/b", timeout=300)[0]
                except Exception as e:
                    st = type(e).__name__
            text = open(o.log_path, errors="replace").read()
            attempts.append({"n": n, "ready": ok, "get": st, "alive": o.alive(), "panic": "panicked at" in text})
            if st == 200 and o.alive():
                served = True
                break
            o.stop(); time.sleep(20)
        R["S.redeployAttempts"] = attempts
        if check("S4: 0.1.8 redeployed serves its legacy object (attempts recorded; restarts only after a crash)", served, attempts):
            verify_all(o, "S4: 0.1.8 reads its legacy object", ranges=False)
            st, _, _ = put(o, "jot", "after-safe-rollback", "b2", 1 * MIB)
            check("S4: and writes (a real rollback, nothing lost)", st == 200, st)
        if o:
            o.stop()
        post = vm_state(pg, h, 1); R["S.post"] = post
        check("S4: the post-check still shows 0 fenced / 0 CAS on r1", "casEnrolledAccounts=0" in post and "fencedAccounts=0" in post, post)
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


signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("driver wall bound 3000 s")))
signal.alarm(3000)
main()
sys.exit(0 if R.get("failed", 1) == 0 and R["checks"] else 1)
