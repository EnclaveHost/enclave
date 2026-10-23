#!/usr/bin/env python3
# ======================================================================================================================
# POSTGRESQL DRAIN (root's review of fbaecfce, counterexample 555dc752): process-down does not prove that no enrolment can
# still complete. Small fixture, ACTUAL components, no hosts, no wasm:
#   - the live primary's indexd release 2c0e5b06 (cmd/indexd, the run.go shutdown path), offline, on a private PostgreSQL
#     18.6 cluster: the indexd role is not a superuser, as on the live VM;
#   - the reviewed controller 1543577f (runner "process"): `start`, `stop` (SIGTERM, wait) and `crash-indexd` (SIGKILL);
#   - the c2rclient of the C2 production-copy rehearsal (e76693f6): register, raise-cas (POST /fence mode "cas", the
#     enrolment C2 performs) over indexd's real application and admin APIs;
#   - the ACTUAL scripts root runs: package/primary/db-barrier.sh (new) and vm-state.v2.sh (adacd37f). The fixture copy of
#     each differs ONLY in the start-guard path (checked). They run through three fixture shims:
#     - docker exec -> the same psql command line on this cluster's socket, as the container superuser;
#     - systemctl show -> the unit's properties, DERIVED from the actual indexd process: running, or its reaped exit
#       status, with systemd's meanings;
#     - pgrep -u enclave-indexd -> pgrep in this PID namespace.
# FIXTURE-ONLY mutations (the private cluster): roles/databases and, in D1-D3, a DEFERRED constraint trigger that holds
# the COMMIT of an enrolment for a few seconds, i.e. the window root's probe opened with pg_sleep (a slow commit:
# fsync, a lock wait in a deferred check). indexd's own SQL is unchanged.
#   N  never-enrolled: R2 guard aside, R3 controller stop (exit 0); then
#      F1 an idle unrelated session -> UNKNOWN, the session is left alone;
#      F2 a session holding accounts rows -> the barrier's lock times out -> UNKNOWN, the session is left alone;
#      F3 the barrier interrupted (KILLed) while waiting -> UNKNOWN, its backend goes away by itself, nothing left behind;
#      then vm-state alone -> UNKNOWN; the barrier -> SAFE only with the owner's attestation.
#   B  commit before the stop: enrolled while running, controller stop -> FORWARD_ONLY.
#   D1 commit AFTER an abnormal stop: indexd sent the enrolment's COMMIT, the controller KILLs it (crash-indexd), the
#      process is reaped and the unit is failed, the account still reads unenrolled while its backend commits:
#      - the fbaecfce (and 6fd7a929) decision on the actual vm-state.v2.sh output -> LEGACY_REDEPLOY_SAFE (negative control);
#      - the new one -> UNKNOWN;
#      - db-barrier.sh WAITS for the commit and reads CAS=1 -> FORWARD_ONLY.
#   D2 the graceful stop during the same pending COMMIT: the controller's SIGTERM waits for the handler -> exit 0 only after
#      the commit; the barrier then -> FORWARD_ONLY.
#   D3 two SIGTERMs during the pending COMMIT (the operator's interrupt that run.go allows): observed, then the barrier ->
#      FORWARD_ONLY whatever the process did.
# ======================================================================================================================
import base64, ctypes, hashlib, importlib.util, json, os, re, secrets, shutil, signal, subprocess, sys, tempfile, threading, time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RELEASE = os.path.abspath(os.path.join(HERE, ".."))
WORK = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PGROOT = os.path.join(WORK, "storage-host-role/pg18/root")
PGBIN, PGLIB = os.path.join(PGROOT, "usr/bin"), os.path.join(PGROOT, "usr/lib")
INDEXD = os.path.join(WORK, "claude-resumed-20261022/storage-enclave-build/out/c2-enclave-a/indexd")
CONTROLLER = os.path.join(WORK, "resume-after-checkpoint-20261022/controller-bounds-validation/frozen/replicactl.r5-production.restorefix.bounds.py")
CLIENT = os.path.join(WORK, "indexd-c2-production-rehearsal/bin/c2rclient")
GEOIP = os.path.join(WORK, "claude-resumed-20261022/storage-funding-test-fix/snapshots/c2-enclave/GeoLite2-City.mmdb")
BARRIER = os.path.join(RELEASE, "package/primary/db-barrier.sh")
VMSTATE = os.path.join(RELEASE, "package/primary/vm-state.v2.sh")
PINS = {INDEXD: "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7",
        CONTROLLER: "1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83",
        CLIENT: "e76693f68b70caa2b7309c1f29ace904e975f2dda7503e344eaa15d6e8f53458",
        GEOIP: "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
        VMSTATE: None}   # the full hash comes from package/PINS.json (primary.vm-state-v2)
LIVE_GUARD = "/etc/enclave-indexd/ALLOW_LIVE_START"

run_id = sys.argv[1]
assert re.fullmatch(r"[a-z0-9]{1,12}", run_id)
RUN = os.path.join(HERE, "runs", run_id)
os.makedirs(RUN)
R = {"run": run_id, "started": time.time(), "inputs": {}, "checks": [], "events": [], "scenarios": {}}
sha_file = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()


def save():
    json.dump(R, open(os.path.join(RUN, "results.json"), "w"), indent=1, default=str)


def log(*a):
    line = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)
    R["events"].append(line)


def check(name, ok, detail=""):
    R["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)[:1500]})
    log("CHECK", "PASS" if ok else "FAIL", name, str(detail)[:300])
    save()
    return bool(ok)


def load(name, path):
    sp = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m


sys.path.insert(0, os.path.join(RELEASE, "package", "tools"))
import cutover  # noqa: E402
OLD = {"fbaecfce": load("cutover_fbaecfce", os.environ["OLD_CUTOVER_FBA"]), "6fd7a929": load("cutover_6fd7a929", os.environ["OLD_CUTOVER_6FD"])}


def preconditions():
    pins = json.load(open(os.path.join(RELEASE, "package/PINS.json")))["files"]
    for p, want in PINS.items():
        got = sha_file(p)
        R["inputs"][os.path.relpath(p, WORK)] = got
        if p == VMSTATE:
            want = pins["primary.vm-state-v2"]["sha256"]
        if got != want:
            raise SystemExit(f"pin mismatch {p}: {got} != {want}")
    R["inputs"]["db-barrier.sh"] = sha_file(BARRIER)
    R["inputs"]["cutover.py"] = sha_file(os.path.join(RELEASE, "package/tools/cutover.py"))
    R["inputs"]["oldCutover"] = {k: sha_file(m.__file__) for k, m in OLD.items()}
    nets = sorted(l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:])
    R["isolation"] = {"netInterfaces": nets, "uid": os.getuid(), "pid": os.getpid()}
    if nets != ["lo"] or os.getuid() == 0 or os.getpid() > 50:
        raise SystemExit(f"refused: not in the private namespaces (interfaces {nets}, uid {os.getuid()}, pid {os.getpid()})")
    ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)   # PR_SET_CHILD_SUBREAPER: the controller's orphaned indexd is ours to reap


# ---------------- private PostgreSQL 18 (the container's role: a superuser on a local socket) ----------------

class PG:
    def __init__(self):
        self.data = os.path.join(RUN, "pg", "data")
        os.makedirs(os.path.dirname(self.data))
        self.sock = tempfile.mkdtemp(prefix=f"dbd-{run_id}-", dir="/tmp")
        self.env = {"PATH": f"{PGBIN}:/usr/bin:/bin", "LD_LIBRARY_PATH": PGLIB, "LC_ALL": "C", "TZ": "UTC"}
        self.p = None
        pw = os.path.join(RUN, "pg", "pw")
        fd = os.open(pw, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, secrets.token_hex(24).encode()); os.close(fd)
        subprocess.run([os.path.join(PGBIN, "initdb"), "-D", self.data, "-U", "postgres", f"--pwfile={pw}", "--auth-local=trust",
                        "--auth-host=scram-sha-256", "-E", "UTF8", "--locale=C"], env=self.env, check=True, capture_output=True)
        os.unlink(pw)
        self.log = open(os.path.join(RUN, "postgres.log"), "w")
        # FIXTURE footprint (one indexd): no I/O workers, no autovacuum. Durability settings stay at their defaults
        # (fsync, synchronous_commit on), as on the live container (only listen_addresses, shared_buffers, max_connections).
        self.p = subprocess.Popen([os.path.join(PGBIN, "postgres"), "-D", self.data, "-c", "listen_addresses=127.0.0.1", "-p", "5432",
                                   "-c", f"unix_socket_directories={self.sock}", "-c", "shared_buffers=16MB", "-c", "max_connections=50",
                                   "-c", "io_method=sync", "-c", "autovacuum=off", "-c", "max_worker_processes=2",
                                   "-c", "max_parallel_workers=0", "-c", "max_logical_replication_workers=0"],
                                  env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(60):
            if subprocess.run([os.path.join(PGBIN, "pg_isready"), "-h", self.sock], env=self.env, capture_output=True).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise SystemExit("PostgreSQL not ready")
        R["postgres"] = self.q("SELECT version()", "postgres")
        R["postgresSettings"] = self.q("SELECT string_agg(name || '=' || setting, ' ' ORDER BY name) FROM pg_settings WHERE name IN "
                                       "('client_connection_check_interval','synchronous_commit','fsync','max_prepared_transactions',"
                                       "'lock_timeout','statement_timeout','transaction_timeout','idle_in_transaction_session_timeout')", "postgres")
        log("postgres ready", R["postgres"][:40], R["postgresSettings"])

    def q(self, sql, db="indexd", inp=None):
        """the FIXTURE's own superuser session (application_name dbd-fixture)"""
        r = subprocess.run([os.path.join(PGBIN, "psql"), "-h", self.sock, "-U", "postgres", "-d", db, "-X", "-A", "-t", "-q",
                            "-v", "ON_ERROR_STOP=1", *(["-c", sql] if inp is None else ["-f", "-"])],
                           env={**self.env, "PGAPPNAME": "dbd-fixture"}, input=inp, capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise RuntimeError(r.stderr[-500:])
        return r.stdout.strip()

    def session(self, app, sql):
        """a long-lived psql session of the fixture (stdin kept open); `sql` is sent at once"""
        p = subprocess.Popen([os.path.join(PGBIN, "psql"), "-h", self.sock, "-U", "postgres", "-d", "indexd", "-X", "-q", "-v", "ON_ERROR_STOP=1"],
                             env={**self.env, "PGAPPNAME": app}, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        p.stdin.write(sql + "\n"); p.stdin.flush()
        return p

    def pids(self, where):
        return [x for x in self.q(f"SELECT pid FROM pg_stat_activity WHERE datname = 'indexd' AND {where} ORDER BY pid", "postgres").split() if x]

    def wait(self, sql, want, secs, db="postgres"):
        """fixture synchronisation only (never evidence): poll until `sql` returns `want`"""
        t0 = time.time()
        while time.time() - t0 < secs:
            if self.q(sql, db) == want:
                return round(time.time() - t0, 2)
            time.sleep(0.05)
        return None

    def close(self):
        if self.p is not None:
            subprocess.run([os.path.join(PGBIN, "pg_ctl"), "-D", self.data, "-m", "fast", "-w", "-t", "60", "stop"], env=self.env, capture_output=True)
            try:
                self.p.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.p.kill(); self.p.wait(timeout=30)
        shutil.rmtree(os.path.join(RUN, "pg"), ignore_errors=True)
        shutil.rmtree(self.sock, ignore_errors=True)


# ---------------- the indexd "unit" (DERIVED from the actual process) and the shims ----------------

UNIT = {"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "Result": "success", "ExecMainCode": "0", "ExecMainStatus": "0",
        "InvocationID": "", "NRestarts": "0"}
UNIT_JSON = os.path.join(RUN, "unit.json")
TRACK = {"pid": None, "exit": None, "exitAt": None}
LOCK = threading.Lock()


def write_unit():
    tmp = UNIT_JSON + ".tmp"
    json.dump(UNIT, open(tmp, "w")); os.replace(tmp, UNIT_JSON)


def reaper():
    """reap ONLY the tracked indexd (an orphan of the controller's start, re-parented to this subreaper) and set the unit's
    properties as systemd would: exit 0 -> inactive/success; another code -> failed/exit-code; a signal -> failed/signal"""
    while True:
        with LOCK:
            pid = TRACK["pid"]
            if pid is not None:
                try:
                    got, st = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    got, st = 0, 0
                if got == pid:
                    TRACK.update(pid=None, exit=st, exitAt=time.time())
                    if os.WIFEXITED(st):
                        code = os.WEXITSTATUS(st)
                        UNIT.update(ExecMainCode="1", ExecMainStatus=str(code), MainPID="0",
                                    **({"ActiveState": "inactive", "SubState": "dead", "Result": "success"} if code == 0 else
                                       {"ActiveState": "failed", "SubState": "failed", "Result": "exit-code"}))
                    else:
                        UNIT.update(ExecMainCode="2", ExecMainStatus=str(os.WTERMSIG(st)), MainPID="0", ActiveState="failed", SubState="failed",
                                    Result="signal")
                    write_unit()
        time.sleep(0.02)


def shims(pg):
    d = os.path.join(RUN, "shim")
    os.makedirs(d)
    py = "#!/usr/bin/python3 -I\nimport json, os, sys\n"
    files = {
        "docker": py + f"""a = sys.argv[1:]
if a[:1] != ["exec"]:
    sys.exit("fixture docker shim: exec only")
a, env = a[1:], dict(os.environ)
while a and a[0].startswith("-"):
    f = a.pop(0)
    if f == "-e":
        k, v = a.pop(0).split("=", 1); env[k] = v
    elif f != "-i":
        sys.exit("fixture docker shim: flag " + f)
if a.pop(0) != "enclave-indexd-postgres":
    sys.exit("fixture docker shim: unknown container")
env.update(PATH={PGBIN!r} + ":/usr/bin:/bin", LD_LIBRARY_PATH={PGLIB!r}, PGHOST={pg.sock!r}, POSTGRES_USER="postgres")
os.execvpe(a[0], a, env)
""",
        "systemctl": py + f"""a = sys.argv[1:]
if a[:1] != ["show"]:
    sys.exit(1)
props, value, unit, i = [], False, None, 1
while i < len(a):
    if a[i] == "-p":
        props.append(a[i + 1]); i += 2
    elif a[i] == "--value":
        value = True; i += 1
    elif a[i] == "--no-pager":
        i += 1
    else:
        unit = a[i]; i += 1
if unit != "enclave-indexd":
    sys.exit(1)
st = json.load(open({UNIT_JSON!r}))
for p in props:
    print(st.get(p, "") if value else p + "=" + st.get(p, ""))
""",
        "pgrep": py + """a = sys.argv[1:]
while "-u" in a:
    i = a.index("-u"); del a[i:i + 2]
os.execv("/usr/bin/pgrep", ["pgrep", *a])
"""}
    for n, t in files.items():
        p = os.path.join(d, n)
        open(p, "w").write(t); os.chmod(p, 0o755)
    return d


GUARD = os.path.join(RUN, "etc", "ALLOW_LIVE_START")


def fixture_copy(src, name):
    """the actual script with ONLY the start-guard path changed (checked: exactly one occurrence, nothing else differs)"""
    text = open(src).read()
    assert text.count(LIVE_GUARD) == 1, (src, text.count(LIVE_GUARD))
    out = text.replace(LIVE_GUARD, GUARD)
    p = os.path.join(RUN, name)
    open(p, "w").write(out)
    R["inputs"]["fixtureCopy." + name] = {"source": hashlib.sha256(text.encode()).hexdigest(), "copy": hashlib.sha256(out.encode()).hexdigest(),
                                          "onlyGuardPathChanged": out.replace(GUARD, LIVE_GUARD) == text}
    return p


def run_script(path, env, out_name):
    r = subprocess.run(["bash", path], env=env, capture_output=True, text=True, timeout=150)
    text = r.stdout
    open(os.path.join(RUN, out_name), "w").write(text)
    if r.stderr.strip():
        open(os.path.join(RUN, out_name + ".stderr"), "w").write(r.stderr[-4000:])
    return text


# ---------------- one indexd node per scenario (fresh database and state; the controller drives the process) ----------------

class Node:
    PHRASE = None

    def __init__(self, pg, name, ports):
        self.pg, self.name = pg, name
        self.dir = os.path.join(RUN, name)
        self.state, self.sec, rel = os.path.join(self.dir, "state"), os.path.join(self.dir, "secrets"), os.path.join(self.dir, "releases")
        for d in (self.state, self.sec, os.path.join(rel, "r2c0e5b06")):
            os.makedirs(d, mode=0o700)
        shutil.copyfile(INDEXD, os.path.join(rel, "r2c0e5b06", "indexd")); os.chmod(os.path.join(rel, "r2c0e5b06", "indexd"), 0o755)
        os.symlink("r2c0e5b06", os.path.join(rel, "current"))
        shutil.copyfile(GEOIP, os.path.join(self.state, "GeoLite2-City.mmdb"))
        if Node.PHRASE is None:
            out = subprocess.run([INDEXD, "seed"], capture_output=True, text=True, check=True).stdout
            Node.PHRASE = next(l.split(":", 1)[1].strip() for l in out.splitlines() if l.startswith("Recovery Phrase:"))
        dbpw, self.adminpw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        # a fresh indexd database owned by a NON-superuser role, as on the live VM
        pg.q("", "postgres", inp=f"DROP DATABASE IF EXISTS indexd;\nDROP ROLE IF EXISTS indexd;\n"
                                  f"CREATE ROLE indexd LOGIN NOSUPERUSER PASSWORD '{dbpw}';\nCREATE DATABASE indexd OWNER indexd;\n")
        self.pa, self.pb, self.ps = ports
        cfg = f"""autoOpenWebUI: false
directory: {self.state}
recoveryPhrase: "{Node.PHRASE}"
adminAPI:
  address: 127.0.0.1:{self.pa}
  password: "{self.adminpw}"
applicationAPI:
  address: 127.0.0.1:{self.pb}
  advertiseURL: http://127.0.0.1:{self.pb}
syncer:
  address: 127.0.0.1:{self.ps}
  bootstrap: false
  enableUPnP: false
  peers: []
consensus:
  network: mainnet
explorer:
  enabled: false
  url: ""
database:
  host: 127.0.0.1
  port: 5432
  user: indexd
  password: "{dbpw}"
  database: indexd
  sslmode: disable
log:
  stdout:
    enabled: true
    level: info
    format: json
  file:
    enabled: false
"""
        for n, t in (("indexd.yml", cfg), ("admin-password", self.adminpw)):
            fd = os.open(os.path.join(self.sec, n), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, t.encode()); os.close(fd)
        self.profile = os.path.join(self.dir, "profile.json")
        json.dump({"runner": "process", "pg_container": "enclave-indexd-postgres", "database": "indexd", "state_dir": self.state,
                   "config_file": os.path.join(self.sec, "indexd.yml"), "admin_url": f"http://127.0.0.1:{self.pa}/api",
                   "admin_password_file": os.path.join(self.sec, "admin-password"), "app_url": f"http://127.0.0.1:{self.pb}",
                   "release_dir": rel, "gomemlimit": "256MiB"}, open(self.profile, "w"), indent=1)
        self.client_state = os.path.join(self.sec, "client-state.json")

    def ctl(self, cmd):
        r = subprocess.run([sys.executable, "-I", CONTROLLER, "--profile", self.profile, cmd], capture_output=True, text=True, timeout=300)
        try:
            out = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            out = {"raw": r.stdout[-300:]}
        out["_rc"] = r.returncode
        return out

    def client(self, step, background=False):
        args = [CLIENT, "-app", f"http://127.0.0.1:{self.pb}", "-admin", f"http://127.0.0.1:{self.pa}/api", "-admin-pw",
                os.path.join(self.sec, "admin-password"), "-state", self.client_state, step]
        if background:
            return subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        r = subprocess.run(args, capture_output=True, text=True, timeout=180)
        if r.returncode:
            raise RuntimeError(f"client {step}: {r.stderr.strip()[-300:]}")
        return json.loads(r.stdout)

    def start(self):
        """R2's opposite: guard present; the controller starts indexd; ready = the admin API answers"""
        os.makedirs(os.path.dirname(GUARD), exist_ok=True)
        open(GUARD, "w").close()
        out = self.ctl("start")
        assert out.get("started"), out
        pid = int(open(os.path.join(self.state, "indexd.pid")).read())
        with LOCK:
            TRACK.update(pid=pid, exit=None, exitAt=None)
            UNIT.update(ActiveState="active", SubState="running", MainPID=str(pid), Result="success", ExecMainCode="0", ExecMainStatus="0",
                        InvocationID=secrets.token_hex(16))
            write_unit()
        auth = "Basic " + base64.b64encode((":" + self.adminpw).encode()).decode()
        t0 = time.time()
        while time.time() - t0 < 180:
            if TRACK["pid"] is None:
                raise RuntimeError("indexd exited during start: " + self.tail())
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{self.pa}/api/state", headers={"Authorization": auth})
                with urllib.request.urlopen(req, timeout=5) as r:
                    if r.status == 200:
                        log(self.name, "indexd ready after", round(time.time() - t0, 1), "s, pid", pid)
                        return pid
            except Exception:
                pass
            time.sleep(0.5)
        raise RuntimeError("indexd not ready: " + self.tail())

    def tail(self):
        try:
            return " | ".join(l[:200] for l in open(os.path.join(self.state, "indexd.out")).read().splitlines()[-3:])
        except OSError:
            return ""

    def log_has(self, text):
        try:
            return text in open(os.path.join(self.state, "indexd.out")).read()
        except OSError:
            return False

    def wipe(self):
        shutil.rmtree(self.sec, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)
        shutil.rmtree(os.path.join(self.dir, "releases"), ignore_errors=True)


def settled(secs=15):
    """wait until the reaper has recorded the tracked indexd's exit (fixture synchronisation only)"""
    t0 = time.time()
    while TRACK["pid"] is not None and time.time() - t0 < secs:
        time.sleep(0.02)
    return TRACK["pid"] is None


def guard_aside():
    """R2: the unit's start guard moved aside"""
    os.replace(GUARD, GUARD + ".held-" + run_id)


def counts(pg):
    return pg.q("SELECT count(*) FILTER (WHERE fence IS NOT NULL) || '/' || count(*) FILTER (WHERE cas_mode) || '/' || count(*) FROM accounts")


STALL = """CREATE FUNCTION dbd_stall() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep({s}); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER dbd_stall AFTER UPDATE ON accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.cas_mode AND NOT OLD.cas_mode) EXECUTE FUNCTION dbd_stall();
"""
PENDING_COMMIT = "SELECT count(*) FROM pg_stat_activity WHERE datname = 'indexd' AND usename = 'indexd' AND wait_event = 'PgSleep' AND query = 'commit'"
INDEXD_BACKENDS = "SELECT count(*) FROM pg_stat_activity WHERE datname = 'indexd' AND usename = 'indexd'"


def decide(text, attest=True):
    return cutover.rollback_decision(text, attest)


def main():
    preconditions()
    pg = PG()
    clients, sessions, nodes = [], [], []
    threading.Thread(target=reaper, daemon=True).start()
    write_unit()
    try:
        env = {"PATH": shims(pg) + ":/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC"}
        barrier = fixture_copy(BARRIER, "db-barrier.fixture.sh")
        vmstate = fixture_copy(VMSTATE, "vm-state.v2.fixture.sh")
        check("setup: the fixture copies of db-barrier.sh and vm-state.v2.sh differ from the package files ONLY in the guard path",
              all(R["inputs"][k]["onlyGuardPathChanged"] for k in ("fixtureCopy.db-barrier.fixture.sh", "fixtureCopy.vm-state.v2.fixture.sh")))
        check("setup: PostgreSQL 18.6 with server-wide defaults for every bound the barrier sets per session",
              "PostgreSQL 18.6" in R["postgres"] and "client_connection_check_interval=0" in R["postgresSettings"] and "lock_timeout=0" in R["postgresSettings"]
              and "max_prepared_transactions=0" in R["postgresSettings"], R["postgresSettings"])
        ports = iter(range(19980, 20100))
        port3 = lambda: (next(ports), next(ports), next(ports))

        # ================= N + F: never enrolled, then the failed and interrupted barriers =================
        S = R["scenarios"]["N"] = {}
        n = Node(pg, "N", port3()); nodes.append(n)
        n.start()
        n.client("register")
        S["countsRunning"] = counts(pg)
        check("N: an account registered on the actual indexd; nothing fenced or enrolled", S["countsRunning"] == "0/0/1", S["countsRunning"])
        guard_aside()
        st = n.ctl("stop"); settled()
        S["stop"] = {"controller": st, "exit": TRACK["exit"], "unit": dict(UNIT), "indexdBackendsGoneAfter": pg.wait(INDEXD_BACKENDS, "0", 5)}
        check("N: R2 guard aside, R3 the controller's stop: indexd exited 0, unit inactive/success, its backends closed",
              st.get("stopped") and UNIT["ActiveState"] == "inactive" and UNIT["ExecMainStatus"] == "0" and S["stop"]["indexdBackendsGoneAfter"] is not None, S["stop"])

        idle = pg.session("dbd-idle", "SELECT 1;"); sessions.append(idle)
        pg.wait("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'dbd-idle' AND state = 'idle'", "1", 10)
        idle_pid = pg.pids("application_name = 'dbd-idle'")
        out = run_script(barrier, env, "F1-barrier.txt"); d = decide(out)
        S["F1"] = {"decision": d["decision"], "missing": d.get("missing")}
        check("F1: an idle unrelated session in the database: the barrier completes but the decision is UNKNOWN (db.noOtherSession only)",
              "db.barrier=complete" in out and d["decision"] == "UNKNOWN" and d.get("missing") == ["db.noOtherSession"], d.get("missing"))
        check("F1: that session was NOT ended by the barrier", pg.pids("application_name = 'dbd-idle'") == idle_pid and idle.poll() is None, idle_pid)
        idle.stdin.write("\\q\n"); idle.stdin.flush(); idle.wait(timeout=10)

        holder = pg.session("dbd-holder", "BEGIN; SELECT id FROM accounts FOR UPDATE;"); sessions.append(holder)
        pg.wait("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'dbd-holder' AND state = 'idle in transaction'", "1", 10)
        holder_pid = pg.pids("application_name = 'dbd-holder'")
        t0 = time.time()
        out = run_script(barrier, env, "F2-barrier.txt"); d = decide(out)
        S["F2"] = {"seconds": round(time.time() - t0, 1), "decision": d["decision"], "missing": d.get("missing"), "dbMessage": d.get("seen", {}).get("dbMessage")}
        check("F2: a session holding accounts rows: the barrier's lock times out (bounded, ~30 s) -> UNKNOWN, no counts read",
              "db.lock=granted" not in out and "db.exit=0" not in out and "lock timeout" in out and d["decision"] == "UNKNOWN"
              and "db.lockGranted" in d["missing"] and 25 <= S["F2"]["seconds"] <= 60, S["F2"])
        holder_lock = "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'accounts' AND l.granted AND l.pid = %s"
        check("F2: the holding session is left alone (alive, still holding its lock); no barrier session or lock remains",
              pg.pids("application_name = 'dbd-holder'") == holder_pid and pg.q(holder_lock % holder_pid[0]) != "0"
              and pg.pids("application_name = 'root-barrier'") == [], holder_pid)

        p = subprocess.Popen(["bash", barrier], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
        waited = pg.wait("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'root-barrier' AND wait_event_type = 'Lock'", "1", 20)
        os.killpg(p.pid, signal.SIGKILL)
        partial = p.communicate(timeout=10)[0]
        open(os.path.join(RUN, "F3-barrier-interrupted.txt"), "w").write(partial)
        d = decide(partial)
        gone = pg.wait("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'root-barrier'", "0", 40)
        S["F3"] = {"lockWaitSeenAfter": waited, "decision": d["decision"], "missing": d.get("missing"), "barrierBackendGoneAfterSeconds": gone}
        check("F3: the barrier KILLed while it waits for the lock: its partial output -> UNKNOWN", waited is not None and d["decision"] == "UNKNOWN"
              and "db.barrier=complete" not in partial, S["F3"])
        check("F3: its backend ends by itself, at the latest at its own lock_timeout (30 s); the holder is untouched",
              gone is not None and pg.pids("application_name = 'dbd-holder'") == holder_pid and pg.q(holder_lock % holder_pid[0]) != "0", S["F3"])
        holder.stdin.write("ROLLBACK;\n\\q\n"); holder.stdin.flush(); holder.wait(timeout=10)
        check("F: cleanup - the fixture's own sessions closed by their owner; no lock on accounts remains",
              pg.pids("application_name LIKE 'dbd-%' AND application_name <> 'dbd-fixture'") == []
              and pg.q("SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'accounts'") == "0")

        out = run_script(vmstate, env, "N-vmstate.txt")
        dn, dold = decide(out), OLD["fbaecfce"].rollback_decision(out, True)
        S["vmstate"] = {"new": dn["decision"], "newMissing": dn.get("missing"), "fbaecfce": dold["decision"]}
        check("N: the read-only vm-state.v2.sh alone (process barrier + zero counts): fbaecfce says SAFE, the new decision UNKNOWN (databaseBarrier)",
              dold["decision"] == "LEGACY_REDEPLOY_SAFE" and dn["decision"] == "UNKNOWN" and dn.get("missing") == ["databaseBarrier"], S["vmstate"])
        out = run_script(barrier, env, "N-barrier.txt")
        d0, d1 = decide(out, False), decide(out, True)
        S["barrier"] = {"withoutAttestation": [d0["decision"], d0.get("missing")], "withAttestation": d1["decision"], "seen": d1.get("seen")}
        check("N: db-barrier.sh: lock granted, no other session, no prepared transaction, 0 fenced / 0 CAS; pre/post unchanged",
              all(x in out for x in ("db.lock=granted", "db.otherBackends=0", "db.preparedXacts=0", "db.fencedAccounts=0", "db.casEnrolledAccounts=0",
                                     "db.barrier=complete", "db.exit=0", "pre.allowLiveStart=absent", "post.allowLiveStart=absent")), out[-600:])
        check("N: the legitimate never-enrolled rollback: UNKNOWN without the owner's attestation, LEGACY_REDEPLOY_SAFE with it",
              d0["decision"] == "UNKNOWN" and d0.get("missing") == ["c2ActivationDisabledAttested"] and d1["decision"] == "LEGACY_REDEPLOY_SAFE", S["barrier"])
        n.wipe()

        # ================= B: enrolled BEFORE the stop =================
        S = R["scenarios"]["B"] = {}
        n = Node(pg, "B", port3()); nodes.append(n)
        n.start()
        n.client("register")
        S["raise"] = n.client("raise-cas")
        S["countsRunning"] = counts(pg)
        guard_aside()
        S["stop"] = n.ctl("stop"); settled()
        out_v = run_script(vmstate, env, "B-vmstate.txt")
        out = run_script(barrier, env, "B-barrier.txt")
        d = decide(out)
        S.update(decision=d["decision"], exit=TRACK["exit"], vmstate=[decide(out_v)["decision"], OLD["fbaecfce"].rollback_decision(out_v, True)["decision"]])
        check("B: enrolled while running (raise-cas), then the controller's stop: the barrier -> FORWARD_ONLY (and vm-state alone too)",
              S["countsRunning"] == "1/1/1" and d["decision"] == "FORWARD_ONLY" and S["vmstate"] == ["FORWARD_ONLY", "FORWARD_ONLY"], S)
        n.wipe()

        # ================= D1: the COMMIT completes AFTER an abnormal stop =================
        S = R["scenarios"]["D1"] = {}
        n = Node(pg, "D1", port3()); nodes.append(n)
        n.start()
        n.client("register")
        pg.q("", inp=STALL.format(s=15))
        c = n.client("raise-cas", background=True); clients.append(c)
        S["pendingCommitSeenAfter"] = pg.wait(PENDING_COMMIT, "1", 60)
        check("D1: the actual indexd sent the enrolment's COMMIT (its backend runs the commit: query 'commit', PgSleep in the deferred check)",
              S["pendingCommitSeenAfter"] is not None, S)
        guard_aside()
        st = n.ctl("crash-indexd"); settled()
        killed_at = time.time()
        S["crash"] = {"controller": st, "exit": TRACK["exit"], "unit": dict(UNIT)}
        S["afterKill"] = {"counts": counts(pg), "indexdBackends": pg.q(INDEXD_BACKENDS, "postgres"), "pendingCommit": pg.q(PENDING_COMMIT, "postgres")}
        check("D1: the controller's crash-indexd KILLed it: reaped by SIGKILL, unit failed with no main PID, no indexd process",
              st.get("killed") and UNIT["ActiveState"] == "failed" and UNIT["MainPID"] == "0" and UNIT["ExecMainStatus"] == "9"
              and subprocess.run(["pgrep", "-x", "indexd"], capture_output=True).returncode == 1, S["crash"])
        check("D1: process gone, yet its backend still runs the COMMIT; the account still reads neither fenced nor enrolled (both are "
              "written in that one transaction)", S["afterKill"] == {"counts": "0/0/1", "indexdBackends": "1", "pendingCommit": "1"}, S["afterKill"])
        out_v = run_script(vmstate, env, "D1-vmstate.txt")
        S["vmstateRead"] = {"pendingCommitAfter": pg.q(PENDING_COMMIT, "postgres"), "casEnrolledLine": [l for l in out_v.splitlines() if l.startswith("casEnrolledAccounts=")]}
        d_fba, d_6fd, d_new = OLD["fbaecfce"].rollback_decision(out_v, True), OLD["6fd7a929"].rollback_decision(out_v), decide(out_v)
        S["vmstateDecisions"] = {"fbaecfce": d_fba["decision"], "6fd7a929": d_6fd["decision"], "new": [d_new["decision"], d_new.get("missing")]}
        check("D1 NEGATIVE CONTROL: on the actual vm-state.v2.sh output (unit failed, MainPID 0, guard absent, 0 CAS) the fbaecfce decision "
              "says LEGACY_REDEPLOY_SAFE while the COMMIT is still pending",
              "casEnrolledAccounts=0" in out_v and "unit.ActiveState=failed" in out_v and d_fba["decision"] == "LEGACY_REDEPLOY_SAFE"
              and S["vmstateRead"]["pendingCommitAfter"] == "1", S["vmstateDecisions"])
        check("D1: the new decision on that vm-state output is UNKNOWN (databaseBarrier)", d_new["decision"] == "UNKNOWN" and d_new.get("missing") == ["databaseBarrier"])
        t0 = time.time()
        out = run_script(barrier, env, "D1-barrier.txt")
        d = decide(out)
        kv = cutover.parse_kv(out)
        S["barrier"] = {"seconds": round(time.time() - t0, 1), "lockWaitMs": kv.get("db.lockWaitMs"), "decision": d["decision"],
                        "otherBackends": kv.get("db.otherBackendsDetail"), "stopKind": cutover.stop_kind(kv), "secondsAfterKill": round(t0 - killed_at, 1)}
        check("D1: db-barrier.sh started while the COMMIT was pending, WAITED for it (lock), and read CAS=1 -> FORWARD_ONLY",
              d["decision"] == "FORWARD_ONLY" and kv.get("db.casEnrolledAccounts") == "1" and int(kv.get("db.lockWaitMs", "0")) >= 1000
              and kv.get("db.lock") == "granted", S["barrier"])
        S["final"] = {"counts": counts(pg), "indexdBackendsGoneAfter": pg.wait(INDEXD_BACKENDS, "0", 30)}
        S["client"] = {"rc": c.wait(timeout=60)}
        check("D1: the enrolment committed after the process was gone (1/1/1); the dead client's backend then ended by itself",
              S["final"]["counts"] == "1/1/1" and S["final"]["indexdBackendsGoneAfter"] is not None, S["final"])
        n.wipe()

        # ================= D2: the graceful stop during the same pending COMMIT =================
        S = R["scenarios"]["D2"] = {}
        n = Node(pg, "D2", port3()); nodes.append(n)
        n.start()
        n.client("register")
        pg.q("", inp=STALL.format(s=8))
        c = n.client("raise-cas", background=True); clients.append(c)
        S["pendingCommitSeenAfter"] = pg.wait(PENDING_COMMIT, "1", 60)
        guard_aside()
        t0 = time.time()
        st = n.ctl("stop"); settled()
        S["stop"] = {"controller": st, "seconds": round(time.time() - t0, 1), "exit": TRACK["exit"], "unit": dict(UNIT),
                     "countsAtExit": counts(pg), "pendingCommitAtExit": pg.q(PENDING_COMMIT, "postgres"),
                     "indexdBackendsGoneAfter": pg.wait(INDEXD_BACKENDS, "0", 5)}
        S["client"] = {"rc": c.wait(timeout=60), "out": c.stdout.read()[-300:]}
        check("D2: the controller's stop (one SIGTERM) waited for the in-flight enrolment: exit 0 only AFTER its COMMIT; no backend left",
              S["pendingCommitSeenAfter"] is not None and st.get("stopped") and UNIT["ExecMainStatus"] == "0" and UNIT["ActiveState"] == "inactive"
              and S["stop"]["countsAtExit"] == "1/1/1" and S["stop"]["pendingCommitAtExit"] == "0" and S["stop"]["indexdBackendsGoneAfter"] is not None,
              S["stop"])
        check("D2: the client got its answer (the handler completed during Shutdown)", S["client"]["rc"] == 0, S["client"])
        out = run_script(barrier, env, "D2-barrier.txt"); d = decide(out); kv = cutover.parse_kv(out)
        S["barrier"] = {"decision": d["decision"], "lockWaitMs": kv.get("db.lockWaitMs"), "stopKind": cutover.stop_kind(kv)}
        check("D2: the barrier -> FORWARD_ONLY without waiting (the graceful path had already drained); stopKind exited-0 is reported, not used",
              d["decision"] == "FORWARD_ONLY" and S["barrier"]["stopKind"] == "exited-0" and int(kv.get("db.lockWaitMs", "99999")) < 1000, S["barrier"])
        n.wipe()

        # ================= D3: two SIGTERMs during the pending COMMIT =================
        S = R["scenarios"]["D3"] = {}
        n = Node(pg, "D3", port3()); nodes.append(n)
        pid = n.start()
        n.client("register")
        pg.q("", inp=STALL.format(s=8))
        c = n.client("raise-cas", background=True); clients.append(c)
        S["pendingCommitSeenAfter"] = pg.wait(PENDING_COMMIT, "1", 60)
        guard_aside()
        t0 = time.time()
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)   # FIXTURE pacing between the operator's two signals (not evidence)
        if TRACK["pid"] is not None:
            os.kill(pid, signal.SIGTERM)
        while TRACK["pid"] is not None and time.time() - t0 < 120:
            time.sleep(0.02)
        S["exit"] = {"seconds": round(time.time() - t0, 1), "exit": TRACK["exit"], "unit": dict(UNIT), "countsAtExit": counts(pg),
                     "pendingCommitAtExit": pg.q(PENDING_COMMIT, "postgres"), "interruptedLogged": n.log_has("graceful shutdown was interrupted")}
        S["exitedBeforeCommit"] = S["exit"]["countsAtExit"] != "1/1/1"
        S["client"] = {"rc": c.wait(timeout=60)}
        log("D3 observed:", S["exit"])
        check("D3: two SIGTERMs: indexd logged the interrupted graceful shutdown and exited (observation recorded: exitedBeforeCommit = "
              f"{S['exitedBeforeCommit']})", S["exit"]["interruptedLogged"] and TRACK["pid"] is None, S["exit"])
        out = run_script(barrier, env, "D3-barrier.txt"); d = decide(out); kv = cutover.parse_kv(out)
        S["barrier"] = {"decision": d["decision"], "lockWaitMs": kv.get("db.lockWaitMs"), "stopKind": cutover.stop_kind(kv)}
        check("D3: the barrier -> FORWARD_ONLY whatever the process did", d["decision"] == "FORWARD_ONLY" and kv.get("db.casEnrolledAccounts") == "1", S["barrier"])
        n.wipe()
    finally:
        for c in clients:
            if c.poll() is None:
                c.kill(); c.wait(timeout=10)
        for s in sessions:
            if s.poll() is None:
                s.kill(); s.wait(timeout=10)
        pid = TRACK["pid"]
        if pid is not None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            t0 = time.time()
            while TRACK["pid"] is not None and time.time() - t0 < 10:
                time.sleep(0.05)
        for n in nodes:
            n.wipe()
        pg.close()
        R["cleanup"] = {"postgresExited": pg.p is None or pg.p.poll() is not None,
                        "noIndexd": subprocess.run(["pgrep", "-x", "indexd"], capture_output=True).returncode == 1,
                        "pgDataRemoved": not os.path.exists(os.path.join(RUN, "pg")), "socketDirRemoved": not os.path.exists(pg.sock),
                        "secretsRemoved": all(not os.path.exists(n.sec) for n in nodes)}
        R["finished"] = time.time()
        failed = [c["name"] for c in R["checks"] if not c["ok"]]
        R["summary"] = {"checks": len(R["checks"]), "failed": failed, "cleanupOk": all(R["cleanup"].values())}
        save()
        log("SUMMARY", json.dumps(R["summary"]))
    sys.exit(0 if not R["summary"]["failed"] and R["summary"]["cleanupOk"] else 1)


if __name__ == "__main__":
    main()
