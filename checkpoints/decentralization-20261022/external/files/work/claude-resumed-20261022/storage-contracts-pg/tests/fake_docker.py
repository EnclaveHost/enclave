#!/usr/bin/env python3
"""Fake `docker` for contracts_pg_runner.py helper tests: a JSON state file of containers and volumes, a JSON-lines
call log, and fault injection via FAKE_DOCKER_SCENARIO (comma-separated):
  lost-create      the container is created, but `run` answers rc 125 with no ID (lost response)
  create-hang      the container is created, then `run` hangs (the runner's create timeout fires)
  create-fails     nothing is created, rc 125
  ps-fails         every `ps` fails (docker unreachable from the start)
  ps-fails-after-create  `ps` fails once a run-labelled container exists (daemon unreachable after the create)
  collision        `ps --filter name=...` reports a foreign container holding the name
  rm-fails         `rm` fails and the container stays
  rm-keeps-volume  `rm` removes the container but leaves its anonymous volume
  bad-isolation    inspect reports NetworkMode=bridge
  never-ready      pg_isready never succeeds
  toolchain-bad    `go version` fails in the container
  suite-fail:<n>   go test for suite <n> exits 1 with one failing test
  suite-lie:<n>    go test for suite <n> exits 1 although every reported test passed
  suite-hang:<n>   go test for suite <n> sleeps (the outer timeout / signals fire)
  exec-125:<n>     docker exec for suite <n> fails in transport (rc 125, no go test result)
  volume-inspect-fails  `volume inspect` answers a daemon/permission error (not "no such volume")
  volume-rm-fails  `volume rm` fails, so the volume stays
  inspect-conn-error-after-rm  container inspect after a successful rm answers a socket error that contains "no such file"
The env file passed to `run` is read here only to record its password in a side file, so the tests can prove the
runner never prints it."""
import json, os, re, secrets, sys, time
STATE, LOG, SC = os.environ["FAKE_DOCKER_STATE"], os.environ["FAKE_DOCKER_LOG"], set(filter(None, os.environ.get("FAKE_DOCKER_SCENARIO", "").split(",")))
IMAGE = os.environ["FAKE_DOCKER_IMAGE"]
a = sys.argv[1:]
with open(LOG, "a") as f: f.write(json.dumps(a) + "\n")
st = json.load(open(STATE)) if os.path.exists(STATE) else {"containers": {}, "volumes": []}
def save(): json.dump(st, open(STATE + ".tmp", "w")); os.replace(STATE + ".tmp", STATE)
def die(msg, rc=1): print(msg, file=sys.stderr); sys.exit(rc)
def opt(name, args):
    return [args[i + 1] for i, x in enumerate(args[:-1]) if x == name]
def has_scenario(prefix, suite=None):
    return (prefix in SC) if suite is None else (f"{prefix}:{suite}" in SC)

cmd = a[0]
if cmd == "image":
    sys.exit(0 if a[-1] == IMAGE and print(IMAGE) is None else 1)
if cmd == "ps":
    if "ps-fails" in SC: die("Cannot connect to the Docker daemon", 1)
    if "ps-fails-after-create" in SC and any(c["labels"].get("enclave.test.run") not in (None, "other") for c in st["containers"].values()):
        die("Cannot connect to the Docker daemon", 1)
    flt = opt("--filter", a); fmt = (opt("--format", a) or ["{{.ID}}"])[0]
    rows = []
    for cid, c in st["containers"].items():
        ok = True
        for fl in flt:
            k, v = fl.split("=", 1)
            if k == "name": ok &= re.fullmatch(v.replace("^/", "^"), c["name"]) is not None
            if k == "label": lk, lv = v.split("=", 1); ok &= c["labels"].get(lk) == lv
        if ok: rows.append((cid, c))
    if "collision" in SC and any(fl.startswith("name=") for fl in flt): rows.append(("f" * 64, {"name": "foreign", "image": IMAGE}))
    for cid, c in rows:
        print(cid if "-q" in a else fmt.replace("{{.ID}}", cid).replace("{{.Names}}", c["name"]).replace("{{.Image}}", c["image"]))
    sys.exit(0)
if cmd == "run":
    if "create-fails" in SC: die("docker: Error response from daemon: failed", 125)
    labels = dict(l.split("=", 1) for l in opt("--label", a)); name = opt("--name", a)[0]
    mounts = []
    for m in opt("--mount", a):
        kv = dict(x.split("=", 1) if "=" in x else (x, True) for x in m.split(","))
        mounts.append({"Type": "bind", "Source": kv["src"], "Destination": kv["dst"], "RW": "readonly" not in kv})
    vol = secrets.token_hex(32); st["volumes"].append(vol)
    mounts.append({"Type": "volume", "Name": vol, "Destination": "/var/lib/postgresql", "RW": True})
    env = {}
    for line in open(opt("--env-file", a)[0]):
        k, _, v = line.strip().partition("="); env[k] = v
    with open(STATE + ".secret", "w") as f: f.write(env["POSTGRES_PASSWORD"])
    cid = secrets.token_hex(32)
    st["containers"][cid] = {"name": name, "labels": labels, "image": a[-2], "mounts": mounts, "running": True,
                             "memory": opt("--memory", a)[0], "cpus": opt("--cpus", a)[0], "cpuset": opt("--cpuset-cpus", a)[0], "ro": "--read-only" in a}
    save()
    if "lost-create" in SC: die("docker: error during connect: context deadline exceeded", 125)
    if "create-hang" in SC: time.sleep(30)
    print(cid); sys.exit(0)
if cmd == "inspect":
    cid = a[-1]; c = st["containers"].get(cid)
    if c is None and "inspect-conn-error-after-rm" in SC and cid in st.get("removed", []):
        die("error during connect: Get http://%2Fvar%2Frun%2Fdocker.sock: dial unix /var/run/docker.sock: connect: no such file or directory", 1)
    if c is None: die(f"Error: No such object: {cid}", 1)
    fmt = opt("--format", a)
    if fmt == ["{{.State.Running}}"]: print("true" if c["running"] else "false"); sys.exit(0)
    if fmt == ["{{.Id}}"]: print(cid); sys.exit(0)
    mem = int(c["memory"].rstrip("m")) << 20
    print(json.dumps([{"Id": cid, "Name": "/" + c["name"], "Image": c["image"], "Config": {"Labels": c["labels"]},
                       "HostConfig": {"NetworkMode": "bridge" if "bad-isolation" in SC else "none", "PortBindings": {}, "Memory": mem, "MemorySwap": mem,
                                      "NanoCpus": int(float(c["cpus"]) * 1e9), "CpusetCpus": c["cpuset"], "ReadonlyRootfs": c["ro"]},
                       "Mounts": c["mounts"]}])); sys.exit(0)
if cmd == "exec":
    cid = next(x for x in a if re.fullmatch(r"[0-9a-f]{64}", x))
    if cid not in st["containers"]: die(f"Error: No such container: {cid}", 1)
    rest = a[a.index(cid) + 1:]
    if rest[0] == "pg_isready": sys.exit(2 if "never-ready" in SC else 0)
    if rest[-1] == "version":
        if "toolchain-bad" in SC: die("exec format error", 126)
        print(os.environ["FAKE_GO_VERSION"]); sys.exit(0)
    suite = opt("--workdir", a)[0].rsplit("/", 1)[-1]
    if has_scenario("exec-125", suite): die("Error response from daemon: container is not running", 125)
    if has_scenario("suite-hang", suite): time.sleep(60)
    ev = lambda **e: print(json.dumps(e))
    ev(Action="run", Package="go.sia.tech/indexd/contracts", Test="TestA"); ev(Action="pass", Package="go.sia.tech/indexd/contracts", Test="TestA")
    if has_scenario("suite-fail", suite):
        ev(Action="output", Package="go.sia.tech/indexd/contracts", Test="TestB", Output="    x_test.go:1: boom\n")
        ev(Action="fail", Package="go.sia.tech/indexd/contracts", Test="TestB"); ev(Action="fail", Package="go.sia.tech/indexd/contracts"); sys.exit(1)
    ev(Action="pass", Package="go.sia.tech/indexd/contracts"); ev(Action="skip", Package="go.sia.tech/indexd/cmd/indexd")
    sys.exit(1 if has_scenario("suite-lie", suite) else 0)
if cmd == "rm":
    cid = a[-1]; c = st["containers"].get(cid)
    if c is None: die(f"Error: No such container: {cid}", 1)
    if "rm-fails" in SC: die("Error response from daemon: could not kill", 1)
    if "-v" in a and "rm-keeps-volume" not in SC:
        for m in c["mounts"]:
            if m["Type"] == "volume" and m["Name"] in st["volumes"]: st["volumes"].remove(m["Name"])
    del st["containers"][cid]; st.setdefault("removed", []).append(cid); save(); sys.exit(0)
if cmd == "volume":
    v = a[-1]
    if a[1] == "inspect":
        if "volume-inspect-fails" in SC: die("Error response from daemon: permission denied while trying to connect", 1)
        if v in st["volumes"]: print(json.dumps([{"Name": v}])); sys.exit(0)
        die(f"Error response from daemon: get {v}: no such volume", 1)
    if a[1] == "rm":
        if "volume-rm-fails" in SC: die(f"Error response from daemon: remove {v}: volume is in use", 1)
        if v not in st["volumes"]: die(f"Error response from daemon: get {v}: no such volume", 1)
        st["volumes"].remove(v); save(); sys.exit(0)
die(f"fake docker: unsupported {a}", 99)
