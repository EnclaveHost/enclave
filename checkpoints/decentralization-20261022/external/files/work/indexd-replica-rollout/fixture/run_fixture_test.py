#!/usr/bin/env python3
"""End-to-end fixture verification of the replica rollout package (run inside ONE shared-queue allocation).

Real pieces: the release binary (indexd-v0.6.0-fence.1), a stock v0.6.0 binary built from ddaf24b, the production
PostgreSQL image digest (fixture/pg-fixture.sh), replicactl.py, and the seeded stock database. The indexd processes
are children of this script, so they are inside the queue's memory cap; the PostgreSQL container is bounded by
docker (--memory 256m). Nothing here touches production, SSH or a chain; the node has no peers and no explorer.

Each stage asserts; results go to fixture/fixture-results.json. Exit 0 only if every stage passed.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parent
profile = here / "fixture-profile.json"
P = json.loads(profile.read_text())
CANDIDATE = root / "release" / "indexd-v0.6.0-fence.1-linux-amd64"
STOCK = here / "indexd-stock-v0.6.0-ddaf24b"
results = []


def ctl(*a, ok=True):
    r = subprocess.run([sys.executable, str(root / "controller" / "replicactl.py"), "--profile", str(profile), *a],
                       capture_output=True, text=True)
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        out = {"raw": r.stdout[-300:], "stderr": r.stderr[-300:]}
    if ok and r.returncode != 0:
        raise AssertionError(f"replicactl {a[0]} rc={r.returncode}: {out}")
    return out


def client(*a):
    r = subprocess.run([str(here / "rolloutclient"), "-url", P["app_url"], "-key", str(here / "secrets" / "app-key.hex"),
                        "-state", str(here / "secrets" / "client-state.json"), *a], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"client {a[0]}: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout)


def pg(*a):
    subprocess.run([str(here / "pg-fixture.sh"), *a], check=True, capture_output=True)


def sha(p):
    return subprocess.run(["sha256sum", str(p)], capture_output=True, text=True, check=True).stdout.split()[0]


def stage(name, fn):
    t0 = time.time()
    try:
        detail = fn()
        results.append({"stage": name, "ok": True, "seconds": round(time.time() - t0, 1), "detail": detail})
        print(f"PASS {name}: {json.dumps(detail)[:300]}", flush=True)
    except Exception as e:
        results.append({"stage": name, "ok": False, "seconds": round(time.time() - t0, 1), "error": str(e)[:600]})
        print(f"FAIL {name}: {str(e)[:600]}", flush=True)
        finish(1)


def finish(code):
    try:
        ctl("stop", ok=False)
    except Exception:
        pass
    (here / "fixture-results.json").write_text(json.dumps({"results": results, "passed": code == 0}, indent=2) + "\n")
    sys.exit(code)


def schema_dump(db):
    r = subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c",
                        'pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-acl "$1"', "pg_dump", db],
                       capture_output=True, text=True, check=True)
    return "\n".join(l for l in r.stdout.splitlines() if not l.startswith("--") and "\\restrict" not in l and "\\unrestrict" not in l)


seeded = {}
for line in (here / "digest-seeded-v26.txt").read_text().splitlines():
    n, rows, md5 = line.split("|")
    if n != "db_version":
        seeded[n] = {"rows": int(rows), "md5": md5}
stock_sha, cand_sha = sha(STOCK), sha(CANDIDATE)
state = {}


def s_stock_baseline():
    ctl("install", str(STOCK), "--sha256", stock_sha, "--confirm", "install")
    rel = Path(P["release_dir"])
    (rel / "current").unlink(missing_ok=True)
    (rel / "current").symlink_to(stock_sha)
    ctl("start")
    pre = ctl("preflight", ok=False)
    rd = None
    for _ in range(90):
        rd = ctl("readiness", "--expect-version", "26", ok=False)
        if rd.get("ok"):
            break
        time.sleep(1)
    assert rd and rd.get("ok"), rd
    d = ctl("digest")
    assert d["digest"] == seeded, "stock binary changed acknowledged metadata"
    ident = client("identity")
    assert ident["accountKeyMatches"]
    ctl("stop")
    return {"preflight": pre, "readiness": rd, "identity": ident, "digestEqualsSeed": True}


def s_backup_verify():
    b = ctl("backup")
    v = ctl("verify-backup", b["backup"])
    state["backup26"] = b["backup"]
    assert v["ok"] and v["restoredDbVersion"] == 26
    return {"backup": b, "verify": v}


def s_upgrade():
    ctl("install", str(CANDIDATE), "--sha256", cand_sha, "--confirm", "install")
    u = ctl("upgrade", "--sha256", cand_sha, "--confirm", "upgrade")
    assert u["ok"] and u["dbVersion"] == 27 and u["digestPreserved"] and u["fenceRouteStatusUnauthenticated"] == 401, u
    assert ctl("digest")["digest"] == seeded
    return u


def s_fenced_writes():
    keys = subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c",
                           'psql -U "$POSTGRES_USER" -d indexd -X -A -t -c "SELECT encode(o.object_key, \'hex\') FROM objects o WHERE NOT EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = o.object_key) ORDER BY 1"'],
                          capture_output=True, text=True, check=True).stdout.split()
    for k in keys:
        client("add-key", k)
    out = {"identity": client("identity"), "raise": client("raise"), "seqAfterRaise": client("seq"),
           "stockRefused": client("stock-refused"), "fencedPin": client("fenced-pin"), "seqAfterPin": client("seq"),
           "objects": client("objects")}
    assert out["identity"]["accountKeyMatches"]
    assert out["raise"]["head"] == 12, "backfill must number all 12 existing events (11 live + 1 tombstone)"
    assert out["seqAfterRaise"]["head"] == 12 and out["seqAfterRaise"]["events"] == 12
    assert out["stockRefused"]["refused409"], out["stockRefused"]
    assert out["seqAfterPin"]["head"] == 13
    assert out["objects"]["readable"] == out["objects"]["known"] == 11  # 10 seeded readable (1 is admin-blocked) + 1
    state["digestAfterWrites"] = ctl("digest")["digest"]
    assert state["digestAfterWrites"]["objects"]["rows"] == 12
    return out


def s_crash_indexd():
    ctl("crash-indexd")
    ctl("start")
    for _ in range(90):
        rd = ctl("readiness", "--expect-version", "27", ok=False)
        if rd.get("ok"):
            break
        time.sleep(1)
    assert rd.get("ok"), rd
    d = ctl("digest")["digest"]
    assert d == state["digestAfterWrites"], "data changed across an indexd SIGKILL"
    o = client("objects")
    assert o["readable"] == o["known"] == 11
    s = client("seq")
    assert s["head"] == 13
    return {"readiness": rd, "objects": o, "seq": s}


def s_crash_postgres():
    pg("kill")
    time.sleep(2)
    pg("start")
    rd = None
    for _ in range(120):
        rd = ctl("readiness", "--expect-version", "27", ok=False)
        if rd.get("ok"):
            break
        time.sleep(1)
    if not rd.get("ok"):  # the documented recovery path: restart indexd after its database came back
        ctl("stop", ok=False)
        ctl("start")
        for _ in range(90):
            rd = ctl("readiness", "--expect-version", "27", ok=False)
            if rd.get("ok"):
                break
            time.sleep(1)
    assert rd.get("ok"), rd
    d = ctl("digest")["digest"]
    assert d == state["digestAfterWrites"], "data changed across a PostgreSQL SIGKILL"
    w = client("fenced-pin")  # writes work after recovery, under the same fence
    o = client("objects")
    assert o["readable"] == o["known"] == 12
    s = client("seq")
    assert s["head"] == 14
    state["digestBeforeRollback"] = ctl("digest")["digest"]
    return {"readiness": rd, "fencedPinAfterRecovery": w, "objects": o, "seq": s}


def s_rollback():
    r = ctl("rollback", "--stock-sha256", stock_sha, "--confirm", "rollback", "--fenced-writers-stopped")
    assert r["ok"] and r["dbVersion"] == 26 and r["digestPreserved"], r
    assert r["fenceRouteStatusUnauthenticated"] == 404, "stock binary must not serve /fence"
    o = client("objects")
    assert o["readable"] == o["known"] == 12, "every object written under the fence survives the rollback"
    up = client("unfenced-pin")  # stock semantics again (why fenced writers must be stopped first)
    # schema after rollback == the stock v26 schema of the pre-upgrade backup
    subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c", 'psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS schema_ref" -c "CREATE DATABASE schema_ref"'], check=True, capture_output=True)
    with open(Path(state["backup26"]) / "indexd.pgdump", "rb") as f:
        subprocess.run(["docker", "exec", "-i", P["pg_container"], "sh", "-c", 'pg_restore -U "$POSTGRES_USER" --no-owner --no-acl --schema-only -d schema_ref'], stdin=f, check=True, capture_output=True)
    same = schema_dump("indexd") == schema_dump("schema_ref")
    subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c", 'psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE schema_ref"'], check=True, capture_output=True)
    assert same, "schema after rollback differs from the stock v26 schema"
    return {"rollback": r, "objects": o, "unfencedPinAccepted": up, "schemaEqualsStockV26": same}


def s_reupgrade():
    u = ctl("upgrade", "--sha256", cand_sha, "--confirm", "upgrade")
    assert u["ok"] and u["dbVersion"] == 27 and u["digestPreserved"], u
    o = client("objects")
    assert o["readable"] == o["known"] == 13
    ctl("stop")
    return {"upgrade": u, "objects": o}


stage("1-stock-v0.6.0-baseline", s_stock_baseline)
stage("2-quiesced-backup-and-restore-verify", s_backup_verify)
stage("3-upgrade-to-fence-release", s_upgrade)
stage("4-existing-identity-fenced-writes", s_fenced_writes)
stage("5-indexd-sigkill-restart", s_crash_indexd)
stage("6-postgres-sigkill-restart", s_crash_postgres)
stage("7-rollback-to-stock", s_rollback)
stage("8-re-upgrade-after-rollback", s_reupgrade)
finish(0)
