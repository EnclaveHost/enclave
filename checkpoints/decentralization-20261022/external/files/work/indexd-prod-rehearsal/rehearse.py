#!/usr/bin/env python3
"""G5 rehearsal: primary schema/binary upgrade (26 -> 27) and rollback on REAL production metadata, isolated/offline.

Run ONLY as one shared-queue job:  python3 work/claude-test-queue.py --mib 1536 --log ... -- python3 rehearse.py
Admission: this job's cgroup holds python, docker CLIs and psql pipes (small); the containers run OUTSIDE it and are
each hard-capped (PostgreSQL 512m, indexd 512m, tool 256m; --memory-swap = --memory, so no swap). At most PG + one
other container run at once (<= 1024 MiB), inside the 1536 MiB headroom the queue reserved above the 16 GiB floor.

Isolation: PostgreSQL runs with --network none; indexd and the tool share ONLY its network namespace
(--network container:rh-pg), so they have loopback and nothing else: no DNS, egress, chain peers, explorer or hosts.
Inputs (work/indexd-production-rehearsal, 0600/0700) are only READ (streamed); every write goes to disposable copies
here or to the disposable volume, all removed in `finally` (results/ keeps counts, digests and booleans only).
Secrets: fixture only (generated here, 0600): PostgreSQL password, admin password, and a FRESH recovery phrase from
the release binary's `indexd seed` (the production wallet seed is not available and must not be used).
Never printed: table contents, customer metadata, keys, configs, dump contents.
"""
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

W = Path(__file__).resolve().parent
WORK = W.parent
INP = WORK / "indexd-production-rehearsal"
PKG = WORK / "indexd-replica-rollout"
IMG = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336"
PG, IDX, TOOL, VOL = "rh-pg", "rh-indexd", "rh-tool", "rh-pgdata"
ORIG_SHA = "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc"
CAND_SHA = "61413110dc4426e43b030b418bfeb314b0dc0ea9c09f82dc48523ec862335901"
SEC, STATE, RES, LOGS = W / "secrets", W / "state", W / "results", W / "logs"
results = {"phases": [], "measurements": {}, "commands": []}


def sh(cmd, inp=None, check=True, timeout=600):
    results["commands"].append(" ".join(c if len(c) < 120 else c[:117] + "..." for c in cmd))
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


def psql(db, sql, single_tx=False):
    st = "--single-transaction " if single_tx else ""
    r = sh(["docker", "exec", "-i", PG, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 ' + st + '-f -', "psql", db], sql.encode())
    return r.stdout.decode().strip()


def restore(db, dump):
    psql("postgres", f'DROP DATABASE IF EXISTS "{db}"; CREATE DATABASE "{db}";')
    with open(dump, "rb") as m:
        if m.read(5) != b"PGDMP":  # format magic only; contents are never read here
            raise RuntimeError("not a pg_dump custom-format archive")
    # a fresh UNBUFFERED handle: a buffered handle's seek(0) left the fd at 8192 (run 1 failed on exactly that)
    with open(dump, "rb", buffering=0) as f:  # streamed read-only from the private input
        r = subprocess.run(["docker", "exec", "-i", PG, "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -Fc --no-owner --no-acl --exit-on-error -d "$1"', "pg_restore", db],
                           stdin=f, capture_output=True, timeout=600)
    results["commands"].append(f"docker exec -i {PG} pg_restore -Fc --no-owner --no-acl --exit-on-error -d {db} < <private dump>")
    if r.returncode != 0:
        raise RuntimeError("pg_restore failed: " + r.stderr.decode(errors="replace")[-300:])


def data_digest(db):
    out = psql(db, (PKG / "migration" / "digest.sql").read_text())
    return {l.split("|")[0]: {"rows": int(l.split("|")[1]), "md5": l.split("|")[2]} for l in out.splitlines() if not l.startswith("db_version")}


def db_version(db):
    return int(psql(db, "SELECT db_version FROM global_settings;"))


def base_columns(db):
    """{table: [columns]} of the schema as restored (the stock v26 column set, used for every later whole-row digest)."""
    out = psql(db, "SELECT table_name, string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns "
                   "WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name;")
    return {l.split("|")[0]: l.split("|")[1] for l in out.splitlines()}


def table_digests(db, cols):
    """Whole-row digest of EVERY table over the baseline columns: identifies any changed table without printing rows."""
    q = "\n".join(f"SELECT '{t}|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\\n' ORDER BY r)), '') FROM (SELECT ROW({c})::text r FROM public.{t}) x;"
                  for t, c in sorted(cols.items()))
    return {l.split("|")[0]: {"rows": int(l.split("|")[1]), "md5": l.split("|")[2]} for l in psql(db, q).splitlines()}


SOAK = int(os.environ.get("RH_SOAK_SECONDS", "120"))


def gs_columns(db):
    """global_settings: {column: md5(value)} so CHANGED COLUMN NAMES can be reported (never the values)."""
    out = psql(db, "SELECT key || '|' || md5(coalesce(value::text, 'NULL')) FROM jsonb_each((SELECT to_jsonb(g) FROM global_settings g)) ORDER BY key;")
    return dict(l.split("|") for l in out.splitlines())


def soak(phase):
    """Keep the binary running SOAK seconds with no peers/hosts/explorer, so its background loops (chain subscriber,
    contract maintenance, host scans, integrity checks, pruning, publishing) actually run on the real metadata."""
    t0 = time.time()
    while time.time() - t0 < SOAK:
        if sh(["docker", "inspect", "-f", "{{.State.Running}}", IDX], check=False).stdout.decode().strip() != "true":
            raise RuntimeError(f"indexd exited during soak: {tail_log()}")
        time.sleep(5)
    return round(time.time() - t0, 1)


def col_snapshot(db, table):
    """{column: md5 over the column's values in primary-key order} plus derived facts that matter for safety:
    sectors with NULL host_id (lost) and hosts' consecutive failed scans. Column NAMES and COUNTS only."""
    cols = psql(db, f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position;").splitlines()
    q = " UNION ALL ".join(f"SELECT '{c}' || '|' || coalesce(md5(string_agg(coalesce({c}::text,'NULL'), ',' ORDER BY id)), '') FROM public.{table}" for c in cols)
    d = dict(l.split("|") for l in psql(db, q + ";").splitlines())
    if table == "sectors":
        d["#lostSectors"] = psql(db, "SELECT count(*) FROM sectors WHERE host_id IS NULL;")
        d["#sectorsWithFailedChecks"] = psql(db, "SELECT count(*) FROM sectors WHERE consecutive_failed_checks > 0;")
    if table == "hosts":
        d["#hostsWithFailedScans"] = psql(db, "SELECT count(*) FROM hosts WHERE consecutive_failed_scans > 0;")
    return d


def col_changes(before, after):
    out = {"changedColumns": sorted(k for k in after if not k.startswith("#") and before.get(k) != after.get(k))}
    out.update({k: f"{before.get(k)} -> {after.get(k)}" for k in after if k.startswith("#")})
    return out


def changed(a, b):
    return sorted(t for t in set(a) | set(b) if a.get(t) != b.get(t))


def row_deltas(a, b):
    return {t: b.get(t, {}).get("rows", 0) - a.get(t, {}).get("rows", 0) for t in changed(a, b) if a.get(t, {}).get("rows") != b.get(t, {}).get("rows")}


def schema(db):
    r = sh(["docker", "exec", PG, "sh", "-c", 'pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-acl "$1"', "pg_dump", db])
    text = "\n".join(l for l in r.stdout.decode().splitlines() if not l.startswith("--") and "\\restrict" not in l and "\\unrestrict" not in l)
    return hashlib.sha256(text.encode()).hexdigest(), text


def fence_schema(db):
    return psql(db, """SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('fence','fence_receipt','event_seq','seq_enabled','fence_pending')),
      (SELECT count(*) FROM information_schema.columns WHERE table_name='object_events' AND column_name='seq'),
      (SELECT count(*) FROM pg_constraint WHERE conname IN ('accounts_fence_receipt_pair','accounts_seq_enabled_needs_fence')),
      (SELECT count(*) FROM pg_indexes WHERE indexname='object_events_account_id_seq_idx'),
      (SELECT count(*) FROM pg_constraint WHERE NOT convalidated),
      (SELECT count(*) FROM pg_index WHERE NOT indisvalid);""").split("|")


# ---- isolated indexd runtime ----
def http(port, path, auth=True):
    """HTTP GET from INSIDE the namespace (bash /dev/tcp); the fixture admin auth header comes via stdin."""
    hdr = ("Authorization: Basic " + base64.b64encode((":" + (SEC / "admin-password").read_text()).encode()).decode()) if auth else "X-None: 1"
    script = ('read -r h; exec 3<>/dev/tcp/127.0.0.1/$1 || exit 7; printf "GET %s HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n%s\\r\\n\\r\\n" "$2" "$h" >&3; cat <&3')
    r = subprocess.run(["docker", "exec", "-i", PG, "bash", "-c", script, "http", str(port), path], input=(hdr + "\n").encode(), capture_output=True, timeout=30)
    if r.returncode != 0 or not r.stdout:
        return None, None
    head, _, body = r.stdout.decode(errors="replace").partition("\r\n\r\n")
    code = int(head.split()[1])
    try:
        return code, json.loads(body)
    except Exception:
        return code, None


def start_indexd(binary):
    sh(["docker", "run", "-d", "--name", IDX, "--network", f"container:{PG}", "--memory", "512m", "--memory-swap", "512m", "--read-only",
        "--tmpfs", "/tmp:rw,size=64m", "--user", f"{os.getuid()}:{os.getgid()}",
        "--mount", f"type=bind,source={STATE},target=/state", "--mount", f"type=bind,source={W / 'bin' / binary},target=/indexd,readonly",
        "--mount", f"type=bind,source={SEC / 'indexd.yml'},target=/cfg/indexd.yml,readonly",
        "-e", "INDEXD_CONFIG_FILE=/cfg/indexd.yml", "-e", "INDEXD_DATA_DIR=/state", "-e", "GOMEMLIMIT=384MiB",
        "--entrypoint", "/indexd", IMG])


def wait_ready(want_version, db="indexd", timeout=240):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = sh(["docker", "inspect", "-f", "{{.State.Running}}", IDX], check=False).stdout.decode().strip()
        if st != "true":
            raise RuntimeError("indexd exited: " + tail_log())
        code, body = http(9980, "/api/state")
        if code == 200 and isinstance(body, dict):
            try:
                if db_version(db) == want_version:
                    return {"adminState": code, "version": body.get("version"), "network": body.get("network"),
                            "scanHeight": body.get("scanHeight"), "syncHeight": body.get("syncHeight"), "readySeconds": round(time.time() - t0, 1)}
            except Exception:
                pass
        time.sleep(1)
    raise RuntimeError("not ready: " + tail_log())


def tail_log():
    r = subprocess.run(["docker", "logs", "--tail", "5", IDX], capture_output=True)
    lines = (r.stdout + r.stderr).decode(errors="replace").splitlines()
    return " | ".join(l[:200] for l in lines[-5:])  # indexd's own log lines (no secrets are logged by indexd)


def stop_indexd(phase):
    cid = sh(["docker", "inspect", "-f", "{{.Id}}", IDX], check=False).stdout.decode().strip()
    peak = None
    for p in (f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/memory.peak",):
        try:
            peak = int(open(p).read()) // (1 << 20)
        except OSError:
            pass
    stats = sh(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", IDX], check=False).stdout.decode().strip()
    sh(["docker", "stop", "-t", "120", IDX], check=False)
    log = (LOGS / f"{phase}-indexd.log")
    with open(log, "wb") as f:
        r = subprocess.run(["docker", "logs", IDX], capture_output=True)
        f.write(r.stdout + r.stderr)
    os.chmod(log, 0o600)
    text = log.read_text(errors="replace")
    sh(["docker", "rm", "-f", IDX], check=False)
    msgs = {}
    for l in text.splitlines():
        if '"level":"warn"' in l or '"level":"error"' in l:
            try:
                j = json.loads(l)
                k = f'{j.get("level")}:{j.get("logger")}:{j.get("msg")}'
                msgs[k] = msgs.get(k, 0) + 1
            except Exception:
                pass
    results["measurements"][phase] = {"indexdMemoryPeakMiB": peak, "indexdMemAtStop": stats, "warnErrorMessages": msgs,
                                      "logErrorLines": sum(1 for l in text.splitlines() if '"level":"error"' in l),
                                      "migrationLines": sum(1 for l in text.splitlines() if "migration complete" in l)}
    return text


def tool(step, db):
    env = []
    pg = dict(l.split("=", 1) for l in (SEC / "postgres.env").read_text().split() if "=" in l)
    envf = SEC / "tool.env"
    envf.write_text(f"RH_PG_USER={pg['POSTGRES_USER']}\nRH_PG_PASSWORD={pg['POSTGRES_PASSWORD']}\nRH_DB={db}\n")
    os.chmod(envf, 0o600)
    r = sh(["docker", "run", "--rm", "--name", TOOL, "--network", f"container:{PG}", "--memory", "256m", "--memory-swap", "256m", "--read-only",
            "--user", f"{os.getuid()}:{os.getgid()}", "--env-file", str(envf),
            "--mount", f"type=bind,source={W / 'bin' / 'rehearsaltool'},target=/tool,readonly", "--entrypoint", "/tool", IMG, step], check=False)
    envf.unlink()
    out = r.stdout.decode().strip()
    if r.returncode != 0:
        raise RuntimeError(f"rehearsaltool {step} rc={r.returncode}: {out[-300:]} {r.stderr.decode()[-200:]}")
    return json.loads(out)


def ctl(*a):
    r = sh([sys.executable, str(PKG / "controller" / "replicactl.py"), "--profile", str(W / "profile.json"), *a], check=False)
    out = json.loads(r.stdout.decode().strip().splitlines()[-1])
    if r.returncode != 0:
        raise RuntimeError(f"replicactl {a[0]}: {out}")
    return out


def phase(name, fn):
    t0 = time.time()
    try:
        d = fn()
        results["phases"].append({"phase": name, "ok": True, "seconds": round(time.time() - t0, 1), "detail": d})
        print(f"PASS {name}: {json.dumps(d)[:400]}", flush=True)
    except Exception as e:
        results["phases"].append({"phase": name, "ok": False, "seconds": round(time.time() - t0, 1), "error": str(e)[:700]})
        print(f"FAIL {name}: {str(e)[:700]}", flush=True)
        raise


# ---- setup ----
def setup():
    for d in (SEC, STATE, RES, LOGS, W / "backups"):
        d.mkdir(mode=0o700, exist_ok=True)
    for name, src, want in (("indexd-original", INP / "retirement-snapshot" / "indexd", ORIG_SHA),
                            ("indexd-candidate", PKG / "release" / "indexd-v0.6.0-fence.1-linux-amd64", CAND_SHA)):
        shutil.copyfile(src, W / "bin" / name)
        os.chmod(W / "bin" / name, 0o700)
        assert sha(W / "bin" / name) == want, name
    shutil.copyfile(INP / "retirement-snapshot" / "consensus.db", STATE / "consensus.db")
    shutil.copyfile(INP / "retirement-snapshot" / "GeoLite2-City.mmdb", STATE / "GeoLite2-City.mmdb")
    for f in STATE.iterdir():
        os.chmod(f, 0o600)
    pgpw, adminpw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    (SEC / "postgres.env").write_text(f"POSTGRES_USER=rehearsal\nPOSTGRES_PASSWORD={pgpw}\nPOSTGRES_DB=postgres\n")
    (SEC / "admin-password").write_text(adminpw)
    seed = subprocess.run([str(W / "bin" / "indexd-candidate"), "seed"], capture_output=True, text=True, check=True).stdout
    phrase = next(l.split(":", 1)[1].strip() for l in seed.splitlines() if l.startswith("Recovery Phrase:"))
    (SEC / "indexd.yml").write_text(f"""autoOpenWebUI: false
directory: /state
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
  host: 127.0.0.1
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
    for f in SEC.iterdir():
        os.chmod(f, 0o600)
    (W / "profile.json").write_text(json.dumps({
        "runner": "process", "pg_container": PG, "database": "indexd", "state_dir": str(STATE), "config_file": str(SEC / "indexd.yml"),
        "admin_url": "http://127.0.0.1:9980/api", "admin_password_file": str(SEC / "admin-password"), "app_url": "http://127.0.0.1:9982",
        "release_dir": str(W / "releases"), "backup_dir": str(W / "backups"), "migration_dir": str(PKG / "migration"),
        "geoip_sha256": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933"}, indent=1))
    sh(["docker", "volume", "create", VOL])
    sh(["docker", "run", "-d", "--name", PG, "--network", "none", "--memory", "512m", "--memory-swap", "512m", "--read-only",
        "--env-file", str(SEC / "postgres.env"), "--mount", f"type=volume,source={VOL},target=/var/lib/postgresql",
        "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m",
        IMG, "postgres", "-c", "listen_addresses=127.0.0.1", "-c", "shared_buffers=128MB", "-c", "max_connections=50"])
    for _ in range(60):
        if sh(["docker", "exec", PG, "pg_isready", "-q", "-h", "127.0.0.1"], check=False).returncode == 0:
            break
        time.sleep(1)
    net = sh(["docker", "inspect", "-f", "{{.HostConfig.NetworkMode}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}", PG]).stdout.decode().strip()
    return {"pgContainer": net, "inputsVerified": True, "fixtureSeedReplacesProductionWallet": True}


def cleanup():
    for c in (IDX, TOOL, PG):
        subprocess.run(["docker", "rm", "-f", c], capture_output=True)
    subprocess.run(["docker", "volume", "rm", "-f", VOL], capture_output=True)
    for d in (STATE, W / "backups", W / "releases", SEC):
        shutil.rmtree(d, ignore_errors=True)
    for b in ("indexd-original", "indexd-candidate"):
        (W / "bin" / b).unlink(missing_ok=True)
    left = [c for c in (IDX, TOOL, PG) if subprocess.run(["docker", "inspect", c], capture_output=True).returncode == 0]
    vol = subprocess.run(["docker", "volume", "inspect", VOL], capture_output=True).returncode == 0
    results["cleanup"] = {"containersLeft": left, "volumeLeft": vol, "stateRemoved": not STATE.exists(), "secretsRemoved": not SEC.exists(),
                          "backupsRemoved": not (W / "backups").exists()}


# ---- phases ----
S = {}


def snap_baseline():
    restore("indexd", INP / "retirement-snapshot" / "indexd.pgdump")
    S["cols"] = base_columns("indexd")
    S["v"] = db_version("indexd")
    S["data0"] = data_digest("indexd")
    S["tables0"] = table_digests("indexd", S["cols"])
    S["schema0"], S["schema0text"] = schema("indexd")
    S["fs0"] = fence_schema("indexd")
    counts = {t: S["data0"][t]["rows"] for t in ("objects", "slabs", "contracts", "accounts")}
    receipt = json.loads((INP / "retirement-extraction-receipt.json").read_text())["snapshotCounts"]
    assert S["v"] == 26, f"db_version {S['v']}"
    assert counts == receipt, f"counts {counts} != receipt {receipt}"
    return {"dbVersion": S["v"], "countsMatchReceipt": True, "baselineInvalidConstraintsIndexes": S["fs0"][4:], "baselineFenceColumns": S["fs0"][:4], "counts": counts, "tables": len(S["tables0"]),
            "schemaSha256": S["schema0"], "dataDigest": {k: v["md5"] for k, v in S["data0"].items()}}


def snap_seed_replacement():
    """indexd binds its database to the wallet seed (global_settings.wallet_hash = H(walletKey); run.go refuses any
    other seed: run 2 showed "wallet seed change detected"). The production seed is not available and must not be used,
    so the DISPOSABLE copy gets wallet_hash = NULL, and the fixture seed is adopted at the first start. Nothing else is
    touched; the whole-table digests show exactly which table changed."""
    before = S["tables0"]
    psql("indexd", "UPDATE global_settings SET wallet_hash = NULL;")
    after = table_digests("indexd", S["cols"])
    S["tablesR"] = after
    ch = changed(before, after)
    assert ch == ["global_settings"], ch
    assert data_digest("indexd") == S["data0"]
    return {"changedTables": ch, "acknowledgedMetadataUnchanged": True}


def snap_original_runtime():
    (W / "releases").mkdir(mode=0o700, exist_ok=True)
    gs0 = gs_columns("indexd")
    cs0 = {t: col_snapshot("indexd", t) for t in ("hosts", "sectors", "contracts", "slabs", "accounts")}
    start_indexd("indexd-original")
    rd = wait_ready(26)
    app = {"fenceRoute": http(9982, "/fence", auth=False)[0]}
    rd["soakSeconds"] = soak("S1")
    stop_indexd("S1-original")
    gs1 = gs_columns("indexd")
    S["gs1"] = gs1
    rd["globalSettingsColumnsChanged"] = sorted(k for k in gs1 if gs0.get(k) != gs1.get(k))
    cs1 = {t: col_snapshot("indexd", t) for t in cs0}
    rd["derivedColumnChanges"] = {t: col_changes(cs0[t], cs1[t]) for t in cs0}
    S["cs1"] = cs1
    data1 = data_digest("indexd")
    t1 = table_digests("indexd", S["cols"])
    S["tables1"] = t1
    assert data1 == S["data0"], "acknowledged metadata changed under the ORIGINAL binary"
    return {"readiness": rd, "app": app, "acknowledgedMetadataUnchanged": True,
            "derivedTablesChangedByRuntime": changed(S["tablesR"], t1), "rowDeltas": row_deltas(S["tablesR"], t1)}


def snap_backup():
    b = ctl("backup")
    v = ctl("verify-backup", b["backup"])
    S["backup26"] = b["backup"]
    assert v["ok"] and v["restoredDbVersion"] == 26
    return {"backup": "ok", "verify": {k: v[k] for k in ("ok", "restoredDbVersion", "digestMatches")}}


def snap_upgrade():
    start_indexd("indexd-candidate")
    rd = wait_ready(27)
    app = {"fenceRoute": http(9982, "/fence", auth=False)[0], "seqRoute": http(9982, "/seq/objects", auth=False)[0],
           "currentRoute": http(9982, "/current/objects", auth=False)[0]}
    rd["soakSeconds"] = soak("S3")
    log = stop_indexd("S3-candidate")
    gs3 = gs_columns("indexd")
    rd["globalSettingsColumnsChanged"] = sorted(k for k in gs3 if S["gs1"].get(k) != gs3.get(k))
    S["gs3"] = gs3
    cs3 = {t: col_snapshot("indexd", t) for t in S["cs1"]}
    rd["derivedColumnChanges"] = {t: col_changes(S["cs1"][t], cs3[t]) for t in cs3}
    S["cs3"] = cs3
    data = data_digest("indexd")
    fs = fence_schema("indexd")
    t = table_digests("indexd", S["cols"])
    assert db_version("indexd") == 27
    assert data == S["data0"], "acknowledged metadata changed by the upgrade"
    assert fs[:4] == ["5", "1", "2", "1"] and fs[4:] == S["fs0"][4:], f"fence schema {fs} vs baseline {S['fs0']}"
    assert app["fenceRoute"] == 401 and app["seqRoute"] == 401 and app["currentRoute"] == 401, app
    S["tables3"] = t
    return {"readiness": rd, "app": app, "dbVersion": 27, "migrationLogged": "migration complete" in log,
            "acknowledgedMetadataUnchanged": True, "fenceSchema": {"accountColumns": fs[0], "seqColumn": fs[1], "constraints": fs[2], "seqIndex": fs[3],
                                                                   "invalidConstraints": fs[4], "invalidIndexes": fs[5]},
            "derivedTablesChangedSinceOriginalRun": changed(S["tables1"], t), "rowDeltas": row_deltas(S["tables1"], t)}


def snap_fence():
    r = tool("fence-exercise", "indexd")
    assert r["ok"], r
    data = data_digest("indexd")
    assert data == S["data0"], "acknowledged metadata changed by the fence exercise"
    return {**r, "acknowledgedMetadataUnchanged": True}


def snap_rollback():
    b = ctl("backup")  # pre-rollback (v27)
    v = ctl("verify-backup", b["backup"])
    assert v["ok"] and v["restoredDbVersion"] == 27
    psql("indexd", (PKG / "migration" / "down-27-to-26.sql").read_text(), single_tx=True)  # as replicactl rollback
    assert db_version("indexd") == 26
    start_indexd("indexd-original")
    rd = wait_ready(26)
    app = {"fenceRoute": http(9982, "/fence", auth=False)[0]}
    rd["soakSeconds"] = soak("S5")
    stop_indexd("S5-original-after-rollback")
    gs5 = gs_columns("indexd")
    rd["globalSettingsColumnsChanged"] = sorted(k for k in gs5 if S["gs3"].get(k) != gs5.get(k))
    cs5 = {t: col_snapshot("indexd", t) for t in S["cs3"]}
    rd["derivedColumnChanges"] = {t: col_changes(S["cs3"][t], cs5[t]) for t in cs5}
    data = data_digest("indexd")
    sch, text = schema("indexd")
    t = table_digests("indexd", S["cols"])
    assert data == S["data0"], "acknowledged metadata changed across rollback"
    assert sch == S["schema0"], "schema after rollback differs from the restored production schema"
    assert app["fenceRoute"] == 404
    return {"preRollbackBackupVerified": True, "readiness": rd, "app": app, "dbVersion": 26, "acknowledgedMetadataUnchanged": True,
            "schemaEqualsRestoredProduction": True, "derivedTablesChangedSinceUpgradeRun": changed(S["tables3"], t),
            "rowDeltasSinceUpgradeRun": row_deltas(S["tables3"], t), "derivedTablesChangedVsBaseline": changed(S["tables0"], t)}


L = {}


def live_baseline():
    restore("indexd_live", INP / "live-indexd-20261020.pgdump")
    L["cols"] = base_columns("indexd_live")
    L["v"] = db_version("indexd_live")
    L["data0"] = data_digest("indexd_live")
    L["tables0"] = table_digests("indexd_live", L["cols"])
    L["schema0"], _ = schema("indexd_live")
    L["fs0"] = fence_schema("indexd_live")
    assert L["v"] == 26
    counts = {t: L["data0"][t]["rows"] for t in ("objects", "slabs", "contracts", "accounts")}
    return {"dbVersion": L["v"], "counts": counts, "schemaSha256": L["schema0"], "schemaEqualsSnapshotSchema": L["schema0"] == S["schema0"],
            "dataDigest": {k: v["md5"] for k, v in L["data0"].items()}}


def live_migrate():
    r = tool("migrate", "indexd_live")
    assert r["dbVersionBefore"] == 26 and r["dbVersionAfter"] == 27, r
    data = data_digest("indexd_live")
    fs = fence_schema("indexd_live")
    t = table_digests("indexd_live", L["cols"])
    assert data == L["data0"], "live metadata changed by the migration"
    assert fs[:4] == ["5", "1", "2", "1"] and fs[4:] == L["fs0"][4:], (fs, L["fs0"])
    return {**r, "acknowledgedMetadataUnchanged": True, "tablesChanged": changed(L["tables0"], t), "fenceSchemaOk": True}


def live_fence():
    r = tool("fence-exercise", "indexd_live")
    assert r["ok"], r
    assert data_digest("indexd_live") == L["data0"]
    return {**r, "acknowledgedMetadataUnchanged": True}


def live_rollback():
    psql("indexd_live", (PKG / "migration" / "down-27-to-26.sql").read_text(), single_tx=True)
    data = data_digest("indexd_live")
    sch, _ = schema("indexd_live")
    t = table_digests("indexd_live", L["cols"])
    assert db_version("indexd_live") == 26
    assert data == L["data0"] and sch == L["schema0"], "live rollback changed data or schema"
    return {"dbVersion": 26, "acknowledgedMetadataUnchanged": True, "schemaEqualsRestoredLive": True,
            "tablesChangedVsBaseline": changed(L["tables0"], t)}


def main():
    code = 0
    t0 = time.time()
    try:
        phase("0-setup-isolated", setup)
        phase("S0-snapshot-restore-baseline", snap_baseline)
        phase("S0b-fixture-seed-replacement", snap_seed_replacement)
        phase("S1-original-binary-runtime-v26", snap_original_runtime)
        phase("S2-controller-backup-verify", snap_backup)
        phase("S3-upgrade-candidate-v27", snap_upgrade)
        phase("S4-fence-exercise-real-account", snap_fence)
        phase("S5-rollback-original-binary-v26", snap_rollback)
        phase("L0-live-restore-baseline", live_baseline)
        phase("L1-live-migrate-26-27", live_migrate)
        phase("L2-live-fence-exercise", live_fence)
        phase("L3-live-rollback-27-26", live_rollback)
    except Exception:
        code = 1
    finally:
        cleanup()
        results["seconds"] = round(time.time() - t0, 1)
        results["soakSecondsPerRuntime"] = SOAK
        results["passed"] = code == 0 and all(p["ok"] for p in results["phases"])
        out = RES / "rehearsal-results.json"
        out.write_text(json.dumps(results, indent=1) + "\n")
        print(json.dumps({"passed": results["passed"], "cleanup": results.get("cleanup"), "seconds": results["seconds"]}))
    sys.exit(code)


if __name__ == "__main__":
    main()
