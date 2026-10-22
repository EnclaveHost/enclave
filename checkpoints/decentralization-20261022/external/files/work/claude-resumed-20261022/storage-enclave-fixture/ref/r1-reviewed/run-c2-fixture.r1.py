#!/usr/bin/env python3
"""ROOT ONLY. The existing G-C2 eight-stage fixture against the NEW reproducible binaries (storage-enclave-build):
fence-enclave c67ffa4d... (v27) and c2-enclave 2c0e5b06... (v28), with the database seeded at v27 through the
MATCHING fence-enclave source tree (inventory d306f997, the tree c67ffa4d was built from). Replaces run-c2-fixture.sh;
fixture/c2fx.py holds the ownership/cleanup rules.

  run-c2-fixture.py --plan                       NO side effects: verifies every pin, prints the manifest
  run-c2-fixture.py --execute <manifest>         one run, inside ONE shared-queue allocation (see README: 768 MiB + 256 MiB docker)
  run-c2-fixture.py --recover <run id>           identity-checked cleanup of an interrupted run from its journal

Steps:
1. pins;
2. the exclusive journal and stage runs/<id>/, refusing any pre-existing name;
3. generated disposable secrets (0600, never printed);
4. a labelled volume and container from the OFFLINE pinned image (--pull never), published on 127.0.0.1:<ephemeral>,
   --memory 256m;
5. the v27 seed through the fence-enclave store code: a scratch copy of the tree in the stage, the inventory re-checked
   before and after, go test -mod=readonly with GOPROXY=off, GOTOOLCHAIN=local and a per-run GOCACHE;
6. the node, on loopback ports chosen for this run;
7. fixture/run_c2_fixture_test.py: the 8 stages, unchanged;
8. cleanup (c2fx.Run.cleanup). It ALWAYS runs: on success, on failure and on SIGTERM/SIGINT. A SIGKILL leaves the journal
   for --recover.
Exit:
- 0: all 8 stages passed AND cleanup is certain;
- 1: a stage, the seed or the setup failed, and cleanup is certain;
- 2: usage error or refused (nothing of this run was created beyond its journal);
- 3: cleanup UNCERTAIN (the stage and the names are kept and recorded in runs/<id>.result.json), whatever the stages did.
No production, SSH, chain, peers, UPnP, download, signing or live seed. All listeners are on 127.0.0.1."""
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
W = next(p for p in PKG.parents if p.name == "work")
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
import c2fx  # noqa: E402

BUILD = W / "claude-resumed-20261022/storage-enclave-build"
PINS = {   # path (relative to work/) -> sha256
    "claude-resumed-20261022/storage-enclave-build/out/fence-enclave-a/indexd": "c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568",
    "claude-resumed-20261022/storage-enclave-build/out/c2-enclave-a/indexd": "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7",
    "claude-resumed-20261022/storage-enclave-build/inventory/fence-enclave.sha256": "d306f997a60105a17d06aea4f824a2d3134ab962936467a403b789de620b72df",
    "claude-resumed-20261022/storage-enclave-build/trees/fence-enclave/GeoLite2-City.mmdb": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
    "indexd-c2-implementation/package/fixture/c2client": "07d43802720b810961d9846b2de9e5dd798b8152fc8954150a8f42f40105e977",
}
PKG_FILES = ["controller/replicactl.py", "fixture/c2fx.py", "fixture/make-fixture-node.py", "fixture/run_c2_fixture_test.py",
             "fixture/rollout_seed_test.go", "migration/digest.sql", "migration/down-28-to-27.sql", "migration/up-27-to-28.sql"]
GO = "/usr/lib/go/bin/go"
GO_SHA = "dc36303d0ab49f23ae5922d1468bb73c5a093bbec4e598888155b0dc99e0161d"
FENCE, C2 = W / list(PINS)[0], W / list(PINS)[1]
FENCE_TREE, FENCE_INV = BUILD / "trees/fence-enclave", W / list(PINS)[2]
GEOIP, CLIENT = W / list(PINS)[3], W / list(PINS)[4]
RUNS = PKG / "runs"                     # journals, stages and results of every run
MAX_SCOPE = 768 * 1024 * 1024          # the proposed queue allocation; the docker container has its own 256 MiB
PG_MEM_MIB = 256


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def inventory_ok(tree, inv):
    """every file of the inventory, byte-exact, and nothing else (no symlink, no extra file)"""
    want = {}
    for line in Path(inv).read_text().splitlines():
        h, name = line.split("  ", 1)
        want[name[2:] if name.startswith("./") else name] = h
    have = {}
    for dp, dns, fns in os.walk(tree):
        for n in dns + fns:
            full = os.path.join(dp, n)
            if os.path.islink(full):
                return False, f"symlink {full}"
        for n in fns:
            full = os.path.join(dp, n)
            have[os.path.relpath(full, tree)] = sha(full)
    if have != want:
        diff = sorted(set(have) ^ set(want)) or sorted(k for k in want if have.get(k) != want[k])
        return False, f"differs: {diff[:5]}"
    return True, f"{len(have)} files"


def pins():
    got = {p: sha(W / p) for p in PINS}
    got.update({f"storage-enclave-fixture/{p}": sha(PKG / p) for p in PKG_FILES})
    got[GO] = sha(GO)
    bad = [p for p, h in PINS.items() if got[p] != h] + ([GO] if got[GO] != GO_SHA else [])
    ok, why = inventory_ok(FENCE_TREE, FENCE_INV)
    return got, bad, (ok, why)


def manifest(got):
    return hashlib.sha256(json.dumps(got, sort_keys=True).encode()).hexdigest()


def free_ports(n):
    """n distinct free loopback ports (kept bound until all are chosen; a residual reuse race is caught by readiness,
    which needs this run's admin password)"""
    socks = []
    try:
        for _ in range(n):
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            socks.append(s)
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()


def write_secret(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def child(run, args, log, env=None, timeout=1800, cwd=None):
    """a direct child of this runner, tracked so cleanup can stop it; output to the run log only"""
    with open(log, "ab") as lf:
        p = subprocess.Popen(args, stdout=lf, stderr=subprocess.STDOUT, env=env, cwd=cwd, stdin=subprocess.DEVNULL)
        run.children.append(p)
        try:
            return p.wait(timeout)
        except subprocess.TimeoutExpired:
            p.terminate()
            try:
                p.wait(30)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(10)
            return None


def work(run, log, env0):
    st = run.stage
    sec = st / "secrets"
    os.mkdir(sec, 0o700)
    write_secret(sec / "postgres.env", "POSTGRES_USER=indexd\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=indexd\n" % os.urandom(24).hex())
    run.create_volume()
    port = run.create_container(sec / "postgres.env", PG_MEM_MIB)
    if not run.wait_pg():
        raise RuntimeError("PostgreSQL not ready")
    # the v27 seed through the MATCHING fence-enclave store code (a scratch copy; the tree itself is never written)
    seed = st / "seed-tree"
    ok, why = inventory_ok(FENCE_TREE, FENCE_INV)
    if not ok:
        raise RuntimeError(f"fence-enclave tree differs from its inventory before the seed copy: {why}")
    rc = subprocess.run(["cp", "-a", "--no-preserve=ownership", str(FENCE_TREE) + "/.", str(seed)], capture_output=True).returncode
    (seed / "GeoLite2-City.mmdb").unlink()                      # as the old fixture: not needed by the seed test
    ok, why = inventory_ok(FENCE_TREE, FENCE_INV)
    if rc != 0 or not ok:
        raise RuntimeError(f"seed copy failed (rc {rc}) or source tree changed: {why}")
    write_secret(seed / "persist/postgres/rollout_seed_test.go", (PKG / "fixture/rollout_seed_test.go").read_text())
    gocache = st / "gocache"
    os.mkdir(gocache, 0o700)
    pg = dict(l.split("=", 1) for l in (sec / "postgres.env").read_text().split() if "=" in l)
    env = dict(env0, POSTGRES_USER=pg["POSTGRES_USER"], POSTGRES_PASSWORD=pg["POSTGRES_PASSWORD"], ROLLOUT_SEED="1",
               ROLLOUT_PG_PORT=str(port), ROLLOUT_DB="indexd", ROLLOUT_KEY_FILE=str(sec / "app-key.hex"), GOCACHE=str(gocache),
               GOPROXY="off", GOFLAGS="-mod=readonly", GOTOOLCHAIN="local", GOMAXPROCS="2", GOMEMLIMIT="400MiB", CGO_ENABLED="0")
    gomod = {n: sha(seed / n) for n in ("go.mod", "go.sum")}
    rc = child(run, ["taskset", "-c", "0-1", GO, "test", "-p", "1", "-count=1", "-run", "^TestRolloutSeed$", "-v", "./persist/postgres/"],
               log, env=env, cwd=seed, timeout=900)
    if rc != 0 or {n: sha(seed / n) for n in gomod} != gomod or not (sec / "app-key.hex").is_file():
        raise RuntimeError(f"seed failed: go test rc {rc} (go.mod/go.sum unchanged: {({n: sha(seed / n) for n in gomod} == gomod)})")
    run.journal.add(event="seeded", goTestRc=rc)
    # the node, on this run's loopback ports
    admin, syncer, app = free_ports(3)
    nenv = dict(env0, C2FX_STAGE=str(st), C2FX_PORTS=f"{admin},{syncer},{app}", C2FX_PG_PORT=str(port), C2FX_PG_CONTAINER=run.container,
                C2FX_FENCE=str(FENCE), C2FX_GEOIP=str(GEOIP), C2FX_MIGRATION_DIR=str(PKG / "migration"))
    if child(run, [sys.executable, str(HERE / "make-fixture-node.py")], log, env=nenv, timeout=120) != 0:
        raise RuntimeError("make-fixture-node failed")
    run.journal.add(event="node", ports={"admin": admin, "syncer": syncer, "app": app})
    cl = st / "c2client"
    with open(CLIENT, "rb") as src:
        data = src.read()
    fd = os.open(cl, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    if sha(cl) != PINS["indexd-c2-implementation/package/fixture/c2client"]:
        raise RuntimeError("c2client copy differs")
    tenv = dict(env0, C2FX_STAGE=str(st), C2FX_CONTROLLER=str(PKG / "controller/replicactl.py"), C2FX_FENCE=str(FENCE), C2FX_C2=str(C2))
    rc = child(run, [sys.executable, "-u", str(HERE / "run_c2_fixture_test.py")], log, env=tenv, timeout=3600)
    run.journal.add(event="stages", rc=rc)
    return rc


def finish(run, outcome, rc_work, log):
    rep = run.cleanup(pid_files=[run.stage / "node" / "state" / "indexd.pid"], keep=["c2-fixture-results.json"])
    res = {"runId": run.id, "outcome": outcome, "stagesRc": rc_work, "cleanup": rep, "log": str(log),
           "results": str(run.runs / f"{run.id}.c2-fixture-results.json")}
    code = 3 if not rep["certain"] else (0 if rc_work == 0 else 1)
    res["exit"], res["passed"] = code, code == 0
    (run.runs / f"{run.id}.result.json").write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps({k: res[k] for k in ("runId", "outcome", "stagesRc", "exit", "passed")} | {"cleanupCertain": rep["certain"]}), flush=True)
    return code


def main(argv):
    got, bad, inv = pins()
    m = manifest(got)
    if argv == ["--plan"] or not argv:
        print(json.dumps({"mode": "plan (no side effects)", "manifest": m, "pins": got, "pinMismatches": bad,
                          "fenceTreeInventory": inv, "execute": f"--execute {m}"}, indent=1))
        return 0 if not bad and inv[0] else 2
    docker = c2fx.Docker(os.environ.get("C2FX_DOCKER", "docker"))
    runs = RUNS
    if argv[:1] == ["--recover"] and len(argv) == 2:
        rep = c2fx.recover(runs, argv[1], docker)
        print(json.dumps(rep, indent=1))
        return 0 if rep["certain"] else 3
    if argv != ["--execute", m]:
        print(json.dumps({"ok": False, "error": "usage: --plan | --execute <manifest> | --recover <run id>", "manifest": m}))
        return 2
    if bad or not inv[0]:
        print(json.dumps({"ok": False, "error": "pins differ", "bad": bad, "inventory": inv}))
        return 2
    cg, mem = c2fx.own_cgroup()
    if not Path(cg).name.startswith("run-") or not Path(cg).name.endswith(".scope") or mem is None or mem > MAX_SCOPE:
        print(json.dumps({"ok": False, "error": f"must run inside one shared-queue allocation of at most 768 MiB (scope {cg}, memory.max {mem})"}))
        return 2
    run = c2fx.Run(runs, docker, cgroup=cg)
    log = runs / f"{run.id}.log"
    try:
        run.begin()
    except (c2fx.Refused, c2fx.Unknown) as e:
        print(json.dumps({"ok": False, "refused": str(e), "runId": run.id}))
        return 2
    def on_signal(signum, _f):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    env0 = {k: v for k, v in os.environ.items() if not k.startswith(("POSTGRES_", "ROLLOUT_", "C2FX_", "INDEXD_"))}
    rc_work, outcome = None, "error"
    try:
        rc_work = work(run, log, env0)
        outcome = "stages-passed" if rc_work == 0 else "stages-failed"
    except SystemExit as e:
        outcome = f"interrupted (signal exit {e.code})"
    except Exception as e:
        outcome = f"setup-failed: {type(e).__name__}: {str(e)[:300]}"
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        code = finish(run, outcome, rc_work, log)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
