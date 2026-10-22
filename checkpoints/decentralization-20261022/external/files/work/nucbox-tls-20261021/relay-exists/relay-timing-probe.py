# READ-ONLY public-route timing ON the control VM (bypasses the fronts): /health vs /v1/secrets/exists for 59f1273d (a
# boolean-only public lookup) vs an id with no deployment (exercises the custody NO path: always a fresh chain-quorum read).
# No env, store or secret read; the listening port comes from ss for the unit's MainPID.
import subprocess, json, pathlib, datetime
HERE = pathlib.Path(__file__).resolve().parent
remote = r'''sudo python3 - <<'REMOTE'
import subprocess, json, re, time, concurrent.futures as cf
pid = subprocess.run(["systemctl","show","enclave-api-relay","-p","MainPID","--value"],capture_output=True,text=True).stdout.strip()
ss = subprocess.run(["ss","-ltnpH"],capture_output=True,text=True).stdout
ports = sorted({m.group(1) for l in ss.splitlines() if f"pid={pid}," in l for m in [re.search(r":(\d+)\s", l)] if m})
IDS = {"59f1273d": "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c",
       "none": "0x" + "5e1a7e" * 10 + "0e1a"}
def one(port, path, idk=None):
    cmd = ["curl","-sS","--max-time","30","-w","\n%{http_code} %{time_total}", f"http://127.0.0.1:{port}{path}"]
    if idk: cmd += ["-H","content-type: application/json","--data",json.dumps({"id": IDS[idk]})]
    p = subprocess.run(cmd,capture_output=True,text=True,timeout=40); body,_,meta = p.stdout.rpartition("\n")
    try: b = json.loads(body); body = {k: b[k] for k in ("exists","custody","error","ok") if k in b}
    except Exception: body = body[:120]
    return {"path": path, "id": idk, "meta": meta, "body": body, "err": p.stderr[:120]}
out = {"pid": pid, "ports": ports, "rounds": []}
port = None
for p in ports:
    r = one(p, "/health")
    if r["meta"].startswith("200"): port = p; break
out["port"] = port
if port:
    for i in range(3):
        t = time.strftime("%H:%M:%S", time.gmtime())
        with cf.ThreadPoolExecutor(3) as ex:
            rs = list(ex.map(lambda a: one(port, *a), [("/health",), ("/v1/secrets/exists","59f1273d"), ("/v1/secrets/exists","none")]))
        out["rounds"].append({"at": t, "r": rs})
print(json.dumps(out))
REMOTE'''
cmd = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts',
       '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', remote]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': r.returncode, 'err': r.stderr[:600]}
try: o['probe'] = json.loads(r.stdout.strip().splitlines()[-1])
except Exception as e: o['parseError'] = str(e)[:200]; o['stdoutHead'] = r.stdout[:400]
(HERE / 'relay-timing-probe.json').write_text(json.dumps(o, indent=1) + '\n')
print(json.dumps(o, indent=1)[:5000])
