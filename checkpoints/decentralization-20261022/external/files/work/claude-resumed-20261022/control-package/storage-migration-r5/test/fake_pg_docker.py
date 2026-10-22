#!/usr/bin/env python3
"""fake_pg_docker.py - MOCK `docker` for test_verify.py. It never talks to a docker daemon or PostgreSQL. It models only
what replicactl's backup/verify/upgrade paths send through `docker exec`: psql (stdin SQL), pg_dump, pg_restore and
`command -v timeout`.

State is $FPG_STATE: {"dbs": {name: {"v": int, "digest": {table: [rows, md5]}}}, "sessions": {name: n}}.
Every call is logged as a JSON line in $FPG_LOG: {"op": ..., "db": ..., "sql": ...}.
Faults, a comma list in $FPG_FAULT:
  no-timeout       `command -v timeout` fails
  create-lost      CREATE DATABASE creates the database, then answers rc 2 "server closed the connection unexpectedly"
  create-nocreate-lost  CREATE DATABASE answers rc 2 (connection lost) and creates nothing (yet)
  create-error     CREATE DATABASE answers rc 3 (a server-reported SQL ERROR) "permission denied" and creates nothing
psql exit codes as real psql with ON_ERROR_STOP: 0 ok, 2 connection lost, 3 a server-reported SQL error.
  restore-killed   pg_restore is KILLed (rc 137) after creating partial content; its backend lingers for 2 session queries
  restore-fails    pg_restore answers rc 1 (the scratch database stays empty)
  restore-mismatch the restored content's digest differs
  linger-forever   after pg_restore a backend stays connected to the scratch database indefinitely
  drop-fails       DROP DATABASE answers rc 1
"""
import json
import os
import re
import sys

S, LOG = os.environ["FPG_STATE"], os.environ["FPG_LOG"]
FAULT = set(filter(None, os.environ.get("FPG_FAULT", "").split(",")))
DIGEST_SQL = os.environ.get("FPG_DIGEST_SQL", "")
st = json.load(open(S))
a = sys.argv[1:]


def save():
    json.dump(st, open(S, "w"))


def log(**k):
    with open(LOG, "a") as f:
        f.write(json.dumps(k) + "\n")


def done(rc=0, out="", err=""):
    sys.stdout.write(out)
    sys.stderr.write(err)
    sys.exit(rc)


if a[:1] != ["exec"]:
    done(2, err=f"fake: unsupported {a[:2]}")
i = 2 if a[1] == "-i" else 1
script = a[i + 3]                                 # exec [-i] <container> sh -c <script> $0 $1 ...
pos = a[i + 4:]
if script == "command -v timeout":
    log(op="probe-timeout")
    done(1 if "no-timeout" in FAULT else 0, "" if "no-timeout" in FAULT else "/usr/bin/timeout\n")
if "pg_dump" in script and "pg_restore" not in script:
    db = pos[1]
    log(op="pg_dump", db=db)
    done(0, json.dumps(st["dbs"][db]))
if "pg_restore" in script:
    db, tmo = pos[1], (pos[2] if len(pos) > 2 else None)
    log(op="pg_restore", db=db, bounded="timeout -s KILL" in script, tmo=tmo)
    data = json.loads(sys.stdin.read())
    if db not in st["dbs"]:
        done(1, err=f'pg_restore: error: database "{db}" does not exist')
    if "restore-fails" in FAULT:
        done(1, err="pg_restore: error: could not execute query")
    content = {"v": data["v"], "digest": dict(data["digest"])}
    if "restore-mismatch" in FAULT:
        content["digest"]["objects"] = [content["digest"].get("objects", [0, ""])[0], "f" * 32]
    st["dbs"][db] = content
    if "restore-killed" in FAULT:
        st["sessions"][db] = 2
        save()
        done(137, err="Killed")
    if "linger-forever" in FAULT:
        st["sessions"][db] = 10 ** 9
    save()
    done(0)
if "psql" in script:
    db = pos[1]
    sql = sys.stdin.read()
    log(op="psql", db=db, sql=sql)
    if "DROP DATABASE IF EXISTS" in sql:                       # r4's statement (the negative control)
        for name in re.findall(r'DROP DATABASE IF EXISTS "([^"]+)"', sql):
            st["dbs"].pop(name, None)
        for name in re.findall(r'CREATE DATABASE "([^"]+)"', sql):
            st["dbs"][name] = {"v": None, "digest": {}}
        save()
        done(0)
    m = re.fullmatch(r'CREATE DATABASE "([a-z0-9_]+)";', sql.strip())
    if m:
        name = m.group(1)
        if name in st["dbs"]:
            done(3, err=f'psql:<stdin>:1: ERROR:  database "{name}" already exists')
        if "create-error" in FAULT:
            done(3, err="psql:<stdin>:1: ERROR:  permission denied to create database")
        if "create-nocreate-lost" in FAULT:
            done(2, err="server closed the connection unexpectedly")
        st["dbs"][name] = {"v": None, "digest": {}}
        save()
        if "create-lost" in FAULT:
            done(2, err="server closed the connection unexpectedly")
        done(0)
    m = re.fullmatch(r'DROP DATABASE "([a-z0-9_]+)";', sql.strip())
    if m:
        if "drop-fails" in FAULT:
            done(3, err="psql:<stdin>:1: ERROR:  could not drop")
        if st["sessions"].get(m.group(1), 0):
            done(3, err=f'psql:<stdin>:1: ERROR:  database "{m.group(1)}" is being accessed by other users')
        st["dbs"].pop(m.group(1), None)
        save()
        done(0)
    m = re.fullmatch(r"SELECT count\(\*\) FROM pg_database WHERE datname = '([a-z0-9_]+)';", sql.strip())
    if m:
        done(0, f"{int(m.group(1) in st['dbs'])}\n")
    m = re.fullmatch(r"SELECT count\(\*\) FROM pg_stat_activity WHERE datname = '([a-z0-9_]+)';", sql.strip())
    if m:
        n = st["sessions"].get(m.group(1), 0)
        if 0 < n < 10 ** 9:
            st["sessions"][m.group(1)] = n - 1
            save()
        done(0, f"{n}\n")
    if sql.strip() == "SELECT db_version FROM global_settings;":
        d = st["dbs"].get(db)
        if not d or d["v"] is None:
            done(3, err='psql:<stdin>:1: ERROR:  relation "global_settings" does not exist')
        done(0, f"{d['v']}\n")
    if DIGEST_SQL and sql == DIGEST_SQL:
        d = st["dbs"].get(db) or {"digest": {}}
        done(0, "".join(f"{t}|{r}|{h}\n" for t, (r, h) in sorted(d["digest"].items())) + f"db_version|1|{d.get('v')}\n")
    if sql.strip() == "SHOW fsync; SHOW synchronous_commit;":
        done(0, "on\non\n")
    done(3, err=f"ERROR: fake: unsupported SQL {sql[:80]!r}")
done(2, err=f"fake: unsupported exec {script[:80]!r}")
