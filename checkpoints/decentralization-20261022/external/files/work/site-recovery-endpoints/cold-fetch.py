import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parent
cid = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y"
out = Path(tempfile.mkdtemp(prefix="cold-fetch-", dir=ROOT))
cli = ROOT.parent / "enclave/scripts/site-release/cli.mjs"
# A controlled unavailable gateway proves the first origin was tried; the second uses no DNS.
class Unavailable(http.server.BaseHTTPRequestHandler):
    calls = 0
    def do_GET(self):
        Unavailable.calls += 1
        self.send_response(503)
        self.end_headers()
    def log_message(self, *_):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Unavailable)
threading.Thread(target=server.serve_forever, daemon=True).start()
args = ["node", str(cli), "fetch", "--cid", cid, "--gateway",
        f"http://127.0.0.1:{server.server_port},https://146.190.246.39", "--out", str(out), "--as-base"]
try:
    r = subprocess.run(args, capture_output=True, text=True, timeout=240)
finally:
    server.shutdown()
    server.server_close()
if r.returncode:
    raise RuntimeError(r.stderr[-2000:] + r.stdout[-2000:])
assert "from https://146.190.246.39" in r.stdout
assert Unavailable.calls == 1
site = out / cid / "site"
files = [p for p in site.rglob("*") if p.is_file()]
assert len(files) == 716
boot = hashlib.sha256((site / "js/boot.js").read_bytes()).hexdigest()
assert boot == "61737447ede2f0c4453cfd00147d1a1970870eda08c89d439eb6faf6f20a5f0a"
proof = {"cid": cid, "command": args, "exit": r.returncode, "stdout": r.stdout.strip(),
         "freshDirectory": str(out), "files": len(files), "bootSha256": boot,
         "firstGatewayStatus": 503, "firstGatewayRequests": Unavailable.calls,
         "mainGatewayUsed": False, "enclaveDnsUsed": False,
         "scope": "Complete public frontend recovery only; no claim of control/account/storage recovery."}
(ROOT / "cold-fetch.json").write_text(json.dumps(proof, indent=2) + "\n")
print(json.dumps(proof), flush=True)
