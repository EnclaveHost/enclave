#!/usr/bin/env python3
"""ROOT activation of the /v1/secrets/exists local-record fast path on the control VM. PREPARED by claude (relay-exists); NOT run.

  ./root-activate-relay-exists.py              preflight only (read-only)                                         [default]
  ./root-activate-relay-exists.py --execute    preflight -> backup -> CAS atomic replace -> ONE `systemctl restart
                                               enclave-api-relay` -> health + exists checks -> receipt
                                               (auto-rollback + one more restart ONLY if the relay is not healthy in 60 s)
  ./root-activate-relay-exists.py --rollback   CAS (live must be NEW) -> restore the backup -> ONE restart -> health

File: /opt/nan-relay/secrets.js   LIVE 6f3d8c76...  ->  NEW 4c491271...  (diff: relay-exists/secrets.js.patch, 29 lines)
Backup: /root/relay-exists-20261021/secrets.js.pre-6f3d8c76 (root-only dir, mode 0700). Nothing else is touched: no env file,
no data dir, no secrets store read, no other unit. The NEW bytes travel inside this script (base64) and are hash-checked on
the VM before anything moves. Every step re-checks the live hash right before it acts (CAS).
"""
import base64, hashlib, json, pathlib, subprocess, sys, datetime

HERE = pathlib.Path(__file__).resolve().parent
LIVE = "6f3d8c7633510b5a0c6e4a230aa8b0dad78eff585ad59f8b1fc381f3ef138ea5"
NEW = "4c49127164e716a7431b1e2d62cd703f82b7a849641205e5bdf28d3bd17a198b"
NEW_BYTES = (HERE / "stage" / "relay" / "secrets.js").read_bytes()
assert hashlib.sha256(NEW_BYTES).hexdigest() == NEW, "the staged secrets.js is not the reviewed NEW"
assert hashlib.sha256((HERE / "live-captured" / "secrets.js").read_bytes()).hexdigest() == LIVE
MODE = {"--execute": "execute", "--rollback": "rollback"}.get(sys.argv[1] if len(sys.argv) > 1 else "", "preflight")
if len(sys.argv) > 1 and sys.argv[1] not in ("--execute", "--rollback"):
    sys.exit(f"unknown argument {sys.argv[1]!r}")

REMOTE = r'''
import hashlib, json, os, shutil, subprocess, sys, time, base64, urllib.request
MODE, LIVE, NEW = %(mode)r, %(live)r, %(new)r
NEW_BYTES = base64.b64decode(%(b64)r)
P = "/opt/nan-relay/secrets.js"; BAKDIR = "/root/relay-exists-20261021"; BAK = BAKDIR + "/secrets.js.pre-6f3d8c76"
UNIT = "enclave-api-relay"; PORT = 8100
ID59 = "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c"
out = {"mode": MODE, "steps": []}
def step(k, **v): out["steps"].append({"step": k, "t": time.strftime("%%H:%%M:%%SZ", time.gmtime()), **v})
def sha(p):
    with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()
def show():
    r = subprocess.run(["systemctl", "show", UNIT, "-p", "MainPID,ActiveState,SubState,ExecMainStartTimestamp,NRestarts"], capture_output=True, text=True, timeout=10)
    return dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
def http(path, body=None, timeout=10):
    t0 = time.time()
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json"}, method="GET" if body is None else "POST")
        with urllib.request.urlopen(req, timeout=timeout) as r: code, txt = r.status, r.read(400).decode("utf8", "replace")
    except urllib.error.HTTPError as e: code, txt = e.code, e.read(400).decode("utf8", "replace")
    except Exception as e: code, txt = 0, f"{type(e).__name__}: {e}"[:160]
    try: j = json.loads(txt); txt = {k: j[k] for k in ("ok", "exists", "custody", "error", "enclaves", "of") if k in j}
    except Exception: txt = str(txt)[:160]
    return {"code": code, "s": round(time.time() - t0, 3), "body": txt}
def fail(msg):
    out["result"] = "REFUSED: " + msg; print(json.dumps(out)); sys.exit(2)
def healthy_after(old_pid, budget=60):
    t_end = time.time() + budget
    while time.time() < t_end:
        s = show()
        if s.get("ActiveState") == "active" and s.get("MainPID") not in ("0", old_pid):
            h = http("/health", timeout=5)
            if h["code"] == 200: return s, h
        time.sleep(2)
    return show(), http("/health", timeout=5)
def journal_since(ts):
    r = subprocess.run(["journalctl", "-u", UNIT, "--since", ts, "-n", "300", "--no-pager", "-o", "cat"], capture_output=True, text=True, timeout=20)
    keep = [l[:300] for l in r.stdout.splitlines() if "[custody]" in l or "rror" in l or "listening" in l.lower()]
    return keep[:25]
def restart(expect_new):
    s0 = show(); old = s0.get("MainPID")
    since = time.strftime("%%Y-%%m-%%d %%H:%%M:%%S", time.gmtime())
    if sha(P) != expect_new: fail(f"CAS before restart: live is {sha(P)}, want {expect_new}")
    step("restart", oldPid=old, oldStart=s0.get("ExecMainStartTimestamp"))
    r = subprocess.run(["systemctl", "restart", UNIT], capture_output=True, text=True, timeout=90)
    s, h = healthy_after(old)
    step("after-restart", rc=r.returncode, err=r.stderr[:200], unit=s, health=h, journal=journal_since(since + " UTC"))
    return s.get("ActiveState") == "active" and s.get("MainPID") not in ("0", old) and h["code"] == 200

# ---- preflight (every mode) ----
s = show(); cur = sha(P); st = os.stat(P)
step("preflight", live=cur, unit=s, owner=f"{st.st_uid}:{st.st_gid}", perm=oct(st.st_mode & 0o7777),
     backup=(sha(BAK) if os.path.exists(BAK) else None), health=http("/health", timeout=5), exists59=http("/v1/secrets/exists", {"id": ID59}, timeout=20))
if hashlib.sha256(NEW_BYTES).hexdigest() != NEW: fail("the NEW bytes did not arrive intact")
if s.get("ActiveState") != "active": fail("the relay is not active; not touching it")
if MODE in ("preflight", "execute") and cur not in (LIVE, NEW): fail(f"live secrets.js is {cur}: neither the reviewed LIVE nor NEW")
if MODE == "preflight":
    out["result"] = "PREFLIGHT OK (" + ("NEW already live" if cur == NEW else "LIVE as reviewed") + ")"; print(json.dumps(out)); sys.exit(0)

if MODE == "execute":
    if cur == NEW: fail("NEW is already live; nothing to do (no restart)")
    tmp = "/opt/nan-relay/.secrets.relay-exists.tmp.js"
    with open(tmp, "wb") as f: f.write(NEW_BYTES); f.flush(); os.fsync(f.fileno())
    os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o7777)
    chk = subprocess.run(["node", "--check", tmp], capture_output=True, text=True, timeout=30)
    if chk.returncode != 0 or sha(tmp) != NEW: os.unlink(tmp); fail("staged file failed node --check or its hash: " + chk.stderr[:300])
    os.makedirs(BAKDIR, mode=0o700, exist_ok=True)
    if not os.path.exists(BAK): shutil.copy2(P, BAK)
    if sha(BAK) != LIVE: os.unlink(tmp); fail(f"the backup {BAK} is not LIVE")
    if sha(P) != LIVE: os.unlink(tmp); fail("CAS: live changed during staging")
    os.replace(tmp, P)
    step("replaced", live=sha(P), backup=sha(BAK))
    ok = restart(NEW)
    if not ok:
        # the relay is the whole public API: put LIVE back and restart once more
        if sha(P) == NEW:
            shutil.copy2(BAK, P + ".rb.tmp.js"); os.replace(P + ".rb.tmp.js", P)
        step("AUTO-ROLLBACK", live=sha(P))
        restart(LIVE)
        out["result"] = "FAILED, ROLLED BACK"; print(json.dumps(out)); sys.exit(3)
    checks = [http("/v1/secrets/exists", {"id": ID59}, timeout=20) for _ in range(3)]
    step("exists-59f1273d-after", checks=checks)
    out["result"] = "ACTIVATED" if all(c["code"] == 200 and isinstance(c["body"], dict) and c["body"].get("exists") is True and c["s"] < 3 for c in checks) \
        else "ACTIVATED, BUT exists checks not all fast 200 true (see steps)"
    print(json.dumps(out)); sys.exit(0)

if MODE == "rollback":
    if cur != NEW: fail(f"rollback CAS: live is {cur}, not NEW")
    if not os.path.exists(BAK) or sha(BAK) != LIVE: fail("no intact LIVE backup")
    shutil.copy2(BAK, P + ".rb.tmp.js"); os.replace(P + ".rb.tmp.js", P)
    step("restored", live=sha(P))
    ok = restart(LIVE)
    out["result"] = "ROLLED BACK" if ok else "ROLLED BACK, BUT relay NOT healthy (see steps)"; print(json.dumps(out)); sys.exit(0 if ok else 3)
'''

script = REMOTE % {"mode": MODE, "live": LIVE, "new": NEW, "b64": base64.b64encode(NEW_BYTES).decode()}
cmd = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts',
       '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', 'sudo python3 -']
r = subprocess.run(cmd, input=script, capture_output=True, text=True, timeout=300)
o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "mode": MODE, "exit": r.returncode, "err": r.stderr[:600]}
try: o["remote"] = json.loads(r.stdout.strip().splitlines()[-1])
except Exception as e: o["parseError"] = str(e)[:200]; o["stdoutHead"] = r.stdout[:600]
name = {"preflight": "preflight", "execute": "receipt-execute", "rollback": "receipt-rollback"}[MODE]
(HERE / f"relay-exists-{name}-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json").write_text(json.dumps(o, indent=1) + "\n")
print(json.dumps(o, indent=1))
sys.exit(0 if r.returncode == 0 else r.returncode)
