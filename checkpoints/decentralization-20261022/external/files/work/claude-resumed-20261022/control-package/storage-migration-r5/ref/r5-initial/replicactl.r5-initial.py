#!/usr/bin/env python3
"""replicactl: staged, verifiable install/upgrade/backup/rollback of ONE indexd node (indexd-fence release).

G-C2 PACKAGE COPY (work/indexd-c2-implementation/package): identical to work/indexd-replica-rollout/controller/
replicactl.py plus the commands upgrade-c2 (fence v27 -> G-C2 v28) and rollback-c2 (v28 -> v27).

storage-migration-r3 copy of that controller (ce63951e). Two changes, nothing else:
  1. Every psql/pg_dump/pg_restore in the container connects as ${POSTGRES_USER:-postgres}.
     The official image's superuser is "postgres" when POSTGRES_USER is unset, and production's postgres.env sets only
     POSTGRES_PASSWORD/POSTGRES_DB/PGDATA (work/storage-vm/stage-production.py). With ce63951e the empty -U made psql
     connect as the exec user "root", which does not exist: root's live r2 preflight capture cbe7e57f.
     Fixtures that set POSTGRES_USER are unaffected.
  2. check_secret_modes keeps its strict rule (no group/other bits) for every file. It allows exactly one explicit
     exception: profile key config_file_access, for config_file only. This is the production access model
     (stage-production.py + enclave-indexd.service):
       - indexd.yml is 0640, owned by root, group = the unit's own group;
       - the unprivileged unit can read it but not write it;
       - nobody else can read it.
     The exception requires:
       - a regular file (not a symlink) with link count 1;
       - mode exactly 0640, the owner and group named in the profile, and a non-root group;
       - the group's supplementary member list exactly as declared (normally none);
       - the users whose primary group it is exactly as declared (normally the service user alone);
       - a parent directory owned by the same owner (root) and not group/other writable.
     admin_password_file stays strict (no group/other bits) with no exception.

storage-migration-r4 = r3 (90a325b0) plus the review-access findings G1-G3, nothing else:
  - the exception also refuses a POSIX access ACL on config_file. An ACL can grant an extra reader while the mode still
    shows 0640. A filesystem without ACL support counts as no ACL; any other read error refuses.
  - every path component is lstat'ed, so a symlinked directory is refused.
    - The immediate parent keeps the r3 rule.
    - Each ancestor up to / must be a directory owned by root or the owner and not group/other writable; a root-owned
      sticky directory is allowed.
  The r4 preflight reads the same two facts: config.acl and config.path_components.

storage-migration-r5 = r4 (1b189bab) plus root's two review blockers, nothing else:
  1. Backup verification no longer drops a fixed "<database>_verify" (r4 ran DROP DATABASE IF EXISTS on that name, which
     could destroy an unrelated database). verify_backup() restores into a NEW scratch database:
     - the name is unique, random, valid and bounded: <prefix>_verify_<16 hex>, at most 63 bytes, [a-z0-9_] only;
     - it is recorded in <backup>/verify-<scratch>.json BEFORE the CREATE;
     - CREATE and DROP are separate psql calls, so neither runs inside a transaction block;
     - the scratch database is dropped only if OUR CREATE answered success, and only after no backend is still
       connected to it (no detached restore writer);
     - an existing name ("already exists") is never touched;
     - an ambiguous CREATE (lost answer, and the database now exists) is PRESERVED and reported, never dropped;
     - the restore is bounded both inside the container (`timeout -s KILL`) and on the host.
  2. upgrade and upgrade-c2 call that verifier BEFORE the switch, as their docstrings promised. On a failed verification
     nothing is switched. The UNCHANGED source release is restarted if that is safe (the current release and db_version
     are still those before the upgrade), and the command exits non-zero. The verification record stays in the backup
     directory, and any resume failure is reported.

Nothing here activates anything by itself: every mutating command needs an explicit --confirm flag naming the
action, and production profiles additionally refuse to run unless the node's ALLOW file exists (the same pattern as
work/storage-vm/enclave-indexd.service ConditionPathExists=/etc/enclave-indexd/ALLOW_LIVE_START).

Secrets are never printed, logged or passed on a command line: the admin password is read from a 0600 file, and
PostgreSQL credentials stay inside the database container (psql/pg_dump run there with the container's own env).

Profile (JSON) keys:
  runner           "systemd" (production) or "process" (fixture: the binary is a child of this tool, pid file)
  unit             systemd unit of indexd (runner=systemd)
  pg_container     docker container running PostgreSQL (production: enclave-indexd-postgres)
  database         database name (production: indexd)
  state_dir        indexd data directory (consensus.db, GeoLite2-City.mmdb)
  config_file      indexd.yml (0600; holds admin password, recovery phrase, database password)
  admin_url        e.g. http://127.0.0.1:9980/api  ;  admin_password_file  0600 file with the admin password
  app_url          advertised application API URL (signatures bind to its host)
  release_dir      where releases live: <release_dir>/<sha256>/indexd and the 'current' symlink
  backup_dir       backups (0700)
  migration_dir    directory holding digest.sql and down-27-to-26.sql (G-C2: and down-28-to-27.sql)
  allow_file       production only: activation guard file that must exist
  geoip_sha256     expected sha256 of state_dir/GeoLite2-City.mmdb (never downloaded: indexd would fetch it if absent)
  instant          runner=process only: pass -instant (default false; with no consensus.db it needs the explorer)
Commands: preflight, backup, verify-backup, install, upgrade, readiness, rollback, status, start, stop, digest,
crash-indexd (fixture only); G-C2: upgrade-c2, rollback-c2.
"""
import argparse
import base64
import errno
import grp
import hashlib
import json
import os
import pwd
import re
import secrets
import stat
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STOCK_DB_VERSION = 26
# the container's superuser: POSTGRES_USER if the container sets it, else the official image default "postgres"
PG_USER = '"${POSTGRES_USER:-postgres}"'
FENCE_DB_VERSION = 27
C2_DB_VERSION = 28
VERIFY_TIMEOUT_DEFAULT = 3600       # seconds one scratch restore may take (profile key verify_timeout_seconds)
SCRATCH_RX = re.compile(r"^[a-z0-9_]{1,63}$")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def die(msg, code=2):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(code)


class Node:
    def __init__(self, profile):
        self.p = json.loads(Path(profile).read_text())
        self.profile_path = Path(profile).resolve()

    def __getitem__(self, k):
        return self.p[k]

    # ---- PostgreSQL, inside the database container (credentials never leave it) ----
    def psql(self, sql=None, file=None, db=None, single_tx=False):
        args = ["docker", "exec", "-i", self["pg_container"], "sh", "-c",
                'psql -U ' + PG_USER + ' -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 ' + ("--single-transaction " if single_tx else "") + '-f -',
                "psql", db or self["database"]]
        data = sql if sql is not None else Path(file).read_text()
        r = subprocess.run(args, input=data.encode(), capture_output=True)
        if r.returncode != 0:
            raise RuntimeError("psql failed: " + r.stderr.decode()[-400:])
        return r.stdout.decode().strip()

    def psql_rc(self, sql, db="postgres", timeout=120):
        """one psql call that never raises for SQL errors -> (rc, stdout, stderr); rc None = the answer was lost (timeout)"""
        args = ["docker", "exec", "-i", self["pg_container"], "sh", "-c",
                'psql -U ' + PG_USER + ' -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -f -', "psql", db]
        try:
            r = subprocess.run(args, input=sql.encode(), capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, "", "timeout"
        return r.returncode, r.stdout.decode().strip(), r.stderr.decode()

    def db_version(self, db=None):
        return int(self.psql("SELECT db_version FROM global_settings;", db=db))

    def digest(self, db=None):
        out = self.psql(file=Path(self["migration_dir"]) / "digest.sql", db=db)
        d = {}
        for line in out.splitlines():
            name, rows, md5 = line.split("|")
            if name != "db_version":  # reported separately (db_version()); the digest covers data only
                d[name] = {"rows": int(rows), "md5": md5}
        return d

    # ---- the indexd process ----
    def running(self):
        if self["runner"] == "systemd":
            return subprocess.run(["systemctl", "is-active", "--quiet", self["unit"]]).returncode == 0
        pid = self.pid()
        return pid is not None

    def pid(self):
        pf = Path(self["state_dir"]) / "indexd.pid"
        if not pf.exists():
            return None
        pid = int(pf.read_text())
        try:
            os.kill(pid, 0)
            return pid
        except ProcessLookupError:
            pf.unlink()
            return None

    def start(self):
        if self["runner"] == "systemd":
            subprocess.run(["systemctl", "start", self["unit"]], check=True)
            return
        binary = Path(self["release_dir"]) / "current" / "indexd"
        log = open(Path(self["state_dir"]) / "indexd.out", "ab")
        env = dict(os.environ, INDEXD_CONFIG_FILE=self["config_file"], INDEXD_DATA_DIR=self["state_dir"], GOMEMLIMIT=self.p.get("gomemlimit", "512MiB"))
        flags = ["-instant"] if self.p.get("instant") else []  # -instant needs the explorer when consensus.db is absent
        proc = subprocess.Popen([str(binary), *flags], stdout=log, stderr=subprocess.STDOUT, env=env, cwd=self["state_dir"], start_new_session=True)
        (Path(self["state_dir"]) / "indexd.pid").write_text(str(proc.pid))

    def stop(self, timeout=180):
        if self["runner"] == "systemd":
            subprocess.run(["systemctl", "stop", self["unit"]], check=True)
            return
        pid = self.pid()
        if pid is None:
            return
        os.kill(pid, signal.SIGTERM)
        for _ in range(timeout * 10):
            if self.pid() is None:
                return
            time.sleep(0.1)
        raise RuntimeError("indexd did not stop")

    # ---- HTTP readiness ----
    def admin(self, path):
        pw = Path(self["admin_password_file"]).read_text().strip()
        req = urllib.request.Request(self["admin_url"].rstrip("/") + path)
        req.add_header("Authorization", "Basic " + base64.b64encode((":" + pw).encode()).decode())
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"null")

    def app_status(self, path):
        try:
            with urllib.request.urlopen(self["app_url"].rstrip("/") + path, timeout=10) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def wait_ready(self, want_version, timeout=120):
        last = None
        for _ in range(timeout):
            try:
                st, state = self.admin("/state")
                if st == 200 and self.db_version() == want_version:
                    return state
            except Exception as e:  # not up yet
                last = str(e)[:160]
            time.sleep(1)
        raise RuntimeError(f"not ready within {timeout}s: {last}")


def guard(node, action, args):
    if args.confirm != action:
        die(f"refusing: pass --confirm {action}")
    allow = node.p.get("allow_file")
    if node["runner"] == "systemd" and (not allow or not Path(allow).exists()):
        die(f"refusing: activation guard {allow} is absent (production activation is root's decision)")


TRUSTED_ACCESS_KEYS = {"mode", "owner", "group", "group_members", "group_primary_users"}


def check_trusted_group_access(path, spec, getgrnam=grp.getgrnam, getpwnam=pwd.getpwnam, getpwall=pwd.getpwall):
    """The explicit 0640 root:<service group> exception for config_file. Returns a list of reasons (empty = ok).
    Reads metadata only (lstat, the group and passwd databases); never the file's content."""
    bad = []
    if not isinstance(spec, dict) or set(spec) != TRUSTED_ACCESS_KEYS or spec.get("mode") != "0640" \
            or not all(isinstance(spec[k], str) and spec[k] for k in ("owner", "group")) \
            or not all(isinstance(spec[k], list) and all(isinstance(x, str) and x for x in spec[k]) for k in ("group_members", "group_primary_users")):
        return [f"config_file_access must be exactly {sorted(TRUSTED_ACCESS_KEYS)} with mode \"0640\", owner/group names and member lists"]
    if spec["owner"] in spec["group_members"] + spec["group_primary_users"]:
        return [f"config_file_access owner {spec['owner']!r} is in the reader group: the file owner can write it, the service must not"]
    try:
        st = os.lstat(path)
        owner, group = getpwnam(spec["owner"]), getgrnam(spec["group"])
    except (OSError, KeyError) as e:
        return [f"config_file access facts unavailable: {type(e).__name__}"]
    if not stat.S_ISREG(st.st_mode): bad.append("config_file is not a regular file (symlinks are refused)")
    if st.st_nlink != 1: bad.append(f"config_file has {st.st_nlink} hard links")
    if stat.S_IMODE(st.st_mode) != 0o640: bad.append(f"config_file mode {oct(stat.S_IMODE(st.st_mode))} != 0o640 (group read-only, no other access)")
    # review-access fix 1: a POSIX access ACL can grant a named user/group read access while the mode still shows 0640
    try:
        if "system.posix_acl_access" in os.listxattr(path, follow_symlinks=False): bad.append("config_file has a POSIX access ACL (extra readers are invisible in the mode)")
    except OSError as e:
        if e.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP): bad.append(f"config_file ACL unreadable: {type(e).__name__}")
    if st.st_uid != owner.pw_uid: bad.append(f"config_file owner uid {st.st_uid} != {spec['owner']} ({owner.pw_uid})")
    if st.st_gid != group.gr_gid: bad.append(f"config_file group gid {st.st_gid} != {spec['group']} ({group.gr_gid})")
    if group.gr_gid == 0: bad.append("trusted group is gid 0")
    if sorted(group.gr_mem) != sorted(spec["group_members"]):
        bad.append(f"group {spec['group']} supplementary members {sorted(group.gr_mem)} != declared {sorted(spec['group_members'])}")
    primary = sorted(u.pw_name for u in getpwall() if u.pw_gid == group.gr_gid)
    if primary != sorted(spec["group_primary_users"]):
        bad.append(f"users with primary group {spec['group']} {primary} != declared {sorted(spec['group_primary_users'])}")
    # review-access fix 2: lstat EVERY path component, so neither a symlinked directory nor a writable ancestor is followed.
    # The immediate parent keeps the r3 rule (owned by the owner, not group/other writable). Ancestors must be owned by root
    # or the owner and not group/other writable; a root-owned sticky directory such as /tmp is allowed.
    p, first = os.path.dirname(os.path.abspath(path)), True
    while True:
        try:
            d = os.lstat(p)
        except OSError as e:
            bad.append(f"config path component {p} unreadable: {type(e).__name__}"); break
        m = stat.S_IMODE(d.st_mode)
        if not stat.S_ISDIR(d.st_mode):
            bad.append(f"config path component {p} is not a directory (symlinked components are refused)")
        elif first and (d.st_uid != owner.pw_uid or m & 0o022):
            bad.append(f"config directory owner uid {d.st_uid} / mode {oct(m)}: must be owned by {spec['owner']} and not group/other writable")
        elif not first and (d.st_uid not in (0, owner.pw_uid) or (m & 0o022 and not (m & stat.S_ISVTX and d.st_uid == 0))):
            bad.append(f"config path ancestor {p} owner uid {d.st_uid} / mode {oct(m)}: must be root/owner-owned and not group/other writable (root sticky allowed)")
        if p == os.path.dirname(p): break
        p, first = os.path.dirname(p), False
    return bad


def check_secret_modes(node, **lookups):
    bad = []
    for k in ("config_file", "admin_password_file"):
        access = node.p.get("config_file_access") if k == "config_file" else None   # admin_password_file: never an exception
        if access is not None:
            bad.extend(f"{k}: {r}" for r in check_trusted_group_access(node[k], access, **lookups))
            continue
        m = Path(node[k]).stat().st_mode & 0o777
        if m & 0o077:
            bad.append(f"{k} mode {oct(m)}")
    text = Path(node["config_file"]).read_text()
    if "<PLACEHOLDER" in text or "CHANGE_ME" in text:
        bad.append("config_file still has placeholders")
    return bad


# ---- commands ----
def cmd_preflight(node, args):
    res = {"checks": {}}
    c = res["checks"]
    c["secretModes"] = check_secret_modes(node) or "ok"
    geo = Path(node["state_dir"]) / "GeoLite2-City.mmdb"
    c["geoip"] = "ok" if geo.exists() and sha256(geo) == node["geoip_sha256"] else "MISSING OR WRONG HASH (indexd would download it)"
    rel = Path(node["release_dir"]) / "current" / "indexd"
    c["release"] = sha256(rel) if rel.exists() else "no current release"
    mem = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
    c["memAvailableMiB"] = mem["MemAvailable"] // 1024
    c["swapMiB"] = mem["SwapTotal"] // 1024
    st = os.statvfs(node["state_dir"])
    c["diskFreeMiB"] = st.f_bavail * st.f_frsize // (1 << 20)
    need = node.p.get("require", {})
    fails = []
    if need:
        if c["memAvailableMiB"] < need["memAvailableMiB"]:
            fails.append(f"memAvailable {c['memAvailableMiB']} < required {need['memAvailableMiB']} MiB")
        if c["diskFreeMiB"] < need["diskFreeMiB"]:
            fails.append(f"disk {c['diskFreeMiB']} < required {need['diskFreeMiB']} MiB")
    if c["secretModes"] != "ok":
        fails.append("secrets")
    if not c["geoip"] == "ok":
        fails.append("geoip")
    res["ok"] = not fails
    res["failures"] = fails
    print(json.dumps(res))
    sys.exit(0 if res["ok"] else 1)


def cmd_backup(node, args, quiet=False):
    """Consistent backup: indexd must be STOPPED (no writer), then pg_dump (custom format) + consensus.db + digest."""
    if node.running():
        die("backup requires indexd stopped (quiesced); stop it first")
    out = Path(node["backup_dir"]) / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out.mkdir(parents=True, mode=0o700)
    dump = out / "indexd.pgdump"
    with open(dump, "wb") as f:
        r = subprocess.run(["docker", "exec", node["pg_container"], "sh", "-c",
                            'pg_dump -U ' + PG_USER + ' --format=custom --no-owner --no-acl "$1"', "pg_dump", node["database"]],
                           stdout=f, stderr=subprocess.PIPE)
    if r.returncode != 0:
        die("pg_dump failed: " + r.stderr.decode()[-300:])
    cons = Path(node["state_dir"]) / "consensus.db"
    files = {"indexd.pgdump": dump}
    if cons.exists():
        shutil.copyfile(cons, out / "consensus.db")
        files["consensus.db"] = out / "consensus.db"
    rel = Path(node["release_dir"]) / "current" / "indexd"
    manifest = {
        "takenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dbVersion": node.db_version(),
        "digest": node.digest(),
        "binarySha256": sha256(rel) if rel.exists() else None,
        "files": {k: {"sha256": sha256(v), "bytes": v.stat().st_size} for k, v in files.items()},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    os.chmod(out / "manifest.json", 0o600)
    for v in files.values():
        os.chmod(v, 0o600)
    if not quiet:
        print(json.dumps({"ok": True, "backup": str(out), "dbVersion": manifest["dbVersion"]}))
    return out


def scratch_name(database):
    """a fresh scratch database name for ONE verification: valid, bounded to PostgreSQL's 63 bytes, unguessable"""
    base = re.sub(r"[^a-z0-9_]", "_", database.lower())[:30] or "db"
    name = f"{base}_verify_{secrets.token_hex(8)}"
    if not SCRATCH_RX.match(name):
        raise RuntimeError("scratch name invalid")
    return name


def _scratch_count(node, name, table, column):
    rc, out, _ = node.psql_rc(f"SELECT count(*) FROM {table} WHERE {column} = '{name}';")
    return int(out) if rc == 0 and out.isdigit() else None       # None: the server could not tell


def _record(b, rep):
    p = Path(b) / f"verify-{rep['scratch']}.json"
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(rep, indent=1) + "\n")
    os.replace(tmp, p)


def verify_backup(node, backup, sessions_wait=120):
    """Restore a backup into a NEW scratch database of the same server and compare its digest and db_version with the
    manifest. Never raises for database failures and never exits: -> report.
    - report["ok"] is True only if the backup was verified;
    - report["cleanupOk"] is True only if no scratch database of ours is left;
    - report["scratchState"] says what happened to the scratch database.
    The production database is only read: by pg_restore's source, which is the dump file, and by nothing else."""
    b = Path(backup)
    rep = {"backup": str(b), "ok": False, "cleanupOk": True, "restoredDbVersion": None, "digestMatches": False, "problems": []}
    m = json.loads((b / "manifest.json").read_text())
    for name, meta in m["files"].items():
        if sha256(b / name) != meta["sha256"]:
            rep["problems"].append(f"{name} hash mismatch: nothing created")
            return rep
    tmo = int(node.p.get("verify_timeout_seconds", VERIFY_TIMEOUT_DEFAULT))
    r = subprocess.run(["docker", "exec", node["pg_container"], "sh", "-c", "command -v timeout"], capture_output=True, timeout=60)
    if r.returncode != 0:
        rep["problems"].append("no `timeout` in the database container: the restore cannot be bounded; nothing created")
        return rep
    rep["scratch"] = scratch = scratch_name(node["database"])
    rep["scratchState"] = "intent (CREATE not yet sent)"
    _record(b, rep)
    # 1. CREATE, alone (CREATE DATABASE cannot run in a transaction block). Ownership = OUR CREATE answered success.
    rc, _, err = node.psql_rc(f'CREATE DATABASE "{scratch}";')
    if rc != 0:
        n = _scratch_count(node, scratch, "pg_database", "datname")
        if rc is not None and "already exists" in err:
            rep["scratchState"] = "already existed: not ours, untouched"
            rep["problems"].append("scratch name already existed (not created by this verification)")
        elif n == 0:
            rep["scratchState"] = "not created"
            rep["problems"].append(f"CREATE DATABASE failed: {err.strip()[-200:]}")
        else:
            rep["scratchState"] = "AMBIGUOUS: the CREATE answer was lost or unclear and the database may exist; preserved, never dropped"
            rep["problems"].append("scratch creation ambiguous")
            rep["cleanupOk"] = False
        _record(b, rep)
        return rep
    rep["scratchState"] = "created (ours)"
    _record(b, rep)
    # 2. restore, bounded inside the container (pg_restore is KILLed at tmo) and on the host (tmo + 60)
    try:
        with open(b / "indexd.pgdump", "rb") as f:
            r = subprocess.run(["docker", "exec", "-i", node["pg_container"], "sh", "-c",
                                'timeout -s KILL "$2" pg_restore -U ' + PG_USER + ' --no-owner --no-acl --exit-on-error -d "$1"', "pg_restore", scratch, str(tmo)],
                               stdin=f, capture_output=True, timeout=tmo + 60)
        restored = r.returncode == 0
        if not restored:
            rep["problems"].append("pg_restore failed: " + r.stderr.decode()[-300:])
    except subprocess.TimeoutExpired:
        restored = False
        rep["problems"].append(f"pg_restore did not answer within {tmo + 60} s")
    if restored:
        try:
            d, v = node.digest(db=scratch), node.db_version(db=scratch)
            rep["restoredDbVersion"], rep["digestMatches"] = v, d == m["digest"]
            rep["ok"] = rep["digestMatches"] and v == m["dbVersion"]
        except Exception as e:
            rep["problems"].append(f"scratch digest unreadable: {str(e)[-200:]}")
    # 3. no detached writer: no backend may still be connected to the scratch database (bounded wait), then DROP alone
    n = None
    for _ in range(sessions_wait):
        n = _scratch_count(node, scratch, "pg_stat_activity", "datname")
        if n == 0:
            break
        time.sleep(1)
    if n != 0:
        rep["scratchState"] = f"KEPT: {n if n is not None else 'unknown'} backend(s) still connected after {sessions_wait} s (a restore writer may still run)"
        rep["cleanupOk"] = False
        _record(b, rep)
        return rep
    rc, _, err = node.psql_rc(f'DROP DATABASE "{scratch}";')
    left = _scratch_count(node, scratch, "pg_database", "datname")
    if rc == 0 and left == 0:
        rep["scratchState"] = "dropped"
    else:
        rep["scratchState"] = f"DROP not confirmed (rc {rc}, still present: {left}): kept, named here"
        rep["cleanupOk"] = False
        rep["problems"].append("scratch drop not confirmed: " + err.strip()[-200:])
    _record(b, rep)
    return rep


def cmd_verify_backup(node, args):
    """Restore a backup into a NEW scratch database in the same server and compare its digest with the manifest
    (verify_backup). Exit 0 only if verified AND no scratch database of ours is left."""
    rep = verify_backup(node, args.backup)
    print(json.dumps(rep))
    sys.exit(0 if rep["ok"] and rep["cleanupOk"] else 1)


def resume_unchanged(node, before, version):
    """after a failed pre-switch verification: restart the UNCHANGED source release if that is safe -> report"""
    cur = Path(node["release_dir"]) / "current"
    now = os.readlink(cur) if cur.is_symlink() else None
    if before is None or now != before:
        return {"resumed": False, "reason": f"current release {now} is not the pre-upgrade release {before}: not restarted"}
    try:
        v = node.db_version()
    except Exception as e:
        return {"resumed": False, "reason": f"db_version unreadable ({str(e)[-160:]}): not restarted"}
    if v != version:
        return {"resumed": False, "reason": f"db_version {v} != {version}: not restarted"}
    try:
        node.start()
        node.wait_ready(version)
    except Exception as e:
        return {"resumed": False, "resumeFailed": str(e)[-300:], "release": before}
    return {"resumed": True, "release": before, "dbVersion": version}


def verify_before_switch(node, b, before, version):
    """the upgrade's VERIFY step, BEFORE anything is switched. On failure: no switch, the unchanged source release is
    resumed if safe, evidence stays in the backup directory, and the command exits 1."""
    v = verify_backup(node, b)
    if v["ok"] and v["cleanupOk"]:
        return v
    res = resume_unchanged(node, before, version)
    print(json.dumps({"ok": False, "error": "backup verification failed before the switch: nothing switched",
                      "verify": v, "resume": res, "backup": str(b), "previousRelease": before}))
    sys.exit(1)


def cmd_install(node, args):
    guard(node, "install", args)
    src = Path(args.binary)
    h = sha256(src)
    if h != args.sha256:
        die(f"binary sha256 {h} != expected {args.sha256}")
    d = Path(node["release_dir"]) / h
    d.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, d / "indexd")
    os.chmod(d / "indexd", 0o755)
    print(json.dumps({"ok": True, "installed": str(d / "indexd")}))


def switch_current(node, h):
    cur = Path(node["release_dir"]) / "current"
    tmp = Path(node["release_dir"]) / ".current.tmp"
    if tmp.is_symlink():
        tmp.unlink()
    tmp.symlink_to(h)
    os.replace(tmp, cur)


def cmd_upgrade(node, args):
    """stock (v26) -> fence (v27). Order: stop -> fresh backup -> verify backup -> switch -> start (the binary migrates
    in ONE transaction) -> readiness: db_version 27 AND the acknowledged-metadata digest equals the backup's."""
    guard(node, "upgrade", args)
    target = Path(node["release_dir"]) / args.sha256 / "indexd"
    if not target.exists() or sha256(target) != args.sha256:
        die("release not installed or hash mismatch; run install first")
    before = os.readlink(Path(node["release_dir"]) / "current") if (Path(node["release_dir"]) / "current").is_symlink() else None
    node.stop()
    b = cmd_backup(node, args, quiet=True)
    m = json.loads((b / "manifest.json").read_text())
    if m["dbVersion"] != STOCK_DB_VERSION:
        die(f"expected db_version {STOCK_DB_VERSION} before upgrade, found {m['dbVersion']}")
    verify_before_switch(node, b, before, STOCK_DB_VERSION)
    switch_current(node, args.sha256)
    node.start()
    try:
        node.wait_ready(FENCE_DB_VERSION)
    except Exception as e:
        die(f"upgrade not ready: {e}; previous release {before}; backup {b}")
    after = node.digest()
    fence_route = node.app_status("/fence")
    ok = after == m["digest"] and fence_route == 401
    print(json.dumps({"ok": ok, "backup": str(b), "previousRelease": before, "dbVersion": node.db_version(), "backupVerified": True,
                      "digestPreserved": after == m["digest"], "fenceRouteStatusUnauthenticated": fence_route}))
    sys.exit(0 if ok else 1)


def cmd_readiness(node, args):
    st, state = node.admin("/state")
    res = {"adminState": st, "version": state.get("version") if isinstance(state, dict) else None,
           "network": state.get("network") if isinstance(state, dict) else None,
           "dbVersion": node.db_version(), "fenceRoute": node.app_status("/fence"),
           "seqRoute": node.app_status("/seq/objects")}
    if args.expect_digest:
        ref = json.loads(Path(args.expect_digest).read_text())
        ref = ref.get("digest", ref)
        res["digestMatches"] = node.digest() == ref
    res["ok"] = st == 200 and (args.expect_version is None or res["dbVersion"] == args.expect_version) and res.get("digestMatches", True)
    print(json.dumps(res))
    sys.exit(0 if res["ok"] else 1)


def cmd_rollback(node, args):
    """fence (v27) -> stock (v26). PRECONDITION: every fenced writer is stopped (after rollback an unfenced writer is
    accepted again). Order: stop -> backup (pre-rollback, v27) -> down-27-to-26.sql in ONE transaction -> switch to
    the stock release -> start -> readiness: db_version 26 AND digest equals the pre-rollback digest (data written
    after the upgrade is kept; only fence/seq metadata is dropped)."""
    guard(node, "rollback", args)
    if not args.fenced_writers_stopped:
        die("refusing: confirm --fenced-writers-stopped (all fenced writers of all accounts are stopped)")
    node.stop()
    b = cmd_backup(node, args, quiet=True)
    m = json.loads((b / "manifest.json").read_text())
    if m["dbVersion"] != FENCE_DB_VERSION:
        die(f"expected db_version {FENCE_DB_VERSION}, found {m['dbVersion']}")
    node.psql(file=Path(node["migration_dir"]) / "down-27-to-26.sql", single_tx=True)
    switch_current(node, args.stock_sha256)
    node.start()
    try:
        node.wait_ready(STOCK_DB_VERSION)
    except Exception as e:
        die(f"rollback not ready: {e}; pre-rollback backup {b}")
    after = node.digest()
    ok = after == m["digest"]
    print(json.dumps({"ok": ok, "preRollbackBackup": str(b), "dbVersion": node.db_version(), "digestPreserved": ok,
                      "fenceRouteStatusUnauthenticated": node.app_status("/fence")}))
    sys.exit(0 if ok else 1)


def cmd_upgrade_c2(node, args):
    """G-C2: fence (v27) -> G-C2 (v28). As upgrade: stop -> fresh backup (must be v27) -> verify -> switch -> start (the
    binary migrates in ONE transaction) -> readiness: db_version 28 AND the acknowledged-metadata digest is unchanged.
    Accounts are NOT enrolled by the upgrade: every account keeps its v3/stock behaviour until its writer enrols."""
    guard(node, "upgrade-c2", args)
    target = Path(node["release_dir"]) / args.sha256 / "indexd"
    if not target.exists() or sha256(target) != args.sha256:
        die("release not installed or hash mismatch; run install first")
    before = os.readlink(Path(node["release_dir"]) / "current") if (Path(node["release_dir"]) / "current").is_symlink() else None
    node.stop()
    b = cmd_backup(node, args, quiet=True)
    m = json.loads((b / "manifest.json").read_text())
    if m["dbVersion"] != FENCE_DB_VERSION:
        die(f"expected db_version {FENCE_DB_VERSION} before the G-C2 upgrade, found {m['dbVersion']}")
    # C2 acknowledges a head advance only after its transaction commits: that is durable only with fsync on and a
    # synchronous commit level that waits for the local WAL flush
    dur = node.psql("SHOW fsync; SHOW synchronous_commit;").split()
    if dur[:1] != ["on"] or (dur[1:2] or [""])[0] not in ("on", "local", "remote_apply"):
        die(f"refusing: PostgreSQL durability settings fsync/synchronous_commit = {dur}; C2 needs fsync=on and synchronous_commit on|local|remote_apply")
    verify_before_switch(node, b, before, FENCE_DB_VERSION)
    switch_current(node, args.sha256)
    node.start()
    try:
        node.wait_ready(C2_DB_VERSION)
    except Exception as e:
        die(f"G-C2 upgrade not ready: {e}; previous release {before}; backup {b}")
    after = node.digest()
    ok = after == m["digest"] and node.app_status("/fence") == 401
    print(json.dumps({"ok": ok, "backup": str(b), "previousRelease": before, "dbVersion": node.db_version(), "backupVerified": True,
                      "digestPreserved": after == m["digest"], "fenceRouteStatusUnauthenticated": node.app_status("/fence")}))
    sys.exit(0 if ok else 1)


def cmd_rollback_c2(node, args):
    """G-C2: v28 -> fence release (v27). PRECONDITION: every writer of every ENROLLED account is stopped (after the
    rollback a v3 request is accepted on them again; that is the downgrade the acknowledgement names). Order: stop ->
    backup (pre-rollback, v28) -> down-28-to-27.sql in ONE transaction -> switch -> start -> readiness: db_version 27
    AND the digest is unchanged. While any account is enrolled the SQL itself refuses unless --acknowledge-cas-downgrade
    is given; a refusal restarts the unchanged G-C2 release and reports refused (nothing is dropped)."""
    guard(node, "rollback-c2", args)
    if not args.cas_writers_stopped:
        die("refusing: confirm --cas-writers-stopped (all writers of all enrolled accounts are stopped)")
    before = os.readlink(Path(node["release_dir"]) / "current")
    node.stop()
    b = cmd_backup(node, args, quiet=True)
    m = json.loads((b / "manifest.json").read_text())
    if m["dbVersion"] != C2_DB_VERSION:
        die(f"expected db_version {C2_DB_VERSION}, found {m['dbVersion']}")
    sql = Path(node["migration_dir"]) / "down-28-to-27.sql"
    text = sql.read_text()
    if args.acknowledge_cas_downgrade:
        text = "SET LOCAL indexd.allow_cas_downgrade = 'on';\n" + text
    try:
        node.psql(sql=text, single_tx=True)
    except RuntimeError as e:
        node.start()
        node.wait_ready(C2_DB_VERSION)
        print(json.dumps({"ok": False, "refused": True, "reason": str(e)[-240:], "dbVersion": node.db_version(),
                          "release": before, "preRollbackBackup": str(b)}))
        sys.exit(1)
    switch_current(node, args.fence_sha256)
    node.start()
    try:
        node.wait_ready(FENCE_DB_VERSION)
    except Exception as e:
        die(f"G-C2 rollback not ready: {e}; pre-rollback backup {b}")
    after = node.digest()
    ok = after == m["digest"]
    print(json.dumps({"ok": ok, "preRollbackBackup": str(b), "dbVersion": node.db_version(), "digestPreserved": ok,
                      "acknowledgedCasDowngrade": bool(args.acknowledge_cas_downgrade)}))
    sys.exit(0 if ok else 1)


def cmd_status(node, args):
    print(json.dumps({"running": node.running(), "dbVersion": node.db_version(),
                      "current": os.readlink(Path(node["release_dir"]) / "current") if (Path(node["release_dir"]) / "current").is_symlink() else None}))


def cmd_digest(node, args):
    print(json.dumps({"dbVersion": node.db_version(), "digest": node.digest()}))


def cmd_crash_indexd(node, args):
    """FIXTURE ONLY: SIGKILL the indexd process (no graceful shutdown) to prove restart without data loss."""
    if node["runner"] != "process":
        die("crash-indexd is fixture-only")
    pid = node.pid()
    if pid is None:
        die("not running")
    os.kill(pid, signal.SIGKILL)
    for _ in range(100):
        if node.pid() is None:
            break
        time.sleep(0.1)
    print(json.dumps({"ok": True, "killed": pid}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("preflight")
    sub.add_parser("backup")
    s = sub.add_parser("verify-backup"); s.add_argument("backup")
    s = sub.add_parser("install"); s.add_argument("binary"); s.add_argument("--sha256", required=True); s.add_argument("--confirm")
    s = sub.add_parser("upgrade"); s.add_argument("--sha256", required=True); s.add_argument("--confirm")
    s = sub.add_parser("readiness"); s.add_argument("--expect-version", type=int); s.add_argument("--expect-digest")
    s = sub.add_parser("rollback"); s.add_argument("--stock-sha256", required=True); s.add_argument("--confirm"); s.add_argument("--fenced-writers-stopped", action="store_true")
    s = sub.add_parser("upgrade-c2"); s.add_argument("--sha256", required=True); s.add_argument("--confirm")
    s = sub.add_parser("rollback-c2"); s.add_argument("--fence-sha256", required=True); s.add_argument("--confirm")
    s.add_argument("--cas-writers-stopped", action="store_true"); s.add_argument("--acknowledge-cas-downgrade", action="store_true")
    sub.add_parser("status")
    sub.add_parser("start")
    sub.add_parser("stop")
    sub.add_parser("crash-indexd")
    sub.add_parser("digest")
    args = ap.parse_args()
    node = Node(args.profile)
    fn = {"preflight": cmd_preflight, "backup": cmd_backup, "verify-backup": cmd_verify_backup, "install": cmd_install,
          "upgrade": cmd_upgrade, "readiness": cmd_readiness, "rollback": cmd_rollback, "status": cmd_status,
          "crash-indexd": cmd_crash_indexd, "digest": cmd_digest, "upgrade-c2": cmd_upgrade_c2, "rollback-c2": cmd_rollback_c2,
          "start": lambda n, a: (n.start(), print(json.dumps({"ok": True, "started": True}))),
          "stop": lambda n, a: (n.stop(), print(json.dumps({"ok": True, "stopped": True})))}[args.cmd]
    fn(node, args)


if __name__ == "__main__":
    main()
