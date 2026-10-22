#!/usr/bin/env python3
"""fakes.py - MOCK systemctl / docker (PostgreSQL) / pgrep for test_migrate_step.py, dispatched by the name passed as argv[1] (bin/<name> wrappers).
State: $FAKE_STATE JSON:
- "unit": {"active": bool};
- "db": {"version", "fsync", "sync", "fenced", "enrolled", "size"};
- "sessions": [{"pid", "app", "db", "start"}];
- "scratch": [...];
- "log": [...].
Never touches a real service or database."""
import datetime as dt
import json
import os
import fcntl
import re
import sys
from pathlib import Path

S = Path(os.environ["FAKE_STATE"])
_lk = os.open(str(S) + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(_lk, fcntl.LOCK_EX)                  # held until exit: read-modify-write never interleaves with the fake controller
st = json.loads(S.read_text())
name = sys.argv[1]
a = sys.argv[2:]


def save():
    t = S.with_suffix(".tmp")
    t.write_text(json.dumps(st))
    os.replace(t, S)


def done(rc=0, out=""):
    sys.stdout.write(out)
    sys.exit(rc)


def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


st.setdefault("log", []).append([name] + a[:6])
save()
if name == "systemctl":
    if a[0] == "show":
        u = st["unit"]
        done(0, f"ActiveState={'active' if u['active'] else 'inactive'}\nSubState={'running' if u['active'] else 'dead'}\nMainPID={4242 if u['active'] else 0}\n")
    if a[0] == "start":
        if st.get("startFails"):
            done(1)
        st["unit"]["active"] = True
        save()
        done(0)
    if a[0] == "stop":
        st["unit"]["active"] = False
        save()
        done(0)
    done(2)
if name == "pgrep":
    w = st.get("writerOverride")
    done(0 if (w if w is not None else st["unit"]["active"]) else 1)
if name == "docker":
    # docker exec -e PGAPPNAME=<tag> -e PGOPTIONS=... <container> sh -c <script> psql <db> <sql> <inner>
    tag = next(x.split("=", 1)[1] for x in a if x.startswith("PGAPPNAME="))
    sql, db = a[-2], a[-3]
    d = st["db"]
    if sql == "SELECT db_version FROM global_settings;":
        if d.get("unreadable"):
            done(2)
        done(0, f"{d['version']}\n")
    if "clock_timestamp() AT TIME ZONE 'UTC'" in sql and "pg_stat_activity" not in sql:
        done(0, iso(now()) + "\n")
    if sql.startswith("SELECT pid || '|' || application_name"):
        m = re.search(r"backend_start >= '([^']+)'", sql)
        since = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc) if m else None
        rows = []
        for s in st["sessions"]:
            start = dt.datetime.strptime(s["start"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)
            if s["app"] in ("pg_dump", "psql", "pg_restore") and s["app"] != tag and (since is None or start >= since):
                rows.append(f"{s['pid']}|{s['app']}|{s['db']}|{s['start']}|{int((now() - start).total_seconds())}")
        done(0, "\n".join(rows) + ("\n" if rows else ""))
    m = re.match(r"SELECT count\(pg_terminate_backend\(pid\)\) FROM pg_stat_activity WHERE pid = (\d+) AND application_name = '([^']+)' AND backend_start = '([^']+)'", sql)
    if m:
        hit = [s for s in st["sessions"] if s["pid"] == int(m.group(1)) and s["app"] == m.group(2) and s["start"] == m.group(3)]
        for s in hit:
            st["sessions"].remove(s)
            st.setdefault("terminated", []).append(s)
        save()
        done(0, f"{len(hit)}\n")
    if sql == "SHOW fsync;":
        done(0, d["fsync"] + "\n")
    if sql == "SHOW synchronous_commit;":
        done(0, d["sync"] + "\n")
    if sql.startswith("SELECT string_agg(datname"):
        done(0, ",".join(st.get("scratch", [])) + "\n")
    if "count(*) FILTER (WHERE fence IS NOT NULL)" in sql:
        done(0, f"{d['fenced']}|{d['enrolled'] if 'cas_mode' in sql else 0}\n")
    if sql == "SELECT pg_database_size(current_database());":
        done(0, f"{d['size']}\n")
    if "information_schema.columns WHERE table_name='accounts'" in sql:
        f = {26: "0|0", 27: "5|0", 28: "5|3"}[d["version"]]
        done(0, f + "|0|0\n")
    m = re.match(r"SELECT count\(\*\) FROM pg_stat_activity WHERE datname = '([^']+)';", sql)
    if m:
        done(0, f"{sum(1 for s in st['sessions'] if s['db'] == m.group(1))}\n")
    m = re.match(r"SELECT count\(\*\) FROM pg_database WHERE datname = '([^']+)';", sql)
    if m:
        done(0, f"{int(m.group(1) in st.get('scratch', []))}\n")
    m = re.match(r'DROP DATABASE "([^"]+)";', sql)
    if m:
        st["scratch"].remove(m.group(1))
        st.setdefault("dropped", []).append(m.group(1))
        save()
        done(0)
    done(3, f"unsupported SQL {sql[:60]}")
done(2)
