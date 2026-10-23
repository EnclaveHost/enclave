#!/usr/bin/env python3
"""HTTP smoke of the built component on the ACTUAL release-16c2999d runtime (template/rt wasmtime 49.0.0, sha 9caac5e6),
with init's serve argv and environment as the release-lineage init builds them (Projects/enclave custody/front-prod
837c0061d dominit.c: serve[] + app_argv; its strings match the release init a8bd7e1a): HOME=/tmp, PATH=/rt,
`--env ENCLAVE_CONFIG` when there is a config, then one `--env NAME=VALUE` ARGUMENT per staged secret in the front's
sorted order (front/provision.go secretEnv), SET + memory64 features as the release's set.enabled/mem64.enabled select.
Loopback only; SYNTHETIC markers only (test/kat.py fixtures plus fresh random ones in the driver's marker format).

usage: smoke.py <component.wasm>   -> exit 0 and "SMOKE PASS n/n" only if every check passed
"""
import hashlib, http.client, os, secrets, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from kat import C, M1, M2, proof

RT = "/home/steven/enclave-prod/release-16c2999d/template/rt"
RT_SHA = "9caac5e682396f9dd275b1599843d80568bd7067e4abd3136cfa798800b905b9"
FEATURES = "threads,shared-everything-threads,component-model-threading,shared-memory,memory64,component-model-memory64"
wasm = sys.argv[1]
checks = []

def check(name, ok):
    checks.append((name, bool(ok)))
    print(("ok   " if ok else "FAIL ") + name, flush=True)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def marker():
    return "CANARY_20261023T000000Z_smoke_" + secrets.token_hex(32)

def serve(config, staged):
    port = free_port()
    argv = [f"{RT}/ld-linux-x86-64.so.2", "--library-path", RT, f"{RT}/wasmtime", "serve", "-S", "cli", "-W", FEATURES,
            "-C", "cache=n", "--addr", f"127.0.0.1:{port}"]
    env = {"HOME": "/tmp", "PATH": "/rt"}
    if config is not None:
        argv += ["--env", "ENCLAVE_CONFIG"]; env["ENCLAVE_CONFIG"] = config
    for name in sorted(staged):
        argv += ["--env", f"{name}={staged[name]}"]
    argv.append(wasm)
    p = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(600):
        try: socket.create_connection(("127.0.0.1", port), 0.2).close(); return p, port
        except OSError:
            if p.poll() is not None: break
            time.sleep(0.1)
    p.kill(); raise SystemExit("runtime did not start: " + p.stdout.read().decode(errors="replace")[-2000:])

def req(port, method, path):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    c.request(method, path, body=b"x" if method == "POST" else None)
    r = c.getresponse(); body = r.read(); c.close()
    return r.status, dict((k.lower(), v) for k, v in r.getheaders()), body

def stop(p):
    p.terminate()
    try: out, _ = p.communicate(timeout=10)
    except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate()
    return out

check("release wasmtime is the pinned binary", hashlib.sha256(open(f"{RT}/wasmtime", "rb").read()).hexdigest() == RT_SHA)

# 1) staged secrets as the front hands them over: two fixed KAT markers, one fresh marker, a non-canary secret holding a
#    marker-format value, a low-entropy CANARY_ secret; plus a config that carries a marker (never a source).
R = marker()
staged = {"CANARY_R1_A": M1, "CANARY_R1_B": M2, "CANARY_FRESH": R, "API_TOKEN": marker(), "CANARY_LOW": "hunter2"}
cfg = '{"CANARY_CFG":"%s"}' % marker()
p, port = serve(cfg, staged)
try:
    c2 = secrets.token_hex(32)
    for ch in (C, c2):
        st, h, body = req(port, "GET", "/canary/proof?c=" + ch)
        want = ('{"v":1,"names":["CANARY_FRESH","CANARY_R1_A","CANARY_R1_B"],"proofs":{"CANARY_FRESH":"%s","CANARY_R1_A":"%s","CANARY_R1_B":"%s"}}'
                % (proof(R, "CANARY_FRESH", ch), proof(M1, "CANARY_R1_A", ch), proof(M2, "CANARY_R1_B", ch)))
        check(f"200 + exact independent proofs (challenge {'KAT' if ch == C else 'fresh'})", st == 200 and body.decode() == want)
        check("json + no-store headers", h.get("content-type") == "application/json" and h.get("cache-control") == "no-store")
        check("no secret or config value in the body", not any(v.encode() in body for v in list(staged.values()) + [cfg]))
    st, _, body = req(port, "GET", "/canary/proof?c=" + C)
    check("KAT vector 1 served", proof(M1, "CANARY_R1_A", C).encode() in body
          and proof(M1, "CANARY_R1_A", C) == "8f239464100370f8e7c1355b9fc4d7f70f43a453c2872b58e3802731eb793bd1")
    for path in ["/canary/proof?c=00", "/canary/proof?c=" + C.upper(), "/canary/proof?c=" + C + "0", "/canary/proof?c="]:
        st, _, body = req(port, "GET", path)
        check(f"400 empty body: {path[:24]}...", st == 400 and body == b"")
    for method, path in [("GET", "/"), ("GET", "/env"), ("GET", "/canary/proof"), ("POST", "/canary/proof?c=" + C),
                         ("PUT", "/canary/proof?c=" + C), ("GET", "/canary/proof?x=1&c=" + C)]:
        st, _, body = req(port, method, path)
        check(f"404 empty body: {method} {path[:24]}", st == 404 and body == b"")
finally:
    out = stop(p)
check("runtime output carries no secret or config value", not any(v.encode() in out for v in list(staged.values()) + [cfg]))

# 2) no usable marker -> 409: no secrets at all; only non-canary and low-entropy ones; a marker only in the config;
#    nine CANARY_ names (the eight-name ceiling refuses everything).
nine = {f"CANARY_{i}": marker() for i in range(9)}
for label, config, st_ in [("no secrets", None, {}), ("non-canary + low-entropy only", None, {"API_TOKEN": marker(), "CANARY_LOW": "hunter2"}),
                           ("marker only in ENCLAVE_CONFIG", '{"CANARY_X":"%s"}' % marker(), {}), ("nine CANARY_ names", None, nine)]:
    p, port = serve(config, st_)
    try:
        st, _, body = req(port, "GET", "/canary/proof?c=" + C)
        check(f"409 empty body: {label}", st == 409 and body == b"")
    finally:
        stop(p)

passed = sum(ok for _, ok in checks)
print(f"SMOKE {'PASS' if passed == len(checks) else 'FAIL'} {passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
