#!/usr/bin/env python3
"""C2 PHASE A3 REHEARSAL on copies of REAL production metadata, isolated and offline (storage-enclave-rehearsal).
A port of work/indexd-c2-production-rehearsal/rehearse-c2.py (e2cc1aed, run2 20/20 with the OLD binaries) to the NEW
reproducible binaries and matching tool code.
- Every phase S0-S10 and L0-L6, every assertion and every comparison is byte-identical to the original (test/test_rehearsal.py
  checks this by AST).
- What changed:
  * the pins: fence-enclave c67ffa4d (v27) and c2-enclave 2c0e5b06 (v28); the tools are rebuilt from the matching trees;
  * the controller: storage-enclave-fixture 91dc928d, used by the root-passed eight-stage fixture;
  * resource OWNERSHIP: one exclusive per-run stage and labelled, journaled docker objects through the reviewed c2fx
    (rhfx.py), instead of fixed names, a `finally: rm -f` and a process-name scan.

Route: deployed v26 -> 27 (fence-enclave) -> 28 (c2-enclave) and the controlled 28 -> 27 -> 26 rollback.

Inputs:
  - root's EXISTING captures (work/indexd-production-rehearsal): the historical retirement snapshot and the captured
    live dump;
  - NOT a fresh quiesced cutover backup;
  - only READ (streamed or copied into the stage) and verified against root's receipts (hashes);
  - the receipt counts are compared as before.

Run ONLY as one shared-queue job, entering a fresh user+network namespace (loopback only), via rehearse/run.sh.
  run-c2.py --plan | --execute <manifest> | --recover <run id>

Isolation (unchanged from the original):
  - This script, the controller, every indexd (runner "process") and the fixture client run in that namespace: loopback
    only, no DNS, egress, chain peers, explorer or hosts. The fixed loopback ports are private to the namespace.
  - PostgreSQL runs with --network none and is reached ONLY through its unix socket, bind-mounted from the stage.
  - Tool containers share ONLY PostgreSQL's empty network namespace.

Memory (16 GiB floor, no swap). Proposed total 1024 MiB; root decides:
  - the job cgroup: 512 MiB (python, controller, one indexd at GOMEMLIMIT 256MiB, the client, docker/psql CLIs);
  - outside it, docker hard caps: PostgreSQL 256m; ONE tool container at a time, 256m, database-only phases with no
    indexd running.

Secrets:
  - FIXTURE only, generated here (0600, exclusive) inside the stage: PostgreSQL password, admin password, a FRESH
    recovery phrase from the C2 binary's own `indexd seed`, the fixture app key.
  - The production wallet seed is NOT used. wallet_hash is set to NULL on the disposable copy (phase S0b, unchanged).

Never printed: table contents, customer metadata, keys, configs or dump contents. Results hold counts, digests and
booleans.
"""
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
WORK = next(p for p in PKG.parents if p.name == "work")
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import rhfx  # noqa: E402  (loads the reviewed storage-enclave-fixture c2fx.py, hash-pinned, read-only)
c2fx = rhfx.c2fx

INP = WORK / "indexd-production-rehearsal"                      # root's EXISTING private captures (read only)
SNAP = INP / "retirement-snapshot"
LIVE = INP / "live-indexd-20261020.pgdump"
FIX = WORK / "claude-resumed-20261022" / "storage-enclave-fixture"
BUILD = WORK / "claude-resumed-20261022" / "storage-enclave-build"
ROLLOUT = WORK / "indexd-replica-rollout"
IMG = c2fx.IMAGE
ORIG_SHA = "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc"   # deployed v0.6.0 (v26), from the snapshot
FENCE_SHA = "c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568"  # fence-enclave (v27, enclave-small), reproducible A1
C2_SHA = "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7"     # c2-enclave (v28, enclave-small), reproducible A1
BINARIES = {"indexd-original": (SNAP / "indexd", ORIG_SHA),
            "indexd-fence": (BUILD / "out" / "fence-enclave-a" / "indexd", FENCE_SHA),
            "indexd-c2": (BUILD / "out" / "c2-enclave-a" / "indexd", C2_SHA)}
CONTROLLER = (FIX / "controller" / "replicactl.py", "91dc928de335473997fefbc4aa9031d009072492147f5314b79e43ab95ac53d6")
MIGRATIONS = {"digest.sql": (FIX / "migration" / "digest.sql", "7f4b137f7049753df1cc414e89e0fa2da563b84c290cf533d8d2f11765104247"),
              "down-28-to-27.sql": (FIX / "migration" / "down-28-to-27.sql", "629f186e28a7f48a36e9bd9ac94139e6a3d24c40784fc26c6190075d212cc873"),
              "down-27-to-26.sql": (ROLLOUT / "migration" / "down-27-to-26.sql", "2127a7e2fb9f4ccb7d3e9944a913a51fd9eaf8275119a5d683843930e227485c")}
DIGEST_PRODUCTION = (HERE / "digest-production.sql", "3584b965bf2aed8ba88c1aeac4f0f577263a01f64cc79b9797472b1bd59109b7")
RECEIPTS = {"retirement-extraction-receipt.json": None, "live-dump-receipt.json": None}   # hashed into the manifest by pins()
TOOL_PINS = PKG / "tools" / "pins.json"        # rehearsaltool-v27, c2tool, c2rclient: root's reproducible offline build
TOOLS = ("rehearsaltool-v27", "c2tool", "c2rclient")
MAX_SCOPE = 512 * 1024 * 1024                  # the queue job; docker: PostgreSQL 256m + one tool 256m -> 1024 MiB total
PG_MEM_MIB = TOOL_MEM_MIB = 256
RUNS = PKG / "runs"                            # journals, stages, results of every run (never the package dirs)
# bound to THIS run's exclusive stage by bind_stage(); every helper and phase function below uses them unchanged
W = SEC = STATE = SOCK = MIG = PG = RUNOBJ = None
UID, GID = os.environ.get("RH_UID"), os.environ.get("RH_GID")
SOAK = int(os.environ.get("RH_SOAK_SECONDS", "60"))
results = {"run": None, "phases": [], "measurements": {}, "commands": [], "boundaries": {}}


def bind_stage(run):
    global W, SEC, STATE, SOCK, MIG, PG, RUNOBJ
    W = run.stage
    SEC, STATE, SOCK, MIG = W / "secrets", W / "state", W / "sock", W / "migration"
    PG, RUNOBJ = run.container, run
    results["run"] = run.id


def sh(cmd, inp=None, check=True, timeout=900):
    results["commands"].append(" ".join(c if len(c) < 140 else c[:137] + "..." for c in cmd))
    r = subprocess.run(cmd, input=inp, capture_output=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''} rc={r.returncode}: {r.stderr.decode(errors='replace')[-300:]}")
    return r


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def psql(db, sql, single_tx=False, variables=None):
    st = "--single-transaction " if single_tx else ""
    v = "".join(f"-v {k}={int(val)} " for k, val in (variables or {}).items())  # integers only
    r = sh(["docker", "exec", "-i", PG, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 ' + st + v + '-f -', "psql", db], sql.encode())
    return r.stdout.decode().strip()


def restore(db, dump):
    psql("postgres", f'DROP DATABASE IF EXISTS "{db}"; CREATE DATABASE "{db}";')
    with open(dump, "rb") as m:
        if m.read(5) != b"PGDMP":  # format magic only; contents are never read here
            raise RuntimeError("not a pg_dump custom-format archive")
    with open(dump, "rb", buffering=0) as f:  # streamed read-only from the private input (unbuffered: G5 run 1)
        r = subprocess.run(["docker", "exec", "-i", PG, "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -Fc --no-owner --no-acl --exit-on-error -d "$1"', "pg_restore", db],
                           stdin=f, capture_output=True, timeout=900)
    results["commands"].append(f"docker exec -i {PG} pg_restore -Fc --no-owner --no-acl --exit-on-error -d {db} < <private dump>")
    if r.returncode != 0:
        raise RuntimeError("pg_restore failed: " + r.stderr.decode(errors="replace")[-300:])


def parse_digest(out):
    return {l.split("|")[0]: {"rows": int(l.split("|")[1]), "md5": l.split("|")[2]} for l in out.splitlines() if not l.startswith("db_version")}


def digest(db):
    """The package's acknowledged-metadata digest (every row)."""
    return parse_digest(psql(db, (MIG / "digest.sql").read_text()))


def pdigest(db, fx):
    """The PRODUCTION-SCOPED digest: the package digest without the fixture account's rows (fx = its id, -1 none)."""
    return parse_digest(psql(db, (W / "digest-production.sql").read_text(), variables={"fx": fx}))


def fp(d):
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16]


def db_version(db):
    return int(psql(db, "SELECT db_version FROM global_settings;"))


def base_columns(db):
    out = psql(db, "SELECT table_name, string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns "
                   "WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name;")
    return {l.split("|")[0]: l.split("|")[1] for l in out.splitlines()}


def table_digests(db, cols):
    """Whole-row digest of every baseline table over the BASELINE columns: names changed tables, prints no rows."""
    q = "\n".join(f"SELECT '{t}|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\\n' ORDER BY r)), '') FROM (SELECT ROW({c})::text r FROM public.{t}) x;"
                  for t, c in sorted(cols.items()))
    return {l.split("|")[0]: {"rows": int(l.split("|")[1]), "md5": l.split("|")[2]} for l in psql(db, q).splitlines()}


def changed(a, b):
    return sorted(t for t in set(a) | set(b) if a.get(t) != b.get(t))


def schema(db):
    r = sh(["docker", "exec", PG, "sh", "-c", 'pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-acl "$1"', "pg_dump", db])
    text = "\n".join(l for l in r.stdout.decode().splitlines() if not l.startswith("--") and "\\restrict" not in l and "\\unrestrict" not in l)
    return hashlib.sha256(text.encode()).hexdigest()


def schema_facts(db):
    """Fence (v27) and C2 (v28) schema objects present, and invalid constraints/indexes: counts only."""
    keys = ("fenceAccountColumns", "seqColumn", "fenceConstraints", "seqIndex", "c2Columns", "c2Constraints", "invalidConstraints", "invalidIndexes")
    vals = psql(db, """SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('fence','fence_receipt','event_seq','seq_enabled','fence_pending')),
      (SELECT count(*) FROM information_schema.columns WHERE table_name='object_events' AND column_name='seq'),
      (SELECT count(*) FROM pg_constraint WHERE conname IN ('accounts_fence_receipt_pair','accounts_seq_enabled_needs_fence')),
      (SELECT count(*) FROM pg_indexes WHERE indexname='object_events_account_id_seq_idx'),
      (SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('last_op','last_op_digest','cas_mode')),
      (SELECT count(*) FROM pg_constraint WHERE conname IN ('accounts_last_op_pair','accounts_cas_needs_fence')),
      (SELECT count(*) FROM pg_constraint WHERE NOT convalidated),
      (SELECT count(*) FROM pg_index WHERE NOT indisvalid);""").split("|")
    return dict(zip(keys, map(int, vals)))


def production_accounts(db, fx):
    """Production accounts (every account except the fixture): how many are fenced / enrolled / hold an op record."""
    v = db_version(db)
    if v < 27:
        return {"dbVersion": v, "accounts": int(psql(db, f"SELECT count(*) FROM accounts WHERE id <> {int(fx)};"))}
    q = f"SELECT count(*), count(*) FILTER (WHERE fence IS NOT NULL), count(*) FILTER (WHERE seq_enabled)"
    q += ", count(*) FILTER (WHERE cas_mode), count(*) FILTER (WHERE last_op IS NOT NULL)" if v >= 28 else ""
    vals = list(map(int, psql(db, q + f" FROM accounts WHERE id <> {int(fx)};").split("|")))
    keys = ["accounts", "fenced", "seqEnabled", "enrolledCas", "withLastOp"][:len(vals)]
    return {"dbVersion": v, **dict(zip(keys, vals))}


def prod_cols(db, fx):
    """Column-level fingerprint of the PRODUCTION rows (fixture rows filtered out) of the tables background loops may
    rewrite: {table: {column: md5 over values in id order}} plus safety counts. Column NAMES and COUNTS only."""
    fx = int(fx)
    flt = {"accounts": f"id <> {fx}", "hosts": "TRUE", "contracts": "TRUE",
           "slabs": f"id NOT IN (SELECT slab_id FROM account_slabs WHERE account_id = {fx})",
           "sectors": f"id NOT IN (SELECT ss.sector_id FROM slab_sectors ss JOIN account_slabs x ON x.slab_id = ss.slab_id WHERE x.account_id = {fx})",
           "pools": f"connect_key_id NOT IN (SELECT connect_key_id FROM accounts WHERE id = {fx} AND connect_key_id IS NOT NULL)"}
    out = {}
    for t, f in flt.items():
        cols = S["cols"][t].split(",")
        q = " UNION ALL ".join(f"SELECT '{c}' || '|' || coalesce(md5(string_agg(coalesce({c}::text,'NULL'), ',' ORDER BY id)), '') FROM public.{t} WHERE {f}" for c in cols)
        d = dict(l.split("|", 1) for l in psql(db, q + ";").splitlines())
        d["#rows"] = psql(db, f"SELECT count(*) FROM public.{t} WHERE {f};")
        out[t] = d
    out["sectors"]["#lostSectors"] = psql(db, f"SELECT count(*) FROM sectors WHERE host_id IS NULL AND {flt['sectors']};")
    out["sectors"]["#sectorsWithFailedChecks"] = psql(db, f"SELECT count(*) FROM sectors WHERE consecutive_failed_checks > 0 AND {flt['sectors']};")
    out["hosts"]["#hostsWithFailedScans"] = psql(db, "SELECT count(*) FROM hosts WHERE consecutive_failed_scans > 0;")
    return out


def col_changes(before, after):
    res = {}
    for t in after:
        ch = sorted(k for k in after[t] if not k.startswith("#") and before[t].get(k) != after[t].get(k))
        facts = {k: f"{before[t].get(k)} -> {after[t].get(k)}" for k in after[t] if k.startswith("#")}
        res[t] = {"changedColumns": ch, **facts}
    return res


def gs_columns(db):
    out = psql(db, "SELECT key || '|' || md5(coalesce(value::text, 'NULL')) FROM jsonb_each((SELECT to_jsonb(g) FROM global_settings g)) ORDER BY key;")
    return dict(l.split("|") for l in out.splitlines())


# ---- the controller (runner "process", inside this namespace): a hash-verified copy in the stage ----
def ctl(*a, ok=True):
    r = sh([sys.executable, str(W / "bin" / "replicactl.py"), "--profile", str(W / "profile.json"), *a], check=False, timeout=900)
    try:
        out = json.loads(r.stdout.decode().strip().splitlines()[-1])
    except Exception:
        out = {"raw": r.stdout.decode()[-300:], "stderr": r.stderr.decode()[-300:]}
    out["_rc"] = r.returncode
    if ok and r.returncode != 0:
        raise RuntimeError(f"replicactl {a[0]} rc={r.returncode}: {out}")
    return out


def client(*a, ok=True):
    r = subprocess.run([str(W / "bin" / "c2rclient"), "-app", "http://127.0.0.1:9982", "-admin", "http://127.0.0.1:9980/api",
                        "-admin-pw", str(SEC / "admin-password"), "-state", str(SEC / "client-state.json"), *a], capture_output=True, text=True, timeout=180)
    results["commands"].append("c2rclient " + " ".join(x if not x.startswith("/") else Path(x).name for x in a))
    if r.returncode != 0:
        if ok:
            raise RuntimeError(f"client {a[0]}: {r.stderr.strip()[-300:]}")
        return {"_rc": r.returncode, "error": r.stderr.strip()[-200:]}
    return json.loads(r.stdout)


def tool(binary, step, db):
    """one store-level tool step in its OWN labelled, journaled container (rhfx.RehearsalRun.run_tool), sharing only
    PostgreSQL's empty network namespace; confirmed gone before this returns"""
    pg = dict(l.split("=", 1) for l in (SEC / "postgres.env").read_text().split() if "=" in l)
    envf = SEC / "tool.env"
    fd = os.open(envf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"RH_PG_USER={pg['POSTGRES_USER']}\nRH_PG_PASSWORD={pg['POSTGRES_PASSWORD']}\nRH_DB={db}\n")
    try:
        rc, out, err = RUNOBJ.run_tool(W / "bin" / binary, step, envf, UID, GID, TOOL_MEM_MIB)
    finally:
        envf.unlink()
    results["commands"].append(f"docker run --rm --network container:<pg> --memory {TOOL_MEM_MIB}m ... {binary} {step}")
    out = out.strip()
    if rc != 0:
        raise RuntimeError(f"{binary} {step} rc={rc}: {out[-300:]} {err[-200:]}")
    return json.loads(out)


def wait_ready(version):
    rd = None
    for _ in range(240):
        rd = ctl("readiness", "--expect-version", str(version), ok=False)
        if rd.get("ok"):
            return rd
        if not ctl("status", ok=False).get("running"):
            raise RuntimeError(f"indexd exited: {tail_log()}")
        time.sleep(1)
    raise RuntimeError(f"not ready at v{version}: {rd} {tail_log()}")


def tail_log():
    p = STATE / "indexd.out"
    if not p.exists():
        return ""
    lines = p.read_text(errors="replace").splitlines()
    return " | ".join(l[:200] for l in lines[-4:])  # indexd's own log lines (indexd logs no secrets)


def soak(tag):
    t0 = time.time()
    while time.time() - t0 < SOAK:
        if not ctl("status", ok=False).get("running"):
            raise RuntimeError(f"indexd exited during soak {tag}: {tail_log()}")
        time.sleep(5)
    return round(time.time() - t0, 1)


def log_mark():
    p = STATE / "indexd.out"
    return p.stat().st_size if p.exists() else 0


def log_summary(tag, since):
    """warn/error message KINDS and counts written since `since` (indexd's own JSON log; never values)."""
    p = STATE / "indexd.out"
    text = p.read_bytes()[since:].decode(errors="replace") if p.exists() else ""
    msgs = {}
    for l in text.splitlines():
        if '"level":"warn"' in l or '"level":"error"' in l:
            try:
                j = json.loads(l)
                k = f'{j.get("level")}:{j.get("logger")}:{j.get("msg")}'
                msgs[k] = msgs.get(k, 0) + 1
            except Exception:
                pass
    results["measurements"][tag] = {"warnErrorKinds": msgs, "migrationLines": text.count("migration complete")}


def indexd_hwm(tag):
    """the running indexd's own RSS high-water (VmHWM), read before it is stopped or replaced"""
    try:
        pid = int((STATE / "indexd.pid").read_text().split()[0])   # the controller's identity pid file: "<pid> <start> <boot>"
        for l in Path(f"/proc/{pid}/status").read_text().splitlines():
            if l.startswith("VmHWM:"):
                results["measurements"].setdefault("indexdVmHWMMiB", {})[tag] = int(l.split()[1]) // 1024
    except Exception:
        pass


def mem_peak(tag):
    """the job cgroup's memory high-water so far (includes this script; containers are capped separately)"""
    try:
        cg = Path("/proc/self/cgroup").read_text().split("::")[-1].strip()
        results["measurements"].setdefault("jobCgroupPeakMiB", {})[tag] = int(Path(f"/sys/fs/cgroup{cg}/memory.peak").read_text()) // (1 << 20)
    except Exception:
        pass


def phase(name, fn):
    t0 = time.time()
    try:
        d = fn()
        results["phases"].append({"phase": name, "ok": True, "seconds": round(time.time() - t0, 1), "detail": d})
        print(f"PASS {name}: {json.dumps(d)[:500]}", flush=True)
    except Exception as e:
        results["phases"].append({"phase": name, "ok": False, "seconds": round(time.time() - t0, 1), "error": str(e)[:900]})
        print(f"FAIL {name}: {str(e)[:900]}", flush=True)
        raise
    finally:
        mem_peak(name)


# ---- setup ----
def isolated():
    """this process is in a private network namespace with loopback only and no name resolution"""
    names = sorted(l.split(":")[0].strip() for l in Path("/proc/net/dev").read_text().split("\n")[2:] if ":" in l)
    dns = subprocess.run(["getent", "hosts", "example.com"], capture_output=True).returncode == 0
    return names == ["lo"] and not dns, names, dns


def copy_pinned(src, dst, h, mode=0o600):
    """exclusive copy into the stage, then verified against its pin"""
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as out, open(src, "rb") as f:
        shutil.copyfileobj(f, out, 1 << 20)
    if sha(dst) != h:
        raise RuntimeError(f"{Path(dst).name}: copy differs from its pin")


def write_secret(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def setup():
    assert subprocess.run(["getent", "hosts", "example.com"], capture_output=True).returncode != 0, "name resolution works: not isolated"
    ifs = Path("/proc/net/dev").read_text().split("\n")[2:]
    names = sorted(l.split(":")[0].strip() for l in ifs if ":" in l)
    assert names == ["lo"], f"network interfaces {names}: not isolated"
    # inputs: verified against root's receipts (hashes only)
    rr = json.loads((INP / "retirement-extraction-receipt.json").read_text())
    lr = json.loads((INP / "live-dump-receipt.json").read_text())
    want = {SNAP / n: h for n, h in rr["persistedOnly"].items()}
    want[LIVE] = lr["sha256"]
    for p, h in want.items():
        assert sha(p) == h, f"input {p.name} hash differs from root's receipt"
    assert want[SNAP / "indexd"] == ORIG_SHA
    for d in (SEC, STATE, MIG, W / "backups", W / "releases", W / "bin"):
        d.mkdir(mode=0o700)                       # inside this run's exclusive stage: never pre-existing
    SOCK.mkdir(mode=0o700)
    os.chmod(SOCK, 0o777)  # the PostgreSQL container's postgres user writes its socket here (the stage itself is 0700)
    # exact binaries, tools, controller and package files (exclusive, hash-verified copies in the stage)
    tp = tool_pins()
    bins = {**BINARIES, **{n: (PKG / tp[n]["path"], tp[n]["sha256"]) for n in TOOLS}}
    for name, (src, h) in bins.items():
        copy_pinned(src, W / "bin" / name, h, 0o700)
    copy_pinned(CONTROLLER[0], W / "bin" / "replicactl.py", CONTROLLER[1])
    for name, (src, h) in MIGRATIONS.items():
        copy_pinned(src, MIG / name, h)
    copy_pinned(DIGEST_PRODUCTION[0], W / "digest-production.sql", DIGEST_PRODUCTION[1])
    results["boundaries"]["frozen"] = {"inputs": {p.name: h for p, h in want.items()}, "binaries": {n: h for n, (_, h) in bins.items()},
                                       "migration": {n: sha(MIG / n) for n in MIGRATIONS}, "controller": CONTROLLER[1],
                                       "digestProduction": DIGEST_PRODUCTION[1], "c2fx": rhfx.C2FX_SHA, "rhfx": sha(HERE / "rhfx.py"),
                                       "rehearse": sha(Path(__file__))}
    shutil.copyfile(SNAP / "consensus.db", STATE / "consensus.db")
    shutil.copyfile(SNAP / "GeoLite2-City.mmdb", STATE / "GeoLite2-City.mmdb")
    for f in STATE.iterdir():
        os.chmod(f, 0o600)
    pgpw, adminpw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    write_secret(SEC / "postgres.env", f"POSTGRES_USER=rehearsal\nPOSTGRES_PASSWORD={pgpw}\nPOSTGRES_DB=postgres\n")
    write_secret(SEC / "admin-password", adminpw)
    seed = subprocess.run([str(W / "bin" / "indexd-c2"), "seed"], capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL).stdout
    phrase = next(l.split(":", 1)[1].strip() for l in seed.splitlines() if l.startswith("Recovery Phrase:"))
    write_secret(SEC / "indexd.yml", f"""autoOpenWebUI: false
directory: {STATE}
recoveryPhrase: "{phrase}"
adminAPI:
  address: 127.0.0.1:9980
  password: "{adminpw}"
applicationAPI:
  address: 127.0.0.1:9982
  advertiseURL: http://127.0.0.1:9982
syncer:
  address: 127.0.0.1:9981
  bootstrap: false
  enableUPnP: false
  peers: []
consensus:
  network: mainnet
explorer:
  enabled: false
  url: ""
slabs:
  migrations: false
database:
  host: {SOCK}
  port: 5432
  user: rehearsal
  password: "{pgpw}"
  database: indexd
  sslmode: disable
log:
  stdout:
    enabled: true
    level: info
    format: json
  file:
    enabled: false
""")
    write_secret(W / "profile.json", json.dumps({
        "runner": "process", "pg_container": PG, "database": "indexd", "state_dir": str(STATE), "config_file": str(SEC / "indexd.yml"),
        "admin_url": "http://127.0.0.1:9980/api", "admin_password_file": str(SEC / "admin-password"), "app_url": "http://127.0.0.1:9982",
        "release_dir": str(W / "releases"), "backup_dir": str(W / "backups"), "migration_dir": str(MIG), "gomemlimit": "256MiB",
        "geoip_sha256": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933"}, indent=1))
    RUNOBJ.create_volume()
    RUNOBJ.create_pg(SEC / "postgres.env", SOCK, PG_MEM_MIB)
    for _ in range(90):
        if sh(["docker", "exec", PG, "pg_isready", "-q", "-h", "127.0.0.1"], check=False).returncode == 0 and (SOCK / ".s.PGSQL.5432").exists():
            break
        time.sleep(1)
    net = sh(["docker", "inspect", "-f", "{{.HostConfig.NetworkMode}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}", PG]).stdout.decode().strip()
    assert net.split()[0] == "none", f"PostgreSQL network mode {net}"
    dur = psql("postgres", "SHOW fsync; SHOW synchronous_commit;").split()
    for name in ("indexd-original", "indexd-fence", "indexd-c2"):
        ctl("install", str(W / "bin" / name), "--sha256", sha(W / "bin" / name), "--confirm", "install")
    return {"thisNamespace": {"interfaces": names, "dns": False}, "pgContainer": net, "pgSocketOnly": True, "inputsMatchRootReceipts": True,
            "pgDurability": {"fsync": dur[0], "synchronous_commit": dur[1]}, "releasesInstalledByController": 3,
            "fixtureSeedReplacesProductionWallet": True, "freshQuiescedCutoverBackup": False}


# ---- coupled snapshot: REAL runtime under the REAL controller ----
S = {}


def s0_baseline():
    restore("indexd", SNAP / "indexd.pgdump")
    S["cols"] = base_columns("indexd")
    S["d0"] = digest("indexd")
    S["p0"] = pdigest("indexd", -1)
    S["t0"] = table_digests("indexd", S["cols"])
    S["schema0"] = schema("indexd")
    counts = {t: S["d0"][t]["rows"] for t in ("objects", "slabs", "contracts", "accounts")}
    receipt = json.loads((INP / "retirement-extraction-receipt.json").read_text())["snapshotCounts"]
    assert db_version("indexd") == 26
    assert counts == receipt, f"counts {counts} != receipt {receipt}"
    assert S["p0"] == S["d0"], "the production-scoped digest (fx=-1) must equal the package digest"
    return {"dbVersion": 26, "countsMatchReceipt": True, "counts": counts, "tables": len(S["t0"]), "schemaSha256": S["schema0"],
            "digestFingerprint": fp(S["d0"]), "scopedDigestEqualsPackageDigest": True, "schemaFacts": schema_facts("indexd"),
            "productionAccounts": production_accounts("indexd", -1)}


def s0b_seed():
    psql("indexd", "UPDATE global_settings SET wallet_hash = NULL;")
    t = table_digests("indexd", S["cols"])
    ch = changed(S["t0"], t)
    assert ch == ["global_settings"], ch
    assert digest("indexd") == S["d0"]
    S["tR"] = t
    S["cR"] = prod_cols("indexd", -1)
    return {"changedTables": ch, "acknowledgedMetadataUnchanged": True}


def s1_original():
    rel = W / "releases"
    (rel / "current").unlink(missing_ok=True)
    (rel / "current").symlink_to(ORIG_SHA)
    m = log_mark()
    ctl("start")
    rd = wait_ready(26)
    fence = ctl("readiness", ok=False).get("fenceRoute")
    assert fence == 404, f"the deployed v0.6.0 must not serve /fence ({fence})"
    rd["soakSeconds"] = soak("S1")
    indexd_hwm("S1-original-v26")
    ctl("stop")
    log_summary("S1-original-v26", m)
    assert digest("indexd") == S["d0"]
    S["gs1"] = gs_columns("indexd")
    S["c1"] = prod_cols("indexd", -1)
    results["boundaries"]["derivedState-S1-original-runtime-vs-baseline"] = col_changes(S["cR"], S["c1"])
    return {"readiness": {k: rd.get(k) for k in ("version", "network", "dbVersion", "fenceRoute", "ok")}, "fenceRoute": fence,
            "soakSeconds": rd["soakSeconds"], "acknowledgedMetadataUnchanged": True}


def s2_backup():
    b = ctl("backup")
    v = ctl("verify-backup", b["backup"])
    assert v["ok"] and v["restoredDbVersion"] == 26
    return {"verify": {k: v[k] for k in ("ok", "restoredDbVersion", "digestMatches")}}


def s3_upgrade27():
    m = log_mark()
    u = ctl("upgrade", "--sha256", FENCE_SHA, "--confirm", "upgrade")
    assert u["ok"] and u["dbVersion"] == 27 and u["digestPreserved"] and u["fenceRouteStatusUnauthenticated"] == 401, u
    soaked = soak("S3")
    log_summary("S3-fence-v27", m)
    sf = schema_facts("indexd")
    pa = production_accounts("indexd", -1)
    assert sf["fenceAccountColumns"] == 5 and sf["c2Columns"] == 0 and sf["invalidConstraints"] == 0 and sf["invalidIndexes"] == 0, sf
    assert pa["fenced"] == 0 and pa["seqEnabled"] == 0, pa
    assert digest("indexd") == S["d0"]
    return {"controllerUpgrade": {k: u[k] for k in ("ok", "dbVersion", "digestPreserved", "fenceRouteStatusUnauthenticated")},
            "previousRelease": u["previousRelease"], "soakSeconds": soaked, "schemaFacts": sf, "productionAccounts": pa}


def s4_upgrade28():
    indexd_hwm("S3-fence-v27")
    m = log_mark()
    u = ctl("upgrade-c2", "--sha256", C2_SHA, "--confirm", "upgrade-c2")
    assert u["ok"] and u["dbVersion"] == 28 and u["digestPreserved"] and u["fenceRouteStatusUnauthenticated"] == 401, u
    soaked = soak("S4")
    log_summary("S4-c2-v28", m)
    sf = schema_facts("indexd")
    pa = production_accounts("indexd", -1)
    assert sf["c2Columns"] == 3 and sf["c2Constraints"] == 2 and sf["invalidConstraints"] == 0 and sf["invalidIndexes"] == 0, sf
    assert pa["enrolledCas"] == 0 and pa["withLastOp"] == 0 and pa["fenced"] == 0, "the migration must not enrol or fence production accounts"
    assert digest("indexd") == S["d0"]
    S["t4"] = table_digests("indexd", S["cols"])
    S["c4"] = prod_cols("indexd", -1)
    results["boundaries"]["derivedState-S3S4-fence-and-c2-runtimes-vs-S1"] = col_changes(S["c1"], S["c4"])
    return {"controllerUpgradeC2": {k: u[k] for k in ("ok", "dbVersion", "digestPreserved", "fenceRouteStatusUnauthenticated")},
            "durabilityPreconditionChecked": True, "soakSeconds": soaked, "schemaFacts": sf, "productionAccountsNotEnrolledByMigration": pa}


def s5_fixture_ops():
    hosts = psql("indexd", "WITH g AS (SELECT scanned_height FROM global_settings) SELECT DISTINCT encode(h.public_key, 'hex') FROM contracts c "
                           "JOIN hosts h ON c.host_id = h.id CROSS JOIN g WHERE c.state IN (0,1) AND c.renewed_to IS NULL AND c.good AND c.proof_height > g.scanned_height;").split()
    (SEC / "goodhosts").write_text("\n".join(hosts) + "\n")
    os.chmod(SEC / "goodhosts", 0o600)
    r = {"goodProductionHostsAvailable": len(hosts)}
    r["register"] = client("register")
    S["fx"] = int(psql("indexd", "SELECT id FROM accounts WHERE app_id IS NOT NULL AND name = 'c2-rehearsal-fixture';"))
    r["pinSlab"] = client("pin-slab", str(SEC / "goodhosts"))
    r["stateBeforeEnrol"] = client("fence-state")
    r["raiseCas"] = client("raise-cas")
    r["casPin1"] = client("cas-pin")
    r["casPin2"] = client("cas-pin")
    r["identicalReplay"] = client("cas-replay")
    r["alteredReplay"] = client("cas-altered")
    r["staleHead"] = client("cas-stale")
    r["v3Refused"] = client("v3-refused")
    r["stockRefused"] = client("stock-refused")
    r["plainRaiseRefused"] = client("raise-plain-refused")
    r["shareV4"] = client("share-v4")
    r["shareV3Refused"] = client("share-v3-refused")
    r["state"] = client("fence-state")
    r["objects"] = client("objects")
    pa = production_accounts("indexd", S["fx"])
    caps = ["fence-v3", "cas-v4", "op-nonce"]
    assert r["register"]["registered"] and r["pinSlab"]["pinned"] == 1
    assert r["stateBeforeEnrol"]["capabilities"] == caps and r["stateBeforeEnrol"]["mode"] is None and r["stateBeforeEnrol"]["opNonce"]
    assert r["raiseCas"]["mode"] == "cas" and r["raiseCas"]["head"] == 0
    assert (r["casPin1"]["sq"], r["casPin1"]["seq"], r["casPin1"]["replayed"]) == (0, 1, False)
    assert (r["casPin2"]["sq"], r["casPin2"]["seq"], r["casPin2"]["replayed"]) == (1, 2, False)
    assert (r["identicalReplay"]["seq"], r["identicalReplay"]["replayed"]) == (2, True)
    assert r["alteredReplay"]["refused412op"] and r["staleHead"]["refused412seq"] and r["v3Refused"]["refused412mode"]
    assert r["stockRefused"]["refused409"] and r["plainRaiseRefused"]["refused412mode"]
    assert r["shareV4"]["added"] and r["shareV3Refused"]["refused412mode"]
    assert r["state"]["head"] == 2 and r["state"]["mode"] == "cas" and r["state"]["lastOpIsOurs"]
    assert r["objects"]["readable"] == r["objects"]["known"] == 2
    assert pa["enrolledCas"] == 0 and pa["fenced"] == 0, pa
    assert pdigest("indexd", S["fx"]) == S["d0"], "fixture operations changed production rows"
    r["productionAccountsUnchanged"] = pa
    r["productionScopedDigestUnchanged"] = True
    return r


def s6_block():
    r = {"block": client("block"), "blockedCheck": client("blocked-check"), "state": client("fence-state")}
    assert r["blockedCheck"]["adminEntryPresent"] and r["blockedCheck"]["read451"] and r["state"]["head"] == 2
    r["unblock"] = client("unblock")
    r["objectsAfterUnblock"] = client("objects")
    r["stateAfterUnblock"] = client("fence-state")
    assert r["objectsAfterUnblock"]["readable"] == 2 and r["stateAfterUnblock"]["head"] == 2 and r["stateAfterUnblock"]["lastOpIsOurs"]
    r["reblockForRollback"] = client("block")
    assert pdigest("indexd", S["fx"]) == S["d0"]
    return r


def s7_restart():
    indexd_hwm("S4-S6-c2-v28")
    m = log_mark()
    k = ctl("crash-indexd")
    ctl("start")
    rd = wait_ready(28)
    r = {"sigkill": k.get("ok"), "readiness": {x: rd.get(x) for x in ("version", "dbVersion", "ok")},
         "state": client("fence-state"), "replayAfterCrash": client("cas-replay"), "v3AfterCrash": client("v3-refused"),
         "blockedCheck": client("blocked-check")}
    log_summary("S7-restart-v28", m)
    assert r["state"]["mode"] == "cas" and r["state"]["head"] == 2 and r["state"]["lastOpIsOurs"]
    assert r["replayAfterCrash"]["replayed"] and r["replayAfterCrash"]["seq"] == 2 and r["v3AfterCrash"]["refused412mode"]
    assert r["blockedCheck"]["adminEntryPresent"] and r["blockedCheck"]["read451"]
    assert pdigest("indexd", S["fx"]) == S["d0"]
    S["dPre"] = digest("indexd")
    S["c7"] = prod_cols("indexd", S["fx"])
    results["boundaries"]["derivedState-S5S7-c2-runtime-with-fixture-vs-S4"] = col_changes(S["c4"], S["c7"])
    return r


def s8_rollback_refused():
    r = ctl("rollback-c2", "--fence-sha256", FENCE_SHA, "--confirm", "rollback-c2", "--cas-writers-stopped", ok=False)
    st = client("fence-state")
    assert r["_rc"] != 0 and r.get("refused") and r["dbVersion"] == 28, r
    assert st["mode"] == "cas" and st["head"] == 2, st
    assert digest("indexd") == S["dPre"] and pdigest("indexd", S["fx"]) == S["d0"]
    return {"refused": True, "dbVersion": r["dbVersion"], "reasonNamesEnrolment": "enrolled in cas mode" in r.get("reason", ""),
            "c2ReleaseServingAgain": r.get("release") == C2_SHA, "fixtureStillEnrolled": st, "nothingDropped": True}


def s9_rollback_ack():
    indexd_hwm("S7-S8-c2-v28-after-restart")
    m = log_mark()
    r = ctl("rollback-c2", "--fence-sha256", FENCE_SHA, "--confirm", "rollback-c2", "--cas-writers-stopped", "--acknowledge-cas-downgrade")
    assert r["ok"] and r["dbVersion"] == 27 and r["digestPreserved"] and r["acknowledgedCasDowngrade"], r
    soaked = soak("S9")
    log_summary("S9-fence-v27-after-c2-rollback", m)
    out = {"controllerRollbackC2": {k: r[k] for k in ("ok", "dbVersion", "digestPreserved", "acknowledgedCasDowngrade")}, "soakSeconds": soaked,
           "state": client("fence-state"), "blockedCheck": client("blocked-check"), "stockRefused": client("stock-refused"),
           "v3AcceptedAfterAcknowledgedDowngrade": client("fenced-pin"), "schemaFacts": schema_facts("indexd")}
    assert out["state"]["capabilities"] is None and out["state"]["mode"] is None and out["state"]["head"] == 2
    assert out["blockedCheck"]["adminEntryPresent"] and out["stockRefused"]["refused409"] and out["v3AcceptedAfterAcknowledgedDowngrade"]["pinned"]
    assert out["schemaFacts"]["c2Columns"] == 0 and out["schemaFacts"]["fenceAccountColumns"] == 5
    assert pdigest("indexd", S["fx"]) == S["d0"]
    return out


def s10_rollback26():
    indexd_hwm("S9-fence-v27-after-rollback")
    m = log_mark()
    r = ctl("rollback", "--stock-sha256", ORIG_SHA, "--confirm", "rollback", "--fenced-writers-stopped")
    assert r["ok"] and r["dbVersion"] == 26 and r["digestPreserved"] and r["fenceRouteStatusUnauthenticated"] == 404, r
    soaked = soak("S10")
    log_summary("S10-original-v26-after-rollback", m)
    out = {"controllerRollback": {k: r[k] for k in ("ok", "dbVersion", "digestPreserved", "fenceRouteStatusUnauthenticated")}, "soakSeconds": soaked,
           "blockedCheck": client("blocked-check"), "stockPinAccepted": client("unfenced-pin"), "objects": client("objects")}
    indexd_hwm("S10-original-v26-after-rollback")
    ctl("stop")
    sch = schema("indexd")
    assert sch == S["schema0"], "schema after the full rollback differs from the restored production schema"
    assert out["blockedCheck"]["adminEntryPresent"] and out["blockedCheck"]["read451"] and out["stockPinAccepted"]["pinned"]
    assert out["objects"]["readable"] + out["objects"]["blockedUnreadable"] == out["objects"]["known"]
    assert pdigest("indexd", S["fx"]) == S["d0"], "production rows changed across 26 -> 27 -> 28 -> 27 -> 26"
    t = table_digests("indexd", S["cols"])
    out["schemaEqualsRestoredProduction"] = True
    out["productionScopedDigestEqualsBaseline"] = True
    out["tablesChangedVsBaseline"] = changed(S["t0"], t)
    out["globalSettingsColumnsChangedVsFirstRun"] = sorted(k for k, v in gs_columns("indexd").items() if S["gs1"].get(k) != v)
    c10 = prod_cols("indexd", S["fx"])
    results["boundaries"]["derivedState-S9S10-rollback-runtimes-vs-S7"] = col_changes(S["c7"], c10)
    results["boundaries"]["derivedState-END-vs-baseline"] = col_changes(S["cR"], c10)
    out["productionRowColumnsChangedVsBaseline"] = {t: v["changedColumns"] for t, v in col_changes(S["cR"], c10).items() if v["changedColumns"]}
    out["fixtureRowsKept"] = {k: v["rows"] - S["d0"][k]["rows"] for k, v in digest("indexd").items() if v["rows"] != S["d0"][k]["rows"]}
    return out


# ---- captured live dump: database only ----
L = {}


def l0_baseline():
    restore("indexd_live", LIVE)
    L["cols"] = base_columns("indexd_live")
    L["d0"] = digest("indexd_live")
    L["schema0"] = schema("indexd_live")
    L["t0"] = table_digests("indexd_live", L["cols"])
    assert db_version("indexd_live") == 26
    counts = {t: L["d0"][t]["rows"] for t in ("objects", "slabs", "contracts", "accounts")}
    return {"dbVersion": 26, "counts": counts, "schemaSha256": L["schema0"], "schemaEqualsSnapshotSchema": L["schema0"] == S.get("schema0"),
            "digestFingerprint": fp(L["d0"])}


def l1_migrate27():
    r = tool("rehearsaltool-v27", "migrate", "indexd_live")
    assert r["dbVersionBefore"] == 26 and r["dbVersionAfter"] == 27, r
    assert digest("indexd_live") == L["d0"]
    return {**r, "acknowledgedMetadataUnchanged": True, "schemaFacts": schema_facts("indexd_live"), "productionAccounts": production_accounts("indexd_live", -1)}


def l2_migrate28():
    r = tool("c2tool", "migrate", "indexd_live")
    assert r["dbVersionBefore"] == 27 and r["dbVersionAfter"] == 28, r
    sf, pa = schema_facts("indexd_live"), production_accounts("indexd_live", -1)
    assert sf["c2Columns"] == 3 and sf["c2Constraints"] == 2 and sf["invalidConstraints"] == 0 and sf["invalidIndexes"] == 0, sf
    assert pa["enrolledCas"] == 0 and pa["fenced"] == 0 and pa["withLastOp"] == 0, pa
    assert digest("indexd_live") == L["d0"]
    return {**r, "acknowledgedMetadataUnchanged": True, "schemaFacts": sf, "productionAccountsNotEnrolledByMigration": pa,
            "tablesChanged": changed(L["t0"], table_digests("indexd_live", L["cols"]))}


def l3_exercise():
    r = tool("c2tool", "c2-exercise", "indexd_live")
    assert r["ok"], r
    assert digest("indexd_live") == L["d0"], "the C2 exercise changed acknowledged metadata"
    return {**r, "acknowledgedMetadataUnchanged": True, "productionAccountsAfter": production_accounts("indexd_live", -1)}


def l4_down_refused():
    try:
        psql("indexd_live", (MIG / "down-28-to-27.sql").read_text(), single_tx=True)
        refused = False
    except RuntimeError as e:
        refused = "refusing" in str(e)
    pa = production_accounts("indexd_live", -1)
    assert refused and db_version("indexd_live") == 28 and pa["enrolledCas"] >= 1, (refused, pa)
    return {"downWithoutAcknowledgementRefused": True, "dbVersion": 28, "enrolledProductionAccountsKept": pa["enrolledCas"]}


def l5_down_ack():
    psql("indexd_live", "SET LOCAL indexd.allow_cas_downgrade = 'on';\n" + (MIG / "down-28-to-27.sql").read_text(), single_tx=True)
    sf = schema_facts("indexd_live")
    assert db_version("indexd_live") == 27 and sf["c2Columns"] == 0 and sf["fenceAccountColumns"] == 5
    assert digest("indexd_live") == L["d0"]
    return {"dbVersion": 27, "acknowledgedMetadataUnchanged": True, "schemaFacts": sf, "productionAccounts": production_accounts("indexd_live", -1)}


def l6_down26():
    psql("indexd_live", (MIG / "down-27-to-26.sql").read_text(), single_tx=True)
    assert db_version("indexd_live") == 26
    assert digest("indexd_live") == L["d0"] and schema("indexd_live") == L["schema0"], "live rollback changed data or schema"
    return {"dbVersion": 26, "acknowledgedMetadataUnchanged": True, "schemaEqualsRestoredLive": True,
            "tablesChangedVsBaseline": changed(L["t0"], table_digests("indexd_live", L["cols"]))}


# ---- pins, plan, run ----
def tool_pins():
    p = json.loads(TOOL_PINS.read_text())
    return {n: p[n] for n in TOOLS}


def pins():
    """-> (pins, problems). Hashes only: the private captures are hashed at setup, against root's receipts."""
    got, bad = {}, []
    for n, (p, h) in {**BINARIES, "replicactl.py": CONTROLLER, "digest-production.sql": DIGEST_PRODUCTION, **MIGRATIONS}.items():
        got[n] = sha(p)
        if got[n] != h:
            bad.append(n)
    for n, t in tool_pins().items():
        if not isinstance(t.get("sha256"), str) or len(t["sha256"]) != 64:
            bad.append(f"{n}: tool pin {t.get('sha256')!r} (root's reproducible tool build has not been pinned)")
            continue
        got[n] = sha(PKG / t["path"]) if (PKG / t["path"]).is_file() else "missing"
        if got[n] != t["sha256"]:
            bad.append(n)
    for n in RECEIPTS:
        got[n] = sha(INP / n)                         # receipt files (paths, hashes, counts): metadata only
    got["c2fx.py"], got["rhfx.py"], got["rehearse-c2.py"] = rhfx.C2FX_SHA, sha(HERE / "rhfx.py"), sha(Path(__file__))
    return got, bad


def manifest(got):
    return hashlib.sha256(json.dumps(got, sort_keys=True).encode()).hexdigest()


PHASES = [("0-setup-isolated", "setup"), ("S0-snapshot-restore-baseline-v26", "s0_baseline"), ("S0b-fixture-seed-replacement", "s0b_seed"),
          ("S1-original-binary-runtime-v26", "s1_original"), ("S2-controller-backup-verify-v26", "s2_backup"),
          ("S3-controller-upgrade-26-27-fence-release", "s3_upgrade27"), ("S4-controller-upgrade-c2-27-28", "s4_upgrade28"),
          ("S5-fixture-app-operations-real-api-v28", "s5_fixture_ops"), ("S6-admin-block-unblock-v28", "s6_block"),
          ("S7-indexd-sigkill-restart-persistence-v28", "s7_restart"), ("S8-rollback-c2-refused-while-enrolled", "s8_rollback_refused"),
          ("S9-rollback-c2-acknowledged-28-27", "s9_rollback_ack"), ("S10-controller-rollback-27-26-original-binary", "s10_rollback26"),
          ("L0-live-restore-baseline-v26", "l0_baseline"), ("L1-live-migrate-26-27-release-source", "l1_migrate27"),
          ("L2-live-migrate-27-28-c2-source", "l2_migrate28"), ("L3-live-c2-exercise-real-account", "l3_exercise"),
          ("L4-live-down-28-27-refused-while-enrolled", "l4_down_refused"), ("L5-live-down-28-27-acknowledged", "l5_down_ack"),
          ("L6-live-down-27-26", "l6_down26")]


def main(argv):
    got, bad = pins()
    m = manifest(got)
    if argv in ([], ["--plan"]):
        print(json.dumps({"mode": "plan (no side effects)", "manifest": m, "pins": got, "problems": bad, "execute": f"--execute {m}"}, indent=1))
        return 0 if not bad else 2
    docker = c2fx.Docker(os.environ.get("RH_DOCKER", "docker"))
    if argv[:1] == ["--recover"] and len(argv) == 2:
        rep = rhfx.recover(RUNS, argv[1], docker)
        print(json.dumps(rep, indent=1))
        return 0 if rep["certain"] else 3
    if argv != ["--execute", m]:
        print(json.dumps({"ok": False, "error": "usage: --plan | --execute <manifest> | --recover <run id>", "manifest": m}))
        return 2
    if bad:
        print(json.dumps({"ok": False, "error": "pins differ or are pending", "problems": bad}))
        return 2
    ok, names, dns = isolated()
    if not ok or not (UID and GID and UID.isdigit() and GID.isdigit()):
        print(json.dumps({"ok": False, "error": "refusing: not in a private loopback-only network namespace (rehearse/run.sh) or RH_UID/RH_GID unset",
                          "interfaces": names, "dns": dns}))
        return 2
    try:
        scope = c2fx.queue_scope()
    except (c2fx.Refused, c2fx.Unknown, OSError) as e:
        print(json.dumps({"ok": False, "error": f"must run as ONE shared-queue job: {e}"}))
        return 2
    if scope["memoryMax"] is None or scope["memoryMax"] > MAX_SCOPE:
        print(json.dumps({"ok": False, "error": f"the queue job must be at most {MAX_SCOPE >> 20} MiB (memory.max {scope['memoryMax']})"}))
        return 2
    run = rhfx.RehearsalRun(RUNS, docker, scope=scope)
    try:
        run.begin()
    except (c2fx.Refused, c2fx.Unknown, OSError) as e:
        rep = run.cleanup() if run.journal else None
        print(json.dumps({"ok": False, "refused": f"{type(e).__name__}: {e}", "runId": run.id, "cleanup": rep}))
        return 2
    bind_stage(run)

    def on_signal(signum, _f):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    code, t0 = 0, time.time()
    try:
        for name, fn in PHASES:
            phase(name, globals()[fn])
    except SystemExit as e:
        code, results["interrupted"] = 1, f"signal exit {e.code}"
    except Exception:
        code = 1
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        rep = run.cleanup(pid_files=[STATE / "indexd.pid"])
        results["cleanup"] = rep
        results["seconds"] = round(time.time() - t0, 1)
        results["soakSecondsPerRuntime"] = SOAK
        results["passed"] = code == 0 and all(p["ok"] for p in results["phases"]) and len(results["phases"]) == 20 and rep["certain"]
        (RUNS / f"{run.id}.results.json").write_text(json.dumps(results, indent=1) + "\n")
        print(json.dumps({"runId": run.id, "passed": results["passed"], "phases": len(results["phases"]), "cleanupCertain": rep["certain"],
                          "seconds": results["seconds"]}))
    return 3 if not rep["certain"] else (0 if results["passed"] else 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
