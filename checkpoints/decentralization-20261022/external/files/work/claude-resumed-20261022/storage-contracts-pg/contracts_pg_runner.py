#!/usr/bin/env python3
"""storage-contracts-pg: ONE bounded local runner for the database-backed indexd contracts tests.

PostgreSQL 18.6 (pinned image 74935e72, --pull never) and `go test ./contracts/... ./cmd/...` run in ONE fresh disposable
container:
  - --network none and no published ports, so the fixtures' :0 listeners are unreachable from outside;
  - 1024 MiB memory with no swap, 2 CPUs (cpuset 0-1), a pids limit, a read-only rootfs and no-new-privileges.
The Go process is a `docker exec` inside that same network namespace, as the invoking host uid. Mounts:
  - read-only: the Go toolchain (statically linked), the module cache and the two accepted snapshots;
  - writable: only a fresh mkdtemp scratch directory (GOCACHE, GOPATH, HOME, TMPDIR);
  - PostgreSQL data: the image's own anonymous volume, tied to the container.
Credentials are generated fresh, written to a 0600 file in scratch, passed with --env-file, and never printed or logged.

Modes:
  contracts_pg_runner.py --config config.json --dry-run          print the planned docker argv; no docker call, no files
  contracts_pg_runner.py --config config.json --check            host-side preflight only (inventories, toolchain hash,
                                                                 `docker image inspect`); no files, no container
  contracts_pg_runner.py --config config.json --run              the real run (root, through the shared queue)
  contracts_pg_runner.py --config config.json --cleanup JOURNAL  cross-process cleanup of a previous run, from its journal

Ownership and cleanup rules (no intent-only deletion):
  - A container counts as OURS only if it is the exact full ID returned by `docker run`, or the single container found
    after a lost/failed create response that carries this run's fresh random run label, the exact run name and the
    pinned image. Nothing is ever removed by name alone; unrelated containers and volumes are never touched.
  - Before removal, the container (also one adopted by run label) is inspected and its anonymous volumes are recorded.
  - Removal is `docker rm -f -v <full id>` (the container cgroup holds the whole workload). It is then confirmed:
    - inspect explicitly answers "No such object/container";
    - the run-label query is empty;
    - every recorded anonymous volume explicitly answers "no such volume". A remaining one is removed by its exact name
      only.
    Any other docker failure (connection, permission, daemon) is NOT proof of absence: cleanup stays unconfirmed.
  - Suite scheduling stops at the first uncertain `docker exec` termination, and the remaining suites are NOT_RUN.
    Certain ends are go test rc 0/1/2 and 124 (the in-container timeout killed the process group). Uncertain ends are a
    parent-side timeout, an OSError, a signal-killed client, or rc 125/126/127/137. The runner then goes straight to
    removing the whole container, because a daemon-side Go process may still exist.
  - The scratch directory is deleted only after that confirmation, and only if its lstat still matches the identity
    recorded at mkdtemp: path, device, inode, owner uid, a real directory and not a symlink.
  - If docker cannot be queried or anything is unconfirmed, NOTHING further is deleted; the journal keeps the state.
Exit: 0 both suites `go test` rc 0 + cleanup confirmed | 1 suite failure(s), cleanup confirmed | 2 refused before any
docker change | 3 cleanup unconfirmed (state preserved, see journal) | 4 run error before the suites (cleanup confirmed).
A classifier result never turns a non-zero `go test` return code into a pass."""
import argparse, hashlib, json, os, re, secrets, shutil, signal, stat, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABEL_KIND, LABEL_RUN = "enclave.test", "enclave.test.run"
KIND = "storage-contracts-pg"


CERTAIN_EXEC_RC = {0, 1, 2, 124}     # go test pass/fail/build-or-usage; 124 = in-container timeout killed the group
GONE_CONTAINER = re.compile(r"no such (object|container)", re.I)
GONE_VOLUME = re.compile(r"no such volume", re.I)


class Refused(Exception): pass
class RunError(Exception): pass


def now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def tree_inventory(root):
    """{'./rel': sha256} of every regular file; refuses symlinks and other non-regular entries"""
    inv = {}
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(d, n); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode): raise Refused(f"symlink in snapshot: {p}")
            if n in files:
                if not stat.S_ISREG(st.st_mode): raise Refused(f"non-regular file in snapshot: {p}")
                inv["./" + os.path.relpath(p, root)] = sha256_file(p)
    return inv


def expected_inventory(suite):
    """the accepted snapshot = the pinned assembled tree's inventory with the accepted form_test.go"""
    base = Path(suite["pinnedInventory"])
    if sha256_file(base) != suite["pinnedInventorySha256"]: raise Refused(f"pinned inventory {base} hash differs")
    inv = {}
    for line in base.read_text().splitlines():
        h, p = line.split("  ", 1); inv[p] = h
    for p, h in suite["overrides"].items():
        if p not in inv: raise Refused(f"override for unknown file {p}")
        inv[p] = h
    return inv


class Runner:
    def __init__(self, cfg, journal_path=None):
        self.cfg = cfg; self.docker = cfg["docker"]
        self.uid, self.gid = os.getuid(), os.getgid()
        self.journal_path = journal_path; self.j = {}
        self.cid = None; self.volumes = []
        self.create_attempted = False   # the run-label lookup is only meaningful after OUR create was attempted
        self.volumes_known = False      # True once OUR container's inspect has been read
        self.cleanup_done = False

    # ---- journal (evidence; never deleted by the runner) ----
    def jset(self, **kw):
        self.j.update(kw); self.j["updatedAt"] = now()
        tmp = self.journal_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.j, indent=1) + "\n"); os.replace(tmp, self.journal_path)

    # ---- docker CLI, bounded ----
    def dk(self, args, timeout=60, check=True, stdin=None):
        try:
            r = subprocess.run([self.docker] + args, capture_output=True, text=True, timeout=timeout, stdin=stdin)
        except subprocess.TimeoutExpired:
            raise RunError(f"docker {args[0]} timed out after {timeout}s")
        except OSError as e:
            raise RunError(f"docker not runnable: {e}")
        if check and r.returncode != 0:
            raise RunError(f"docker {' '.join(args[:2])} rc={r.returncode}: {r.stderr.strip()[-300:]}")
        return r

    # ---- strict presence: only an explicit "no such ..." answer proves absence ----
    def container_state(self, cid):
        r = self.dk(["inspect", cid], check=False)
        if r.returncode == 0: return "present", json.loads(r.stdout)[0]
        if GONE_CONTAINER.search(r.stderr + r.stdout) and "connect" not in (r.stderr + r.stdout).lower(): return "absent", None
        raise RunError(f"container {cid[:12]} state unknown: rc={r.returncode} {r.stderr.strip()[-200:]}")

    def volume_state(self, v):
        r = self.dk(["volume", "inspect", v], check=False)
        if r.returncode == 0: return "present"
        if GONE_VOLUME.search(r.stderr + r.stdout) and "connect" not in (r.stderr + r.stdout).lower(): return "absent"
        raise RunError(f"volume {v[:12]} state unknown: rc={r.returncode} {r.stderr.strip()[-200:]}")

    def record_volumes(self, info):
        vols = [m["Name"] for m in info.get("Mounts", []) if m.get("Type") == "volume"]
        self.volumes = sorted(set(self.volumes) | set(vols)); self.volumes_known = True
        self.jset(ownedVolumes=self.volumes, containerId=self.cid)

    # ---- planning ----
    def plan(self, run_id, scratch, envfile):
        c, lim = self.cfg, self.cfg["limits"]
        name = f"{c['namePrefix']}-{run_id}"
        mounts = [f"type=bind,src={c['goroot']},dst={c['goroot']},readonly", f"type=bind,src={c['gomodcache']},dst=/gomodcache,readonly"]
        mounts += [f"type=bind,src={s['snapshot']},dst=/src/{s['name']},readonly" for s in c["suites"]]
        mounts += [f"type=bind,src={scratch}/work,dst=/scratch"]
        argv = ["run", "-d", "--pull", "never", "--name", name, "--label", f"{LABEL_KIND}={KIND}", "--label", f"{LABEL_RUN}={run_id}",
                "--network", "none", "--memory", lim["memory"], "--memory-swap", lim["memory"], "--cpus", str(lim["cpus"]),
                "--cpuset-cpus", lim["cpuset"], "--pids-limit", str(lim["pids"]), "--read-only",
                "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m", "--security-opt", "no-new-privileges",
                "--env-file", str(envfile)]
        for m in mounts: argv += ["--mount", m]
        argv += [c["imageId"], "postgres"]
        return name, argv

    def suite_exec(self, suite, envfile, run_id):
        c = self.cfg; t = c["timeouts"]
        env = {"GOCACHE": f"/scratch/gocache-{suite['name']}", "GOPATH": "/scratch/gopath", "GOMODCACHE": "/gomodcache", "HOME": "/scratch/home",
               "TMPDIR": "/scratch/tmp", "GOFLAGS": "-mod=readonly", "GOPROXY": "off", "GOSUMDB": "off", "GOTOOLCHAIN": "local", "GOENV": "off",
               "CGO_ENABLED": "0", "GOMAXPROCS": "2", "GOMEMLIMIT": c["limits"]["goMemLimit"], "POSTGRES_PORT": "5432",
               "POSTGRES_DB_PREFIX": f"{suite['dbPrefix']}_{run_id[:6]}_", "PATH": f"{c['goroot']}/bin:/usr/local/bin:/usr/bin:/bin"}
        argv = ["exec", "--user", f"{self.uid}:{self.gid}", "--workdir", f"/src/{suite['name']}", "--env-file", str(envfile)]
        for k, v in env.items(): argv += ["-e", f"{k}={v}"]
        argv += [self.cid or "<container-id>", "timeout", "-k", "10", str(t["goTestInner"]), f"{c['goroot']}/bin/go", "test", "-p", "1", "-count=1", "-json",
                 f"-timeout={t['goTestFlag']}"] + c["packages"]
        return argv

    # ---- preflight (no docker change) ----
    def preflight(self):
        c = self.cfg; res = {}
        for s in c["suites"]:
            got = tree_inventory(s["snapshot"]); want = expected_inventory(s)
            if got != want:
                diff = sorted(set(got.items()) ^ set(want.items()))[:6]
                raise Refused(f"snapshot {s['name']} inventory differs from the accepted one: {diff}")
            res[s["name"]] = {"files": len(got), "inventorySha256": hashlib.sha256(json.dumps(got, sort_keys=True).encode()).hexdigest()}
        for p in (c["goroot"] + "/bin/go", c["gomodcache"]):
            if not os.path.exists(p): raise Refused(f"missing {p}")
        if sha256_file(c["goroot"] + "/bin/go") != c["goBinarySha256"]: raise Refused("go binary hash differs from the pin")
        r = self.dk(["image", "inspect", "--format", "{{.Id}}", c["imageId"]], check=False)
        if r.returncode != 0 or r.stdout.strip() != c["imageId"]: raise Refused(f"pinned image {c['imageId']} not present locally (no pull)")
        return res

    # ---- ownership lookup after a lost/failed create response ----
    def owned_by_label(self, run_id, name):
        r = self.dk(["ps", "-a", "--no-trunc", "--filter", f"label={LABEL_RUN}={run_id}", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"])
        rows = [l.split("\t") for l in r.stdout.splitlines() if l.strip()]
        mine = [x for x in rows if len(x) == 3 and x[1] == name and x[2] in (self.cfg["imageId"], self.cfg["imageId"].split(":", 1)[-1])]
        if len(rows) != len(mine) or len(mine) > 1:
            raise RunError(f"run label {run_id} matches unexpected containers {rows}: not touching them")
        return mine[0][0] if mine else None

    def verify_container(self, run_id, name):
        i = json.loads(self.dk(["inspect", self.cid]).stdout)[0]
        hc, cfg = i["HostConfig"], i["Config"]; lim = self.cfg["limits"]
        problems = []
        if i["Id"] != self.cid: problems.append("id")
        if i["Name"] != "/" + name: problems.append("name")
        if (cfg.get("Labels") or {}).get(LABEL_RUN) != run_id: problems.append("run label")
        if i["Image"] != self.cfg["imageId"]: problems.append("image")
        if hc.get("NetworkMode") != "none": problems.append("network")
        if hc.get("PortBindings"): problems.append("port bindings")
        if hc.get("Memory") != lim["memoryBytes"] or hc.get("MemorySwap") != lim["memoryBytes"]: problems.append("memory/swap")
        if hc.get("NanoCpus") != int(lim["cpus"] * 1e9) or hc.get("CpusetCpus") != lim["cpuset"]: problems.append("cpus")
        if not hc.get("ReadonlyRootfs"): problems.append("read-only rootfs")
        rw_binds = [m["Destination"] for m in i.get("Mounts", []) if m.get("Type") == "bind" and m.get("RW")]
        if rw_binds != ["/scratch"]: problems.append(f"writable binds {rw_binds}")
        self.record_volumes(i)
        if [m["Destination"] for m in i.get("Mounts", []) if m.get("Type") == "volume"] != ["/var/lib/postgresql"]: problems.append("volumes")
        self.jset(stage="created", containerId=self.cid, ownedVolumes=self.volumes, isolationProblems=problems)
        if problems: raise RunError(f"container isolation not as planned: {problems}")

    def wait_ready(self):
        deadline = time.monotonic() + self.cfg["timeouts"]["ready"]
        while time.monotonic() < deadline:
            st = self.dk(["inspect", "--format", "{{.State.Running}}", self.cid]).stdout.strip()
            if st != "true": raise RunError("PostgreSQL container stopped during start-up")
            if self.dk(["exec", self.cid, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432"], timeout=20, check=False).returncode == 0: return
            time.sleep(1)
        raise RunError("PostgreSQL not ready on 127.0.0.1:5432 inside the container")

    def toolchain_check(self, envfile):
        c = self.cfg
        r = self.dk(["exec", "--user", f"{self.uid}:{self.gid}", "-e", "GOTOOLCHAIN=local", "-e", "GOENV=off", "-e", "HOME=/scratch/home", "-e", "GOMODCACHE=/gomodcache",
                     "-e", "GOCACHE=/scratch/gocache-check", self.cid, f"{c['goroot']}/bin/go", "version"], timeout=60, check=False)
        got = r.stdout.strip()
        self.jset(containerGoVersion=got)
        if r.returncode != 0 or got != c["goVersion"]: raise RunError(f"Go toolchain not usable in the container: rc={r.returncode} {got!r} {r.stderr.strip()[-200:]}")

    # ---- cleanup ----
    def cleanup(self, run_id, name, scratch_id):
        """returns (confirmed: bool, details)"""
        d = {"containerRemoved": None, "labelQueryEmpty": None, "volumesGone": None, "scratchRemoved": None}
        try:
            if self.cid is None and self.create_attempted:
                self.cid = self.owned_by_label(run_id, name)          # lost/failed create response, or a second process
                d["containerFoundByRunLabel"] = self.cid
            elif self.cid is None:
                d["containerLookup"] = "skipped: no create was attempted by this run (a pre-existing name/label holder is never touched)"
            if self.cid:
                state, info = self.container_state(self.cid)
                if state == "present": self.record_volumes(info)       # capture its anonymous volumes BEFORE removal
                if state == "present":
                    self.dk(["rm", "-f", "-v", self.cid], timeout=120, check=False)
                    state, _ = self.container_state(self.cid)
                d["containerRemoved"] = state == "absent"
                if not self.volumes_known:
                    d["volumesUnknown"] = "the container's volumes were never recorded (it vanished before inspect): cannot confirm them"
            else:
                d["containerRemoved"] = True; self.volumes_known = True  # confirmed: this run created no container
            d["labelQueryEmpty"] = (self.dk(["ps", "-a", "-q", "--filter", f"label={LABEL_RUN}={run_id}"]).stdout.strip() == "") if self.create_attempted else True
            left = []
            for v in self.volumes:
                if self.volume_state(v) == "present":
                    self.dk(["volume", "rm", v], check=False)
                    if self.volume_state(v) == "present": left.append(v)
            d["volumesGone"] = (not left) and self.volumes_known; d["volumesLeft"] = left
        except RunError as e:
            d["dockerError"] = str(e)
        confirmed = d["containerRemoved"] is True and d["labelQueryEmpty"] is True and d["volumesGone"] is True
        if confirmed and scratch_id:
            d["scratchRemoved"], d["scratchDetail"] = remove_scratch(scratch_id, self.uid)
        elif scratch_id:
            d["scratchRemoved"], d["scratchDetail"] = False, "kept: container/volume removal not confirmed"
        else:
            d["scratchRemoved"] = True
        ok = confirmed and d["scratchRemoved"] is True
        self.jset(stage="cleaned" if ok else "cleanup-unconfirmed", cleanup=d)
        self.cleanup_done = True
        return ok, d


def make_scratch(base):
    p = tempfile.mkdtemp(prefix="scratch-", dir=base)
    st = os.lstat(p)
    return {"path": p, "dev": st.st_dev, "ino": st.st_ino, "uid": st.st_uid}


def remove_scratch(sid, uid):
    try:
        st = os.lstat(sid["path"])
    except FileNotFoundError:
        return False, "scratch path missing: not removing anything"
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode): return False, "scratch path is no longer a real directory: refused"
    if (st.st_dev, st.st_ino, st.st_uid) != (sid["dev"], sid["ino"], sid["uid"]) or st.st_uid != uid:
        return False, "scratch identity (device/inode/owner) differs from mkdtemp: refused"
    errors = []
    shutil.rmtree(sid["path"], onerror=lambda f, p, e: errors.append(f"{p}: {e[1]}"))
    if errors or os.path.lexists(sid["path"]): return False, f"rmtree incomplete: {errors[:3]}"
    return True, "removed"


def classify(json_path):
    """per-suite detail for the report; never changes the verdict"""
    res, out, pkg = {}, {}, {}
    for line in Path(json_path).read_text(errors="replace").splitlines():
        if not line.startswith("{"): continue
        try: e = json.loads(line)
        except ValueError: continue
        k = (e.get("Package"), e.get("Test"))
        if e.get("Action") == "output": out.setdefault(k, []).append(e.get("Output", ""))
        elif e.get("Action") in ("pass", "fail", "skip"): (res if e.get("Test") else pkg)[k] = e["Action"]
    top = {k: v for k, v in res.items() if "/" not in k[1]}
    classes = {}
    for k, v in top.items():
        if v != "fail": continue
        text = "".join(out.get(k, [])) + "".join(x for kk, xs in out.items() if kk[0] == k[0] and kk[1] and kk[1].startswith(k[1] + "/") for x in xs)
        cls = ("POSTGRES" if re.search(r"5432|failed to connect|SQLSTATE|password authentication", text) else
               "TIMEOUT" if "test timed out" in text else "TEST")
        classes.setdefault(cls, []).append(k[1])
    build = [p for (p, _), v in pkg.items() if v == "fail" and not any(kk[0] == p and vv == "fail" for kk, vv in top.items())]
    if build: classes["PACKAGE_OR_BUILD"] = build
    count = lambda a: sum(1 for v in top.values() if v == a)
    return {"pass": count("pass"), "fail": count("fail"), "skip": count("skip"), "packages": {p: v for (p, _), v in pkg.items()}, "failureClasses": classes}


def run(cfg, base):
    run_id = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + secrets.token_hex(6)
    runs = base / "runs"; runs.mkdir(exist_ok=True)
    results = runs / f"{run_id}-results"; results.mkdir()
    R = Runner(cfg, runs / f"{run_id}.journal.json")
    name = f"{cfg['namePrefix']}-{run_id}"
    R.jset(runId=run_id, name=name, stage="preflight", startedAt=now(), pid=os.getpid(), resultsDir=str(results))
    summary = {"runId": run_id, "suites": {}, "cleanup": None}
    scratch_id = None; code = 0

    def on_signal(signum, frame): raise RunError(f"interrupted by signal {signum}")
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, on_signal)
    try:
        summary["preflight"] = R.preflight()
        scratch_id = make_scratch(runs)
        R.jset(stage="scratch-created", scratch=scratch_id)
        for sub in ("work", "work/home", "work/gopath", "work/tmp", "secrets"):
            os.mkdir(os.path.join(scratch_id["path"], sub), 0o700)
        envfile = Path(scratch_id["path"]) / "secrets" / "pg.env"
        fd = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"POSTGRES_USER=pgt_{secrets.token_hex(4)}\nPOSTGRES_PASSWORD={secrets.token_urlsafe(32)}\nPOSTGRES_DB=pgt_{run_id[-12:]}\n")
        _, argv = R.plan(run_id, scratch_id["path"], envfile)
        # collision guard: nothing may already carry this name or run label (fresh random id; refuse rather than touch)
        clash = R.dk(["ps", "-a", "--no-trunc", "--filter", f"name=^/{name}$", "--format", "{{.ID}}"]).stdout.strip() + \
                R.dk(["ps", "-a", "--no-trunc", "--filter", f"label={LABEL_RUN}={run_id}", "--format", "{{.ID}}"]).stdout.strip()
        if clash: raise Refused(f"name/run label already in use by {clash}: not touching it")
        R.create_attempted = True
        R.jset(stage="create-intent", createAttempted=True)
        try:
            r = R.dk(argv, timeout=cfg["timeouts"]["create"], check=False)
            cid = r.stdout.strip().splitlines()[-1] if r.returncode == 0 and r.stdout.strip() else ""
            if re.fullmatch(r"[0-9a-f]{64}", cid): R.cid = cid
            else: R.jset(createResponse=f"rc={r.returncode} {r.stderr.strip()[-200:]}")
        except RunError as e:
            R.jset(createResponse=str(e))
        if R.cid is None:
            R.cid = R.owned_by_label(run_id, name)                    # lost response: adopt only the run-labelled container
            R.jset(containerAdoptedByRunLabel=R.cid)
            if R.cid is None: raise RunError("container was not created")
        R.verify_container(run_id, name)
        R.wait_ready(); R.jset(stage="ready")
        R.toolchain_check(envfile); R.jset(stage="toolchain-ok")
        stop = None
        for s in cfg["suites"]:
            if stop:
                summary["suites"][s["name"]] = {"verdict": "NOT_RUN", "reason": stop}; R.jset(**{f"suite_{s['name']}": summary["suites"][s["name"]]}); code = 1; continue
            R.jset(stage=f"suite-{s['name']}")
            t0 = time.monotonic()
            out = results / f"{s['name']}.json"; err = results / f"{s['name']}.stderr"
            with open(out, "w") as fo, open(err, "w") as fe:
                try:
                    p = subprocess.run([R.docker] + R.suite_exec(s, envfile, run_id), stdout=fo, stderr=fe, timeout=cfg["timeouts"]["goTestOuter"])
                    rc = p.returncode
                except subprocess.TimeoutExpired:
                    rc = "outer-timeout"
                except OSError as e:
                    rc = f"exec-error: {e}"
            if rc not in CERTAIN_EXEC_RC:
                stop = f"previous suite {s['name']} ended uncertainly ({rc}): a daemon-side Go process may still exist; going straight to container removal"
            post = tree_inventory(s["snapshot"]) == expected_inventory(s)
            detail = classify(out)
            verdict = "PASS" if rc == 0 and detail["fail"] == 0 and post else "FAIL"
            summary["suites"][s["name"]] = {"goTestReturnCode": rc, "seconds": round(time.monotonic() - t0), "verdict": verdict, "snapshotUnchanged": post, **detail}
            R.jset(**{f"suite_{s['name']}": summary["suites"][s["name"]]})
            if verdict != "PASS": code = 1
    except Refused as e:
        summary["refused"] = str(e); code = 2; R.jset(refused=str(e))
    except RunError as e:
        summary["error"] = str(e); code = 4 if not summary["suites"] else 1
    finally:
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, signal.SIG_IGN)   # cleanup is not interruptible
        ok, d = R.cleanup(run_id, name, scratch_id)
        summary["cleanup"] = {"confirmed": ok, **d}
        if not ok: code = 3
        (results / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
        print(json.dumps(summary, indent=1))
    return code


def cleanup_from_journal(cfg, journal):
    j = json.loads(Path(journal).read_text())
    R = Runner(cfg, Path(journal)); R.j = j
    R.cid = j.get("containerId"); R.volumes = j.get("ownedVolumes", []); R.volumes_known = "ownedVolumes" in j
    R.create_attempted = bool(j.get("createAttempted"))
    if j.get("stage") == "cleaned": print(json.dumps({"alreadyCleaned": True})); return 0
    try:                                    # the journal's own runner must not be running (one pid check; no process scan)
        cmd = Path(f"/proc/{j['pid']}/cmdline").read_bytes().split(b"\0")
        if any(b"contracts_pg_runner.py" in c for c in cmd) and b"--run" in cmd:
            print(json.dumps({"refused": f"runner pid {j['pid']} is still running; it cleans up itself"})); return 2
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
    ok, d = R.cleanup(j["runId"], j["name"], j.get("scratch"))
    print(json.dumps({"confirmed": ok, **d}, indent=1)); return 0 if ok else 3


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--config", required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true"); g.add_argument("--check", action="store_true"); g.add_argument("--run", action="store_true"); g.add_argument("--cleanup", metavar="JOURNAL")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text()); base = Path(a.config).resolve().parent
    if a.dry_run:
        R = Runner(cfg); rid = "<run-id>"; R.cid = "<container-id>"
        _, argv = R.plan(rid, "<scratch>", "<scratch>/secrets/pg.env")
        print(json.dumps({"create": [cfg["docker"]] + argv, "suites": {s["name"]: [cfg["docker"]] + R.suite_exec(s, "<scratch>/secrets/pg.env", "000000000000") for s in cfg["suites"]},
                          "cleanup": [[cfg["docker"], "rm", "-f", "-v", "<container-id>"], [cfg["docker"], "volume", "rm", "<owned anonymous volume, only if still present>"]]}, indent=1))
        return 0
    if a.check:
        try: print(json.dumps({"preflight": Runner(cfg).preflight()}, indent=1)); return 0
        except (Refused, RunError) as e: print(json.dumps({"refused": str(e)})); return 2
    if a.cleanup: return cleanup_from_journal(cfg, a.cleanup)
    return run(cfg, base)


if __name__ == "__main__":
    sys.exit(main())
