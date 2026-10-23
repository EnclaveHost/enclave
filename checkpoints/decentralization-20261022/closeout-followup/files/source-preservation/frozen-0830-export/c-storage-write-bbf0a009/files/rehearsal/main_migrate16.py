

# ======================================================================================================================
# STAGED CUTOVER REHEARSAL (storage-write-release, 2026-10-23). Everything above is interop16.py's helpers (pins, isolation,
# disposable PostgreSQL 18, harness-block c2e = REAL indexd built from the c2-enclave source at schema v28, RHP4 hosts on
# loopback, the egress SOCKS front, SigV4 S3, deterministic bodies), changed only to run several indexers and query any of
# their databases. This main() rehearses the production sequence of storage-activation-next/ACTIONS.json on that fixture:
#   P  the EXISTING single indexer r0 holds objects written by the exact live sia-s3 0.1.8 (unenrolled account);
#   B  the prepared catalog version config 7b9e7e75 (writeQuorum 2) with the T1 replica set (r0 only) REFUSES to start and
#      enrolls nothing - the release blocker this package fixes;
#   T1 the corrected config f6b48940 (no writeQuorum: majority of the listed members) with $SIAS3_REPLICAS = [r0] and the
#      front's lease16 fact makes the FIRST fenced C2 boot of 00e9cde0: epoch 1 admitted, r0 enrolled, legacy bytes read;
#   T2 the owner adds two INDEPENDENT indexers (own databases/wallets; the same app key registered on each) by a secrets
#      update: [r0, r1, r2] -> serves while migrating, writes during the migration, commits epoch 2 (stable, W = 2);
#      one replica down: reads and writes continue (2 of 3);
#   T4 the old indexer retires: [r0 retiring, r1, r2] -> stable, then [r1, r2] and r0 STOPPED: every key, legacy and new,
#      reads back byte-exact from the new set alone, and it writes;
#   O  the old 0.1.8 client against a new (enrolled) replica cannot write.
# FIXTURE, not production: loopback hosts, one machine, generated keys and bytes; it says nothing about real cross-host,
# cross-provider failure or fresh distributed writes in production (an explicit post-cutover gate).
# ======================================================================================================================

def acct(pg, db, pk):
    """the account row on one indexer database, or None (not registered there)"""
    row = pg.q(f"SELECT encode(fence, 'hex'), cas_mode, seq_enabled, event_seq FROM accounts WHERE public_key = decode('{pk}', 'hex')", db)
    if not row:
        return None
    f, c, s, e = row.split("|")
    return {"fenceGeneration": f"0x{f[:16]}" if f else None, "fenceCounter": int(f[16:32], 16) if f else None,
            "casMode": c == "t", "seqEnabled": s == "t", "eventSeq": int(e)}


def wait_membership(inst, want_epoch, label, timeout=1500):
    """until /healthz reports the membership phase stable at `want_epoch` (or later), and every MEMBER (not retiring) loaded,
    caught up (behind 0) and its newest record admitted at that epoch; -> (the last /healthz, reached)"""
    t, hz = time.time(), {}
    while time.time() - t < timeout and inst.alive():
        hz = inst.healthz()
        reps = hz.get("replicas") or []
        ms = [(r.get("membership") or {}) for r in reps]
        members = [r for r in reps if not r.get("retiring")]
        recs = [(r.get("record") or {}) for r in members]
        if reps and all(m.get("phase") == "stable" and (m.get("epoch") or 0) >= want_epoch for m in ms) \
                and all(rc.get("admitted") is True and (rc.get("epoch") or 0) >= want_epoch for rc in recs) \
                and all(r.get("loaded") is True and r.get("behind") == 0 for r in members):
            log(label, "stable at epoch", [m.get("epoch") for m in ms], "after", round(time.time() - t), "s")
            R.setdefault("membership", {})[label] = {"seconds": round(time.time() - t), "replicas": [{"name": r.get("name"), "membership": r.get("membership"), "record": r.get("record")} for r in reps]}
            R.setdefault("healthz", {})[label] = hz                 # the public /healthz (no keys or object names): input of the step verifiers
            return hz, True
        time.sleep(10)
    R.setdefault("membership", {})[label] = {"timeout": True, "last": hz}
    return hz, False


def main():
    global EGRESS
    preconditions()
    pg = PG()
    h = None
    EGRESS = None
    try:
        h = Harness(pg, hosts=30, indexers=3)              # sia-s3 uploads need 30 hosts (run m1 at 14: "not enough initial hosts")
        EGRESS = Egress()
        man = h.post("/manifest")["indexers"]
        urls = [i["url"] for i in man]
        R["indexers"] = man
        dbv = [pg.q("SELECT db_version FROM global_settings", f"r{i}") for i in range(3)]
        check("backend: three independent indexers (own databases), each at schema exactly v28 (c2-enclave)", dbv == ["28"] * 3 and len(set(i["database"] for i in man)) == 3, dbv)
        seed = hashlib.sha256(f"{run_id}/migrate16-app-key".encode()).digest()
        pk = pubkey_hex(seed)
        R["appKeyPublic"] = pk
        r = h.post(f"/register?idx=0&pk={pk}")
        log("app key registered on r0 (the existing primary)", "attachedHosts", r.get("attachedHosts"))
        cw = {k: precompile(k) for k in ART}
        prod = json.load(open(CATALOG_C2))
        old_cfg = json.load(open(CATALOG_OLD))
        check("config: the corrected catalog version config equals the prepared one minus writeQuorum (no other byte changed)",
              open(CATALOG_C2).read() == open(CATALOG_OLD).read().replace('"writeQuorum":2,', ''), "")
        secrets_env = (f"SIA_APP_KEY={seed.hex()}", f"S3_ACCESS_KEY_ID={AK}", f"S3_SECRET_ACCESS_KEY={SK}")

        def replicas(*items):
            """the owner's $SIAS3_REPLICAS secret: names, indexer URLs, the app key BY REFERENCE ($SIA_APP_KEY), retiring flags"""
            return "SIAS3_REPLICAS=" + json.dumps([{"name": n, "indexer": urls[i], "appKey": "$SIA_APP_KEY", **({"retiring": True} if ret else {})} for n, i, ret in items],
                                                  separators=(",", ":"))

        def c2(name, *items, fact=lease16(*CLAIM1), cfg=prod):
            return Instance(name, "final", cfg, cw["final"], (*secrets_env, replicas(*items), *front_env(fact)))

        # ---------------- P: the existing single indexer, populated by the exact live 0.1.8 ----------------
        cfg018 = {"indexer": urls[0], "appKey": seed.hex(), "region": REGION, "buckets": BUCKETS, "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}]}
        old = Instance("v018-writer", "v018", cfg018, cw["v018"])
        if not check("P: the exact live 0.1.8 becomes ready on the existing v28 indexer r0 (unenrolled account)", old.wait_ready()):
            return
        for b, k, tag, n in (("ipfs", "legacy/small", "p-small", 100_000), ("git", "legacy/big", "p-big", 12 * MIB), ("machines", "legacy/mid", "p-mid", 3 * MIB)):
            st, _, out = put(old, b, k, tag, n)
            check(f"P: 0.1.8 PUT {b}/{k} ({n} B)", st == 200, f"{st} {out[:200]!r}")
        verify_all(old, "P: 0.1.8 reads its own writes")
        old.stop()
        R["db"]["P"] = {f"r{i}": acct(pg, f"r{i}", pk) for i in range(3)}
        check("P: before T1: r0 holds the account unenrolled (no fence, no CAS); r1/r2 do not know it",
              R["db"]["P"]["r0"] and R["db"]["P"]["r0"]["fenceGeneration"] is None and not R["db"]["P"]["r0"]["casMode"]
              and R["db"]["P"]["r1"] is None and R["db"]["P"]["r2"] is None, R["db"]["P"])

        # ---------------- B: the prepared config (writeQuorum 2) cannot boot the N = 1 step and enrolls nothing ----------------
        bad = c2("prepared-config-n1", ("r0", 0, False), cfg=old_cfg)
        ready = bad.wait_ready(timeout=90)
        bad.stop()
        blog = open(bad.log_path, errors="replace").read()
        check("B: the PREPARED catalog config (writeQuorum 2) with $SIAS3_REPLICAS = [r0] refuses to start (writeQuorum must be 1-1)",
              not ready and "writeQuorum must be 1-1" in blog, blog[-600:])
        R["db"]["B"] = acct(pg, "r0", pk)
        check("B: and enrolled nothing (r0 account still unfenced, not CAS)", R["db"]["B"]["fenceGeneration"] is None and not R["db"]["B"]["casMode"], R["db"]["B"])

        # ---------------- T1: first fenced C2 boot, corrected config, N = 1 ----------------
        t1 = c2("T1-r0", ("r0", 0, False))
        if not check("T1: the corrected config with [r0] and the lease16 fact makes the FIRST fenced C2 boot (ready)", t1.wait_ready()):
            return
        hz, ok = wait_membership(t1, 1, "T1")
        wf = hz.get("writerFence") or {}
        check("T1: membership stable at epoch 1 with r0's record admitted; lease16 authority, Vbs, C2 verified, ballot = the claim's generation",
              ok and wf.get("isolation") == "Vbs" and (wf.get("c2") or {}).get("verified") is True and gen_matches((wf.get("ballot") or {}).get("gen"), gen16(*CLAIM1)),
              {"writerFence": wf, "replicas": hz.get("replicas")})
        R["db"]["T1"] = acct(pg, "r0", pk)
        R["db"]["T1row"] = pg.q(f"SELECT encode(fence, 'hex'), cas_mode, seq_enabled, event_seq FROM accounts WHERE public_key = decode('{pk}', 'hex')", "r0")
        R["lease16Fact"] = lease16(*CLAIM1)
        check("T1: r0 is ENROLLED (CAS mode, sequence on) under the claim-1 lease16 generation",
              R["db"]["T1"]["casMode"] and R["db"]["T1"]["seqEnabled"] and gen_matches(R["db"]["T1"]["fenceGeneration"], gen16(*CLAIM1)), R["db"]["T1"])
        verify_all(t1, "T1: every 0.1.8 object reads back byte-exact")
        st, _, _ = put(t1, "jot", "t1/after-enrollment", "t1", 2 * MIB)
        check("T1: writes after enrollment", st == 200, st)
        t1.stop()                                                                       # one writer at a time: stop before the redeploy

        # ---------------- T2: two independent replicas join (owner secrets update), N = 3, W = 2 ----------------
        for i in (1, 2):
            r = h.post(f"/register?idx={i}&pk={pk}")
            log(f"app key registered on r{i}", "attachedHosts", r.get("attachedHosts"))
        t2 = c2("T2-r0r1r2", ("r0", 0, False), ("r1", 1, False), ("r2", 2, False))
        if not check("T2: [r0, r1, r2] (same claim) becomes ready while migrating: the old indexer keeps serving", t2.wait_ready()):
            return
        verify_all(t2, "T2: during the migration every key reads back", ranges=False)
        st, _, _ = put(t2, "ipfs", "t2/during-migration", "t2d", 1 * MIB)
        check("T2: writes DURING the migration", st == 200, st)
        hz, ok = wait_membership(t2, 2, "T2")
        check("T2: the change commits: stable at epoch 2 on all three, every record admitted", ok, hz.get("replicas"))
        R["db"]["T2"] = {f"r{i}": acct(pg, f"r{i}", pk) for i in range(3)}
        check("T2: r1 and r2 are enrolled (CAS) under the same lease16 generation as r0",
              all(R["db"]["T2"][f"r{i}"] and R["db"]["T2"][f"r{i}"]["casMode"] and gen_matches(R["db"]["T2"][f"r{i}"]["fenceGeneration"], gen16(*CLAIM1)) for i in range(3)), R["db"]["T2"])
        verify_all(t2, "T2: stable N=3 W=2")
        h.post("/stop?idx=2")
        st, _, _ = put(t2, "machines", "t2/one-replica-down", "t2x", 1 * MIB)
        check("T2: one replica (r2) down: writes still commit (W = 2 of 3)", st == 200, st)
        verify_all(t2, "T2: one replica down: reads", ranges=False)
        h.post("/start?idx=2")
        t2.stop()

        # ---------------- T4: the old indexer retires ----------------
        t4 = c2("T4-r0-retiring", ("r0", 0, True), ("r1", 1, False), ("r2", 2, False))
        if not check("T4: [r0 retiring, r1, r2] becomes ready", t4.wait_ready()):
            return
        hz, ok = wait_membership(t4, 3, "T4-retiring")
        check("T4: the retirement commits: stable at epoch 3 (members r1, r2)", ok, hz.get("replicas"))
        t4.stop()
        t5 = c2("T4-r1r2", ("r1", 1, False), ("r2", 2, False))
        if not check("T4: [r1, r2] (r0 dropped from the list) becomes ready", t5.wait_ready()):
            return
        hz, ok = wait_membership(t5, 3, "T4-final")
        check("T4: [r1, r2] is the committed stable set (epoch 3), both members loaded and caught up", ok, hz.get("replicas"))
        h.post("/stop?idx=0")                                                           # the old primary is gone
        verify_all(t5, "T4: with r0 STOPPED, every key (legacy 0.1.8, T1, T2) reads back byte-exact from r1 + r2 alone")
        st, _, _ = put(t5, "git", "t4/new-set", "t4", 2 * MIB)
        check("T4: the new set writes (W = 2 of 2)", st == 200, st)
        verify_all(t5, "T4: final state", ranges=False)
        t5.stop()

        # ---------------- O: the old client against a new, enrolled replica ----------------
        cfg018b = {**cfg018, "indexer": urls[1]}
        R["db"]["beforeOld"] = acct(pg, "r1", pk)
        o = Instance("v018-on-r1", "v018", cfg018b, cw["v018"])
        o.wait_ready(timeout=300)
        st = None
        if o.alive():
            try:
                st, _, _ = s3(o, "PUT", "ipfs", "by-0.1.8-on-new-replica", body=b"must be refused", timeout=300)
            except Exception as e:
                log("old client request error:", e)
        o.stop()
        R["db"]["afterOld"] = acct(pg, "r1", pk)
        check("O: 0.1.8 cannot write to an enrolled new replica, which is unchanged", st != 200 and R["db"]["afterOld"] == R["db"]["beforeOld"],
              {"PUT": st, "before": R["db"]["beforeOld"], "after": R["db"]["afterOld"]})
    finally:
        for i in ALL:
            if i.alive():
                i.stop()
        R["egressConnects"] = EGRESS.connects() if EGRESS else None
        if EGRESS:
            EGRESS.close()
        if h:
            h.close()
        pg.close()
        du = subprocess.run(["du", "-sm", RUN], capture_output=True, text=True).stdout.split()
        R["diskBeforeCleanupMiB"] = int(du[0]) if du else None
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


signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("driver wall bound 6600 s")))
signal.alarm(6600)
main()
sys.exit(0 if R.get("failed", 1) == 0 and R["checks"] else 1)
