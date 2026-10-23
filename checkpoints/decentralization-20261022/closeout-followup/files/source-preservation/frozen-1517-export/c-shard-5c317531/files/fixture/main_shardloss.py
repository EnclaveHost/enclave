# ======================================================================================================================
# SHARD LOSS through the ACTUAL C2 component (storage-shard-recovery). Reuses storage-write-release's interop16 helpers
# (_base.py bd92f094, read-only) and the same backend: harness-block c2e = REAL indexd (c2-enclave source) on a private
# PostgreSQL 18, ONE indexer, 30 loopback RHP4 hosts, the egress front, wasmtime. Artifacts:
#   old   = 00e9cde0 (the C2 candidate; rebuilt byte-identically from storage-shard-recovery 5c9717f/ac84cbb)
#   fixed = the candidate built from e99498e (download.rs shard topology fix), hash pinned by shardloss.sh
#   v018  = the exact live 0.1.8 (legacy writer)
# With 30 hosts every host holds exactly ONE shard of every slab (10+20), so indexd cannot migrate a lost shard to a
# fresh host: the topology the reader sees is the one this driver sets.
# FIXTURE-ONLY mutation: `UPDATE hosts SET recent_uptime = 0.01` on chosen hosts in the PRIVATE indexer database.
# - indexd's usability filter needs recent_uptime >= 0.9 (persist/postgres/hosts.go:76), so GET /hosts (usableHosts)
#   omits them.
# - The 3-month half-life keeps it below 0.9 for the run.
# - indexd's blockhosts maintenance may additionally block them, which is what blocked 3 hosts in r1.
# - Every reader is a FRESH instance, so its first host refresh sees the reduced list.
#   P  0.1.8 writes a legacy object (account unenrolled).
#   W  the fixed C2 enrols the account (CAS) and writes a one-slab object and a two-slab object; everything reads exactly.
#   S1 ONE storage endpoint lost (the host of shard 0 of the one-slab object): the old artifact's GETs are RECORDED (a
#      panic needs index 29 to complete before 10 shards; not deterministic); the fixed artifact reads every object exactly.
#   D  hosts of shards 0-14 of the one-slab object lost (parity-only recovery for that slab, 15 of 30 for every slab):
#      the old artifact TRAPS at download.rs:336 (deterministic negative control); the fixed one reads all exactly.
#   I  six more hosts lost (21 of 30: 9 shards left): the fixed artifact answers a GET with an error, never bytes, and
#      keeps serving.
#   Fencing and CAS custody: the account row (fence, cas_mode, seq) is unchanged by the readers.
# ======================================================================================================================
_c2 = CATALOG_C2                                                  # _base.py resolves it under its own release directory
CATALOG_C2 = os.path.join(WORK, "resume-after-checkpoint-20261022/storage-write-release/client/catalog-config.c2.json")
PINS[CATALOG_C2] = PINS.pop(_c2)                                  # the same pinned file (f6b48940), by its real path
FIXED = os.environ["SHARDLOSS_FIXED"]
ART["fixed"] = FIXED
PINS[FIXED] = os.environ["SHARDLOSS_FIXED_SHA256"]
MIB_ = 1 << 20
SIZES = {"legacy": 3 * MIB_, "one": 2 * MIB_, "big": 44 * MIB_}   # distinct slab lengths identify the slabs in SQL


def slab_hosts(pg, length):
    """slab_index -> host public key (hex) of the one object slab with this object length"""
    rows = pg.q(f"""SELECT ss.slab_index || ':' || encode(h.public_key, 'hex') FROM object_slabs os
        JOIN slabs sl ON sl.digest = os.slab_digest JOIN slab_sectors ss ON ss.slab_id = sl.id
        JOIN sectors s ON s.id = ss.sector_id JOIN hosts h ON h.id = s.host_id
        WHERE os.slab_length = {length} ORDER BY ss.slab_index""").split()
    m = {int(r.split(":")[0]): r.split(":")[1] for r in rows}
    assert sorted(m) == list(range(30)) and len(set(m.values())) == 30, (length, len(rows))
    return m


def lose(pg, keys, label):
    """FIXTURE mutation: the hosts fall below indexd's usability threshold"""
    lst = ",".join(f"decode('{k}', 'hex')" for k in keys)
    pg.q(f"UPDATE hosts SET recent_uptime = 0.01 WHERE public_key IN ({lst}) RETURNING id")
    R["db"].setdefault("lost", {})[label] = len(keys)
    low = int(pg.q("SELECT count(*) FROM hosts WHERE recent_uptime < 0.9"))
    log(label, "hosts below the usability uptime:", low)
    return low


def get_all(inst, label):
    """GET every expected object once; per key: status, digest match, or the exception; plus whether the process lives"""
    out = {}
    for (b, k), (tag, n) in sorted(EXP.items()):
        hs = Sink()
        try:
            st, hd, _ = s3(inst, "GET", b, k, timeout=600, sink=hs)
            cl = int(hd.get("content-length", -1))
            # C2 sends Content-Length with the head; a download failing after it closes the connection, so the ONLY
            # failure signal a client gets is a body shorter than Content-Length (sia-s3 src/s3.rs, "a short body")
            out[k] = {"status": st, "contentLength": cl, "received": hs.n,
                      "exact": st == 200 and cl == n and hs.n == n and hs.hexdigest() == expected_digest(tag, n),
                      "signalledFailure": st != 200 or (cl >= 0 and hs.n < cl)}
        except Exception as e:
            out[k] = {"error": type(e).__name__}
        if not inst.alive():
            out[k]["processDied"] = True
            break
    text = open(inst.log_path, errors="replace").read()
    res = {"gets": out, "alive": inst.alive(), "panic336": "download.rs:336" in text and "index out of bounds" in text,
           "panicLine": next((l.strip() for l in text.splitlines() if "index out of bounds" in l), None)}
    R.setdefault("reads", {})[label] = res
    log(label, json.dumps(res)[:400])
    return res


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
        seed = hashlib.sha256(f"{run_id}/shardloss-A".encode()).digest()
        pk = pubkey_hex(seed)
        h.post(f"/register?idx=0&pk={pk}")
        cw = {k: precompile(k) for k in ("v018", "final", "fixed")}
        prod = json.load(open(CATALOG_C2))
        cfg018 = {"indexer": url, "appKey": seed.hex(), "region": REGION, "buckets": BUCKETS, "credentials": [{"accessKeyId": AK, "secretAccessKey": SK}]}
        c2env = (f"SIA_APP_KEY={seed.hex()}", f"S3_ACCESS_KEY_ID={AK}", f"S3_SECRET_ACCESS_KEY={SK}",
                 "SIAS3_REPLICAS=" + json.dumps([{"name": "r0", "indexer": url, "appKey": "$SIA_APP_KEY"}], separators=(",", ":")),
                 *front_env(lease16(*CLAIM1)))
        reader = lambda name, art: Instance(name, art, prod, cw[art], c2env)

        # ---- P + W ----
        o = Instance("P-v018", "v018", cfg018, cw["v018"])
        check("P: the live 0.1.8 is ready (account unenrolled)", o.wait_ready())
        st, _, _ = put(o, "ipfs", "legacy", "legacy", SIZES["legacy"]); check("P: 0.1.8 writes the legacy object", st == 200, st)
        o.stop()
        w = reader("W-fixed", "fixed")
        check("W: the fixed C2 is ready (enrols the account)", w.wait_ready())
        for k in ("one", "big"):
            st, _, _ = put(w, "ipfs", k, k, SIZES[k]); check(f"W: the fixed C2 writes '{k}' ({SIZES[k]} bytes)", st == 200, st)
        verify_all(w, "W: fixed C2, all hosts", ranges=False)
        w.stop()
        row0 = fence_row(pg, pk); R["db"]["rowAfterWrites"] = row0
        check("W: the account is fenced and CAS-enrolled", row0["casMode"] and row0["fenceHex"], row0)
        one = slab_hosts(pg, SIZES["one"])
        R["db"]["oneSlabHosts"] = {i: k[:16] for i, k in one.items()}

        # ---- S1: one storage endpoint lost ----
        lose(pg, [one[0]], "S1")
        old_runs = []
        for n in range(3):
            r = reader(f"S1-old-{n}", "final")
            ready = r.wait_ready(timeout=300)
            res = get_all(r, f"S1-old-{n}") if ready else {"ready": False}
            old_runs.append(res)
            r.stop()
            if res.get("alive") and all(g.get("exact") for g in res.get("gets", {}).values()):
                pass
        R["S1.old"] = old_runs
        log("S1 old artifact (recorded, not a check):", sum(1 for x in old_runs if x.get("panic336")), "of", len(old_runs), "instances panicked")
        r = reader("S1-fixed", "fixed")
        check("S1: the fixed C2 is ready with one storage endpoint lost", r.wait_ready(timeout=300))
        res = get_all(r, "S1-fixed")
        check("S1: one endpoint lost: the fixed C2 reads every object byte-exact and stays up",
              all(g.get("exact") for g in res["gets"].values()) and res["alive"] and not res["panic336"], res)
        verify_all(r, "S1: fixed C2, ranges", ranges=True)
        r.stop()

        # ---- D: parity-only recovery for the one-slab object ----
        lose(pg, [one[i] for i in range(15)], "D")
        r = reader("D-old", "final")
        ready = r.wait_ready(timeout=300)
        res = get_all(r, "D-old") if ready else {"ready": False}
        r.stop()
        check("D NEGATIVE CONTROL: the old artifact 00e9cde0 traps at download.rs:336 (index out of bounds) and its GET gets no answer",
              ready and res.get("panic336") and not res.get("alive") and not any(g.get("exact") for g in res["gets"].values()), res)
        r = reader("D-fixed", "fixed")
        check("D: the fixed C2 is ready with 15 of 30 hosts lost", r.wait_ready(timeout=300))
        res = get_all(r, "D-fixed")
        check("D: the fixed C2 reads every object byte-exact (the one-slab object from parity shards 15-29 only) and stays up",
              all(g.get("exact") for g in res["gets"].values()) and res["alive"] and not res["panic336"], res)
        r.stop()

        # ---- I: insufficient shards ----
        lose(pg, [one[i] for i in range(15, 21)], "I")
        r = reader("I-fixed", "fixed")
        ready = r.wait_ready(timeout=300)
        res = get_all(r, "I-fixed") if ready else {"ready": False}
        hz = r.healthz() if r.alive() else {}
        r.stop()
        itext = open(r.log_path, errors="replace").read()
        check("I: 9 of 30 shards left: every GET signals failure (an error status, or a body SHORTER than its Content-Length: never "
              "a complete-looking object); C2 logs 'not enough shards', keeps running and serves /healthz",
              ready and res.get("alive") and not res.get("panic336") and all(g.get("signalledFailure") and not g.get("exact") for g in res["gets"].values())
              and itext.count("not enough shards: 9/10") >= len(res["gets"]) and hz.get("ready") is True,
              {"res": res, "healthz": {k: hz.get(k) for k in ("ready", "status")}})

        row1 = fence_row(pg, pk); R["db"]["rowAfterReads"] = row1
        starts = sum(1 for i in ALL if i.name.startswith(("S1-", "D-", "I-")))
        keep = ("fenceGeneration", "casMode", "seqEnabled", "eventSeq", "objects")
        check(f"custody: the readers changed neither the fence generation, CAS enrolment, the event sequence nor the objects; the "
              f"same-generation ballot counter rose by exactly one per reader start ({starts}), as C2 installs at every start",
              {k: row1[k] for k in keep} == {k: row0[k] for k in keep} and row1["fenceCounter"] == row0["fenceCounter"] + starts,
              {"before": row0, "after": row1, "readerStarts": starts})
    finally:
        for i in ALL:
            if i.alive():
                i.stop()
        if EGRESS is not None:
            EGRESS.close()
        if h is not None:
            h.close()
        pg.close()
        R["cleanup"] = {"pgDataRemoved": not os.path.exists(pg.data), "noWasmtime": not any(i.alive() for i in ALL)}
        R["finished"] = time.time()
        failed = [c["name"] for c in R["checks"] if not c["ok"]]
        R["summary"] = {"checks": len(R["checks"]), "failed": failed}
        save()
        log("SUMMARY", json.dumps(R["summary"]))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
