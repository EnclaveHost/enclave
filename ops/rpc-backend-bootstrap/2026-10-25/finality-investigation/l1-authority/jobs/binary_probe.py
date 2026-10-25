#!/usr/bin/env python3
"""Behaviour probe of the ACTUAL pinned Helios binary through the launcher, inside `unshare -rn` (loopback only).
Fake beacon/EL servers answer 404/errors, so Helios can never sync: the probe shows which endpoints the real binary
contacts with the launcher's argv/env, that it requests bootstrap for OUR checkpoint, and that its RPC never reports a
finalized block. It does not (and cannot) show successful verification. Usage: binary_probe.py BINARY SHA256 OUTDIR"""
import http.server, json, os, signal, subprocess, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import l1_authority as L

binary, sha, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
seen = []


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        seen.append({"server": self.server.name, "method": "GET", "path": self.path})
        self.reply(404, {"code": 404, "message": "probe: not served"})
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n).decode(errors="replace")[:300]
        seen.append({"server": self.server.name, "method": "POST", "path": self.path, "body": body})
        self.reply(200, {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "probe: not served"}})


def serve(name, port):
    s = http.server.ThreadingHTTPServer(("127.0.0.1", port), H); s.name = name
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


beacon, el = serve("beacon", 15052), serve("el", 15545)
root = tempfile.mkdtemp(prefix="l1p-")
for d in ("data", "home"):
    os.mkdir(os.path.join(root, d), 0o700)
now = int(time.time())
slot = (now - L.MAINNET_GENESIS_TIME) // 12 // 32 * 32 - 32 * 10
cp_root = "0x" + "ab" * 32
json.dump({"format": L.CHECKPOINT_FORMAT, "network": "mainnet", "root": cp_root, "slot": slot,
           "sources": [{"kind": "own-lighthouse", "ref": "probe", "observedAt": "probe"},
                       {"kind": "operator-attestation", "ref": "probe-only synthetic root", "observedAt": "probe"}],
           "recordedAt": "probe"}, open(os.path.join(root, "cp.json"), "w"))
cfg = {"format": L.FORMAT, "network": "mainnet", "binary": {"path": binary, "sha256": sha},
       "consensusRpc": "http://127.0.0.1:15052", "executionRpc": "http://127.0.0.1:15545",
       "listen": {"ip": "127.0.0.1", "port": 18550}, "dataDir": os.path.join(root, "data"), "homeDir": os.path.join(root, "home"),
       "checkpointFile": os.path.join(root, "cp.json"), "maxCheckpointAgeSec": 604800, "maxFinalizedAgeSec": 1800, "logFilter": "debug"}
json.dump(cfg, open(os.path.join(root, "config.json"), "w"))

# the binary's own help: which flags this exact build accepts (no network)
hp = subprocess.run([binary, "ethereum", "--help"], capture_output=True, text=True, timeout=60, env={"HOME": os.path.join(root, "home")})
open(os.path.join(out, "helios-ethereum-help.txt"), "w").write(hp.stdout + hp.stderr)

log = open(os.path.join(out, "helios-run.log"), "w")
p = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(HERE), "l1_authority.py"), "run", os.path.join(root, "config.json")],
                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                     env=dict(os.environ, CONSENSUS_RPC="http://127.0.0.1:1", LOAD_EXTERNAL_FALLBACK="true", FALLBACK="http://127.0.0.1:2"))
statuses = []
deadline = time.time() + 40
while time.time() < deadline and p.poll() is None:
    time.sleep(2)
    try:
        c = L.load_config(os.path.join(root, "config.json"))
        statuses.append({"t": round(time.time() - now, 1), "status": L.status(c)})
    except L.Refused as e:
        statuses.append({"t": round(time.time() - now, 1), "refused": e.code, "message": str(e)[:160]})
    except OSError as e:
        statuses.append({"t": round(time.time() - now, 1), "unavailable": str(e)[:120]})
alive = p.poll() is None
try:
    os.killpg(p.pid, signal.SIGTERM); p.wait(timeout=10)
except Exception:
    os.killpg(p.pid, signal.SIGKILL); p.wait(timeout=10)
log.close()
text = open(os.path.join(out, "helios-run.log")).read()
result = {
    "aliveAfterProbeWindow": alive,
    "requests": seen,
    "bootstrapForOurCheckpoint": any(r["path"].endswith("/light_client/bootstrap/" + cp_root) for r in seen),
    "contactedInjectedEnvEndpoints": any(x in text for x in ("127.0.0.1:1/", "127.0.0.1:2")),
    "mentionsPublicDefault": "operationsolarstorm" in text,
    "mentionsFallback": "fallback" in text.lower(),
    "syncFailedLogged": "sync failed" in text,
    "everFreshFinalized": any("status" in s for s in statuses),
    "statuses": statuses[-5:],
}
json.dump(result, open(os.path.join(out, "probe-result.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in result.items() if k not in ("requests", "statuses")}))
ok = result["bootstrapForOurCheckpoint"] and not result["everFreshFinalized"] and not result["mentionsPublicDefault"] \
     and not result["contactedInjectedEnvEndpoints"] and all(r["server"] in ("beacon", "el") for r in seen)
sys.exit(0 if ok else 1)
