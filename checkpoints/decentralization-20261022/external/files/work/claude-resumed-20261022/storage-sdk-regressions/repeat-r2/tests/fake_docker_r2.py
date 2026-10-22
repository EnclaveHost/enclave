#!/usr/bin/env python3
"""repeat-r2 copy of ../../tests/fake_docker_sdk.py (r1 tests unchanged). Additions: the driver.log uses the REAL
--nocapture layout (output continues the header line; the outcome is a standalone line) unless `inline` is in the
scenario; the harness zap log <dir>/harness.log is written (with a signed-URL query to prove redaction, or 9 MiB with
`bigzap:<g>`); -e HOSTS is recorded by the call log.
Fake `docker` for sdk_regression_runner.py helper tests. Container/volume semantics are the same as
storage-contracts-pg/tests/fake_docker.py r2, including the strict "no such" answers. SDK-specific execs:
  - `cat /proc/net/if_inet6`: has lo ::1 unless the scenario is no-ipv6;
  - `/driver/sdk-driver --list --ignored`: the FAKE_DRIVER_LIST cases; driver-missing-case drops one;
  - `... bash /tools/case-group.sh`: writes driver.log, events.jsonl and resources.txt into the BOUND scratch
    (/scratch -> host path), prints GROUP-RESULT and exits like the real script.
Per-group scenarios (FAKE_DOCKER_SCENARIO, comma-separated):
  fail:<g> one case FAILED, rc 101 | zero:<g> rc 0 but "0 passed" | notready:<g> rc 3 | harnessbad:<g> driver ok,
  harness rc 2 | hang:<g> sleeps (outer timeout) | x125:<g> rc 125 transport error |
  extra:<g> one unconfigured test also runs and passes | summary:<g> every case line ok but the result line says 1 failed.
Global scenarios: no-ipv6, driver-missing-case, rm-fails, never-ready."""
import json, os, re, secrets, sys, time
STATE, LOG, SC = os.environ["FAKE_DOCKER_STATE"], os.environ["FAKE_DOCKER_LOG"], set(filter(None, os.environ.get("FAKE_DOCKER_SCENARIO", "").split(",")))
IMAGE = os.environ["FAKE_DOCKER_IMAGE"]
a = sys.argv[1:]
with open(LOG, "a") as f: f.write(json.dumps(a) + "\n")
st = json.load(open(STATE)) if os.path.exists(STATE) else {"containers": {}, "volumes": []}
def save(): json.dump(st, open(STATE + ".tmp", "w")); os.replace(STATE + ".tmp", STATE)
def die(msg, rc=1): print(msg, file=sys.stderr); sys.exit(rc)
def opt(name, args): return [args[i + 1] for i, x in enumerate(args[:-1]) if x == name]
cmd = a[0]
if cmd == "image": sys.exit(0 if a[-1] == IMAGE and print(IMAGE) is None else 1)
if cmd == "ps":
    flt = opt("--filter", a); fmt = (opt("--format", a) or ["{{.ID}}"])[0]
    for cid, c in st["containers"].items():
        ok = True
        for fl in flt:
            k, v = fl.split("=", 1)
            if k == "name": ok &= re.fullmatch(v.replace("^/", "^"), c["name"]) is not None
            if k == "label": lk, lv = v.split("=", 1); ok &= c["labels"].get(lk) == lv
        if ok: print(cid if "-q" in a else fmt.replace("{{.ID}}", cid).replace("{{.Names}}", c["name"]).replace("{{.Image}}", c["image"]))
    sys.exit(0)
if cmd == "run":
    labels = dict(l.split("=", 1) for l in opt("--label", a)); name = opt("--name", a)[0]; mounts = []
    for m in opt("--mount", a):
        kv = dict(x.split("=", 1) if "=" in x else (x, True) for x in m.split(","))
        mounts.append({"Type": "bind", "Source": kv["src"], "Destination": kv["dst"], "RW": "readonly" not in kv})
    vol = secrets.token_hex(32); st["volumes"].append(vol); mounts.append({"Type": "volume", "Name": vol, "Destination": "/var/lib/postgresql", "RW": True})
    env = dict(l.strip().split("=", 1) for l in open(opt("--env-file", a)[0]) if "=" in l)
    open(STATE + ".secret", "w").write(env["POSTGRES_PASSWORD"])
    cid = secrets.token_hex(32)
    st["containers"][cid] = {"name": name, "labels": labels, "image": a[-2], "mounts": mounts, "running": True, "memory": opt("--memory", a)[0],
                             "cpus": opt("--cpus", a)[0], "cpuset": opt("--cpuset-cpus", a)[0], "ro": "--read-only" in a, "sysctl": opt("--sysctl", a)}
    save(); print(cid); sys.exit(0)
if cmd == "inspect":
    cid = a[-1]; c = st["containers"].get(cid)
    if c is None: die(f"Error: No such object: {cid}", 1)
    fmt = opt("--format", a)
    if fmt == ["{{.State.Running}}"]: print("true"); sys.exit(0)
    if fmt == ["{{.Id}}"]: print(cid); sys.exit(0)
    mem = int(c["memory"].rstrip("m")) << 20
    print(json.dumps([{"Id": cid, "Name": "/" + c["name"], "Image": c["image"], "Config": {"Labels": c["labels"]},
                       "HostConfig": {"NetworkMode": "none", "PortBindings": {}, "Memory": mem, "MemorySwap": mem, "NanoCpus": int(float(c["cpus"]) * 1e9),
                                      "CpusetCpus": c["cpuset"], "ReadonlyRootfs": c["ro"]}, "Mounts": c["mounts"]}])); sys.exit(0)
if cmd == "exec":
    cid = next(x for x in a if re.fullmatch(r"[0-9a-f]{64}", x)); c = st["containers"].get(cid)
    if c is None: die(f"Error: No such container: {cid}", 1)
    rest = a[a.index(cid) + 1:]
    if rest[0] == "pg_isready": sys.exit(2 if "never-ready" in SC else 0)
    if rest[:2] == ["cat", "/proc/net/if_inet6"]:
        if "no-ipv6" not in SC: print("00000000000000000000000000000001 01 80 10 80       lo")
        sys.exit(0)
    if rest[0] == "/driver/sdk-driver":
        cases = json.load(open(os.environ["FAKE_DRIVER_LIST"]))
        if "driver-missing-case" in SC: cases = cases[1:]
        for x in cases: print(f"{x}: test")
        sys.exit(0)
    env = dict(e.split("=", 1) for e in opt("-e", a)); g = env["GROUP"]; cases = env["CASES"].split()
    has = lambda k: f"{k}:{g}" in SC
    if has("x125"): die("Error response from daemon: container is not running", 125)
    if has("hang"): time.sleep(60)
    scratch = next(m["Source"] for m in c["mounts"] if m["Destination"] == "/scratch")
    d = os.path.join(scratch, "runs", g); os.makedirs(d)
    with open(os.path.join(scratch, "runs", f"{g}.harness.log"), "w") as f: f.write("harness log\n")
    if has("notready"): print("GROUP-RESULT harness-not-ready"); sys.exit(3)
    zap = os.path.join(d, "harness.log")
    open(zap, "w").write(("Z" * (9 << 20) + "\n") if has("bigzap") else '{"msg":"contract formed","url":"http://x/?sc=ZAPSECRET"}\n')
    lines, failed = [f"running {len(cases)} tests"], 0
    for i, x in enumerate(cases):
        bad = has("fail") and i == 0; failed += bad
        if "inline" in SC: lines.append(f"test {x} ... {'FAILED' if bad else 'ok'}")
        else: lines += [f"test {x} ... EVIDENCE registered {{\"indexer\":0}}", "[sia-s3] membership: Stable (ready)"] + (["thread 'x' panicked at src/real_indexd.rs:1:1:", "boom"] if bad else []) + ["FAILED" if bad else "ok"]
    if failed: lines += ["", "failures:", "", "failures:", f"    {cases[0]}"]
    if has("extra"): lines.append("test real_indexd::some_unconfigured_case ... ok")
    lines.append("EVIDENCE url https://indexer.invalid/x?sc=SIGNEDSECRET&ss=SIG2")
    n = 0 if has("zero") else len(cases) - failed + (1 if has("extra") else 0)
    if has("summary"): failed = 1
    lines.append(f"test result: {'FAILED' if failed else 'ok'}. {n} passed; {failed} failed; 0 ignored; 0 measured; 100 filtered out; finished in 1.0s")
    open(os.path.join(d, "driver.log"), "w").write("\n".join(lines if not has("zero") else lines[-2:]) + "\n")
    open(os.path.join(d, "events.jsonl"), "w").write('{"event":"x","url":"?sf=SECRET3"}\n'); open(os.path.join(d, "resources.txt"), "w").write("1 hosts\n")
    rc = 101 if failed else 0
    print(f"GROUP-RESULT driver={rc} harness={2 if has('harnessbad') else 0}"); sys.exit(rc)
if cmd == "rm":
    cid = a[-1]; c = st["containers"].get(cid)
    if c is None: die(f"Error: No such container: {cid}", 1)
    if "rm-fails" in SC: die("Error response from daemon: could not kill", 1)
    for m in c["mounts"]:
        if m["Type"] == "volume" and m["Name"] in st["volumes"]: st["volumes"].remove(m["Name"])
    del st["containers"][cid]; save(); sys.exit(0)
if cmd == "volume":
    v = a[-1]
    if a[1] == "inspect":
        if v in st["volumes"]: print("[]"); sys.exit(0)
        die(f"Error response from daemon: get {v}: no such volume", 1)
    if a[1] == "rm":
        if v not in st["volumes"]: die(f"Error response from daemon: get {v}: no such volume", 1)
        st["volumes"].remove(v); save(); sys.exit(0)
die(f"fake docker: unsupported {a}", 99)
