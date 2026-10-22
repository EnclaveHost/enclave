"""Remote transaction: compare exact config, verify public files, validate, reload, rollback on failure."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

job = json.load(sys.stdin)
active = Path("/etc/enclave-bootstrap-tls/Caddyfile")
old = active.read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(old) == job["beforeSha256"], "Caddyfile changed since review"
new = job["candidate"].encode()
assert sha(new) == job["candidateSha256"]
for cid, expected in job["sites"].items():
    assert cid.startswith("bafy") and cid.isalnum()
    p = Path("/opt/enclave-site") / cid / "site.car"
    assert p.stat().st_size == expected["bytes"], "CAR size changed"
    digest = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    assert digest.hexdigest() == expected["sha256"], "CAR bytes changed"

backup = active.with_name(f"Caddyfile.before-site-car-{time.time_ns()}")
backup.write_bytes(old)
candidate = active.with_name(f"Caddyfile.site-car-{os.getpid()}")
candidate.write_bytes(new)
candidate.chmod(active.stat().st_mode & 0o777)
caddy = "/usr/local/lib/enclave-caddy/caddy"
validation = subprocess.run([caddy, "validate", "--config", str(candidate), "--adapter", "caddyfile"],
                            capture_output=True, timeout=30)
if validation.returncode:
    raise RuntimeError("Caddy validation failed: " + validation.stderr.decode()[-1800:])
assert active.read_bytes() == old, "Caddyfile changed during validation"
os.replace(candidate, active)
try:
    subprocess.run(["systemctl", "reload", "enclave-bootstrap-tls"], check=True,
                   capture_output=True, timeout=30)
    subprocess.run(["systemctl", "is-active", "--quiet", "enclave-bootstrap-tls"], check=True)
    for cid in job["sites"]:
        # TLS validates the IP certificate; local connection bypasses the provider while retaining SNI.
        response = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--max-time", "15", "--head",
             "--connect-to", f'{job["ip"]}:443:127.0.0.1:28443',
             f'https://{job["ip"]}/ipfs/{cid}?format=car'], capture_output=True, timeout=20)
        assert response.returncode == 0, "local verified TLS CAR HEAD failed"
        assert b"application/vnd.ipld.car" in response.stdout.lower(), "wrong CAR media type"
except Exception:
    assert active.read_bytes() == new, "Concurrent change prevents automatic rollback"
    candidate.write_bytes(old)
    os.replace(candidate, active)
    subprocess.run(["systemctl", "reload", "enclave-bootstrap-tls"], check=True, timeout=30)
    raise
print(json.dumps({"activated": True, "backup": str(backup), "sha256": sha(new),
                  "localTlsCarHeads": len(job["sites"])}))
