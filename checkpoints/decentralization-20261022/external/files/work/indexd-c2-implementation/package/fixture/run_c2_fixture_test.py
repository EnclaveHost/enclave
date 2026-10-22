#!/usr/bin/env python3
"""End-to-end fixture verification of the G-C2 upgrade/rollback (run inside ONE shared-queue allocation, after
run-c2-fixture.sh has created the disposable PostgreSQL, seeded the database at v27 and created the node).

Real pieces: the indexd-fence release binary (61413110..., v27), the G-C2 candidate binary (v28), the production
PostgreSQL image digest, the package controller (controller/replicactl.py) and a database seeded through the
release store's own code. The indexd processes are children of this script (inside the queue's memory cap); the
PostgreSQL container is bounded by docker (--memory 256m). No production, SSH or chain; the node has no peers.

Each stage asserts; results go to fixture/c2-fixture-results.json. Exit 0 only if every stage passed.
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
FENCE = Path("/home/steven/Documents/Codex/2026-10-18/wo/work/indexd-replica-rollout/release/indexd-v0.6.0-fence.1-linux-amd64")
C2 = root / "release" / "indexd-v0.6.0-fence.2-c2-linux-amd64"
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
    out["_rc"] = r.returncode
    return out


def client(*a):
    r = subprocess.run([str(here / "c2client"), "-url", P["app_url"], "-key", str(here / "secrets" / "app-key.hex"),
                        "-state", str(here / "secrets" / "client-state.json"), *a], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"client {a[0]}: {r.stderr.strip()[-300:]}")
    return json.loads(r.stdout)


def sha(p):
    return subprocess.run(["sha256sum", str(p)], capture_output=True, text=True, check=True).stdout.split()[0]


def stage(name, fn):
    t0 = time.time()
    try:
        detail = fn()
        results.append({"stage": name, "ok": True, "seconds": round(time.time() - t0, 1), "detail": detail})
        print(f"PASS {name}: {json.dumps(detail)[:400]}", flush=True)
    except Exception as e:
        results.append({"stage": name, "ok": False, "seconds": round(time.time() - t0, 1), "error": str(e)[:600]})
        print(f"FAIL {name}: {str(e)[:600]}", flush=True)
        finish(1)


def finish(code):
    try:
        ctl("stop", ok=False)
    except Exception:
        pass
    (here / "c2-fixture-results.json").write_text(json.dumps({"results": results, "passed": code == 0,
                                                             "binaries": {"fence": fence_sha, "c2": c2_sha}}, indent=2) + "\n")
    sys.exit(code)


def schema_dump(db):
    r = subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c",
                        'pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-acl "$1"', "pg_dump", db],
                       capture_output=True, text=True, check=True)
    return "\n".join(l for l in r.stdout.splitlines() if not l.startswith("--") and "\\restrict" not in l and "\\unrestrict" not in l)


def wait_ready(version):
    rd = None
    for _ in range(90):
        rd = ctl("readiness", "--expect-version", str(version), ok=False)
        if rd.get("ok"):
            return rd
        time.sleep(1)
    raise AssertionError(f"not ready at v{version}: {rd}")


fence_sha, c2_sha = sha(FENCE), sha(C2)
state = {}


def s_fence_baseline():
    ctl("install", str(FENCE), "--sha256", fence_sha, "--confirm", "install")
    rel = Path(P["release_dir"])
    (rel / "current").unlink(missing_ok=True)
    (rel / "current").symlink_to(fence_sha)
    ctl("start")
    rd = wait_ready(27)
    state["seeded"] = ctl("digest")["digest"]
    keys = subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c",
                           'psql -U "$POSTGRES_USER" -d indexd -X -A -t -c "SELECT encode(o.object_key, \'hex\') FROM objects o WHERE NOT EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = o.object_key) ORDER BY 1"'],
                          capture_output=True, text=True, check=True).stdout.split()
    assert len(keys) == 10, len(keys)  # 12 seeded - 1 deleted - 1 admin-blocked
    for k in keys:
        client("add-key", k)
    ident = client("identity")
    assert ident["accountKeyMatches"]
    raised = client("raise")  # a v3 writer (the deployed SDK) raises and writes under the release
    assert raised["head"] == 12, raised  # backfill: 11 live + 1 tombstone
    pin = client("fenced-pin")
    refused = client("stock-refused")
    assert refused["refused409"], refused
    st = client("fence-state")
    # the release has no G-C2 fields: an SDK in C2 mode sees no "cas-v4" capability and must fail closed
    assert st["capabilities"] is None and st["mode"] is None and st["head"] == 13, st
    ctl("stop")
    return {"readiness": rd, "raise": raised, "v3Pin": pin, "stockRefused": refused, "releaseFenceState": st}


def s_backup_verify():
    b = ctl("backup")
    v = ctl("verify-backup", b["backup"])
    state["backup27"] = b["backup"]
    assert v["ok"] and v["restoredDbVersion"] == 27
    return {"backup": b, "verify": v}


def s_upgrade_c2():
    ctl("install", str(C2), "--sha256", c2_sha, "--confirm", "install")
    u = ctl("upgrade-c2", "--sha256", c2_sha, "--confirm", "upgrade-c2")
    assert u["ok"] and u["dbVersion"] == 28 and u["digestPreserved"], u
    st = client("fence-state")
    assert st["capabilities"] == ["fence-v3", "cas-v4", "op-nonce"] and st["mode"] is None and st["head"] == 13 and not st["lastOpRecorded"], st
    # NOT enrolled by the upgrade: the existing v3 writer keeps working unchanged
    pin = client("fenced-pin")
    assert client("fence-state")["head"] == 14
    return {"upgrade": u, "fenceState": st, "v3PinAfterUpgrade": pin}


def s_enrol_and_cas():
    r = client("raise-cas")
    assert r["mode"] == "cas" and r["head"] == 14, r
    st = client("fence-state")
    assert st["mode"] == "cas" and not st["lastOpRecorded"], st
    p = client("cas-pin")
    assert p["sq"] == 14 and p["seq"] == 15 and not p["replayed"], p
    rp = client("cas-replay")
    assert rp["seq"] == 15 and rp["replayed"], rp
    alt = client("cas-altered")
    assert alt["refused412op"], alt
    stale = client("cas-stale")
    assert stale["refused412seq"], stale
    v3 = client("v3-refused")
    assert v3["refused412mode"], v3
    stock = client("stock-refused")
    assert stock["refused409"], stock
    plain = client("raise-plain-refused")
    assert plain["refused412mode"], plain
    st = client("fence-state")
    assert st["head"] == 15 and st["mode"] == "cas" and st["lastOpIsOurs"], st
    o = client("objects")
    assert o["readable"] == o["known"], o
    state["digestEnrolled"] = ctl("digest")["digest"]
    return {"raiseCas": r, "casPin": p, "identicalReplay": rp, "alteredReplay": alt, "stale": stale, "v3": v3,
            "stock": stock, "plainRaise": plain, "fenceState": st, "objects": o}


def s_crash_restart():
    ctl("crash-indexd")
    ctl("start")
    rd = wait_ready(28)
    assert ctl("digest")["digest"] == state["digestEnrolled"], "data changed across an indexd SIGKILL"
    st = client("fence-state")
    assert st["head"] == 15 and st["mode"] == "cas" and st["lastOpIsOurs"], st  # enrolment and record are durable
    rp = client("cas-replay")
    assert rp["seq"] == 15 and rp["replayed"], rp  # the lost-answer retry still settles after the crash
    v3 = client("v3-refused")
    assert v3["refused412mode"], v3
    p = client("cas-pin")
    assert p["sq"] == 15 and p["seq"] == 16, p
    state["digestBeforeRollback"] = ctl("digest")["digest"]
    return {"readiness": rd, "fenceState": st, "replayAfterCrash": rp, "v3AfterCrash": v3, "casPin": p}


def s_rollback_refused_while_enrolled():
    r = ctl("rollback-c2", "--fence-sha256", fence_sha, "--confirm", "rollback-c2", "--cas-writers-stopped", ok=False)
    assert r["_rc"] != 0 and r.get("refused") and r["dbVersion"] == 28, r
    st = client("fence-state")
    assert st["mode"] == "cas" and st["head"] == 16, st  # nothing dropped; the G-C2 release serves again
    assert ctl("digest")["digest"] == state["digestBeforeRollback"]
    return {"rollback": {k: v for k, v in r.items() if k != "reason"}, "reasonHasRefusing": "refusing" in r.get("reason", ""), "fenceState": st}


def s_rollback_acknowledged():
    r = ctl("rollback-c2", "--fence-sha256", fence_sha, "--confirm", "rollback-c2", "--cas-writers-stopped", "--acknowledge-cas-downgrade")
    assert r["ok"] and r["dbVersion"] == 27 and r["digestPreserved"], r
    st = client("fence-state")
    assert st["capabilities"] is None and st["mode"] is None and st["head"] == 16, st
    o = client("objects")
    assert o["readable"] == o["known"], o  # everything written under C2 survives
    # schema after rollback == the v27 schema of the pre-upgrade backup
    subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c", 'psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS schema_ref" -c "CREATE DATABASE schema_ref"'], check=True, capture_output=True)
    with open(Path(state["backup27"]) / "indexd.pgdump", "rb") as f:
        subprocess.run(["docker", "exec", "-i", P["pg_container"], "sh", "-c", 'pg_restore -U "$POSTGRES_USER" --no-owner --no-acl --schema-only -d schema_ref'], stdin=f, check=True, capture_output=True)
    same = schema_dump(P["database"]) == schema_dump("schema_ref")
    subprocess.run(["docker", "exec", P["pg_container"], "sh", "-c", 'psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE schema_ref"'], check=True, capture_output=True)
    assert same, "schema after rollback differs from the v27 schema"
    # the documented consequence of the acknowledged downgrade: a v3 request with the exact credential works again
    v3 = client("fenced-pin")
    return {"rollback": r, "fenceState": st, "objects": o, "schemaEqualsV27": same, "v3PinAcceptedAfterDowngrade": v3}


def s_reupgrade():
    u = ctl("upgrade-c2", "--sha256", c2_sha, "--confirm", "upgrade-c2")
    assert u["ok"] and u["dbVersion"] == 28 and u["digestPreserved"], u
    st = client("fence-state")
    assert st["mode"] is None and not st["lastOpRecorded"], st  # the downgrade dropped the enrolment; it is not resurrected
    r = client("raise-cas")
    p = client("cas-pin")
    assert r["mode"] == "cas" and p["seq"] == p["sq"] + 1, (r, p)
    o = client("objects")
    assert o["readable"] == o["known"], o
    ctl("stop")
    return {"upgrade": u, "fenceStateBeforeReEnrol": st, "reEnrol": r, "casPin": p, "objects": o}


stage("1-fence-release-v27-baseline-v3-writer", s_fence_baseline)
stage("2-quiesced-backup-and-restore-verify", s_backup_verify)
stage("3-upgrade-to-c2-v28-not-enrolled", s_upgrade_c2)
stage("4-enrol-cas-replay-conflicts-refusals", s_enrol_and_cas)
stage("5-indexd-sigkill-restart-enrolment-durable", s_crash_restart)
stage("6-rollback-refused-while-enrolled", s_rollback_refused_while_enrolled)
stage("7-rollback-acknowledged-schema-equals-v27", s_rollback_acknowledged)
stage("8-re-upgrade-not-re-enrolled-then-re-enrol", s_reupgrade)
finish(0)
