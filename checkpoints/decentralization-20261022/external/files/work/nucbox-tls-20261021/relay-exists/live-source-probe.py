# READ-ONLY, source/metadata only: hashes + copies the live relay CODE files (never the env file, the secrets store or
# any data dir), the unit's start/PID metadata, and the relay's own [custody] startup line (addresses + counts, no URLs).
import subprocess, json, pathlib, datetime, base64
HERE = pathlib.Path(__file__).resolve().parent
remote = r'''sudo python3 - <<'REMOTE'
import subprocess, json, hashlib, base64, re, os
out = {"files": {}}
for f in ["secrets.js", "custody-state.mjs", "api-relay.js", "secrets-release.mjs", "package.json"]:
    p = "/opt/nan-relay/" + f
    try:
        b = open(p, "rb").read()
        out["files"][f] = {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b), "mtime": int(os.stat(p).st_mtime)}
        if f in ("secrets.js", "custody-state.mjs"): out["files"][f]["b64"] = base64.b64encode(b).decode()
    except Exception as e:
        out["files"][f] = {"error": str(e)[:200]}
try:
    pj = json.load(open("/opt/nan-relay/node_modules/viem/package.json")); out["viem"] = pj.get("version")
except Exception as e: out["viem"] = "err " + str(e)[:80]
r = subprocess.run(["systemctl", "show", "enclave-api-relay", "-p", "MainPID,ActiveState,SubState,ExecMainStartTimestamp,NRestarts,FragmentPath,DropInPaths"], capture_output=True, text=True, timeout=10)
out["unit"] = r.stdout
r = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10); out["node"] = r.stdout.strip()
r = subprocess.run(["journalctl", "-u", "enclave-api-relay", "--since", "-6h", "-n", "40000", "--no-pager", "-o", "short-iso"], capture_output=True, text=True, timeout=25)
cust = [s[:400] for s in r.stdout.splitlines() if "[custody]" in s]
out["custodyLines"] = cust[-6:]
starts = [s[:200] for s in r.stdout.splitlines() if "Started" in s or "Stopping" in s or "Main process exited" in s]
out["unitEvents"] = starts[-6:]
out["counts"] = {k: sum(1 for s in r.stdout.splitlines() if k in s) for k in ["custody_unconfirmed", "only ", "RPCs disagree", "older than", "secrets/exists"]}
print(json.dumps(out))
REMOTE'''
cmd = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts',
       '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', remote]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=55)
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': r.returncode, 'err': r.stderr[:600]}
try:
    j = json.loads(r.stdout.strip().splitlines()[-1])
    cap = HERE / 'live-captured'; cap.mkdir(exist_ok=True)
    for f, v in j['files'].items():
        if 'b64' in v:
            (cap / f).write_bytes(base64.b64decode(v.pop('b64')))
    o['live'] = j
except Exception as e:
    o['parseError'] = str(e)[:200]; o['stdoutHead'] = r.stdout[:400]
(HERE / 'live-source-probe.json').write_text(json.dumps(o, indent=1) + '\n')
print(json.dumps({k: v for k, v in o.items()}, indent=1)[:4000])
