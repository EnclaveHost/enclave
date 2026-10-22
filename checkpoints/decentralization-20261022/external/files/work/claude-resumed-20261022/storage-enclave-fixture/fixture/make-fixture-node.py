#!/usr/bin/env python3
"""storage-enclave-fixture copy of indexd-c2-implementation/package/fixture/make-fixture-node.py. The config text and
the secrets handling are unchanged. Only these come from the runner (env) instead of being fixed:
- the per-run stage (node/, secrets/, fixture-profile.json);
- the loopback ports (admin, syncer, app) and the PostgreSQL host port of this run's own container;
- the container name;
- the pinned fence-enclave binary used for 'indexd seed';
- the pinned GeoLite2 file and the migration_dir.
Create the fixture indexd node: directories, and a 0600 indexd.yml with GENERATED disposable secrets:
- the admin password;
- a fresh recovery phrase from the release binary's own 'indexd seed' (no live seed is copied);
- the fixture PostgreSQL password.
Also the pre-placed reviewed GeoLite2 database (indexd would otherwise download it), and the replicactl profile.
Prints only paths and booleans, never a secret.
Network isolation of the fixture node: every listener on 127.0.0.1; syncer bootstrap off and no peers; UPnP off; explorer off;
web UI not opened.
The config sets NO contract/funding/timeout key, so the binaries' compiled enclave-small defaults apply unchanged."""
import hashlib
import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path

E = os.environ
stage = Path(E["C2FX_STAGE"])
admin_port, syncer_port, app_port = (int(x) for x in E["C2FX_PORTS"].split(","))
pg_port, pg_container = int(E["C2FX_PG_PORT"]), E["C2FX_PG_CONTAINER"]
fence, geo, migration_dir = Path(E["C2FX_FENCE"]), Path(E["C2FX_GEOIP"]), Path(E["C2FX_MIGRATION_DIR"])
node = stage / "node"
sec = stage / "secrets"
state = node / "state"
for d in (node, state, node / "releases", node / "backups"):
    d.mkdir(parents=True, exist_ok=False, mode=0o700)
os.chmod(node / "backups", 0o700)

pg = dict(l.split("=", 1) for l in (sec / "postgres.env").read_text().split() if "=" in l)
admin_pw = secrets.token_urlsafe(24)
fd = os.open(sec / "admin-password", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(admin_pw)
out = subprocess.run([str(fence), "seed"], capture_output=True, text=True, check=True, timeout=60, stdin=subprocess.DEVNULL).stdout
phrase = next(l.split(":", 1)[1].strip() for l in out.splitlines() if l.startswith("Recovery Phrase:"))

cfg = f"""autoOpenWebUI: false
directory: {state}
recoveryPhrase: "{phrase}"
adminAPI:
  address: 127.0.0.1:{admin_port}
  password: "{admin_pw}"
applicationAPI:
  address: 127.0.0.1:{app_port}
  advertiseURL: http://127.0.0.1:{app_port}
syncer:
  address: 127.0.0.1:{syncer_port}
  bootstrap: false
  enableUPnP: false
  peers: []
consensus:
  network: mainnet
explorer:
  enabled: false
  url: ""
database:
  host: 127.0.0.1
  port: {pg_port}
  user: "{pg['POSTGRES_USER']}"
  password: "{pg['POSTGRES_PASSWORD']}"
  database: indexd
  sslmode: disable
log:
  stdout:
    enabled: true
    level: info
    format: json
  file:
    enabled: false
"""
fd = os.open(sec / "indexd.yml", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(cfg)
shutil.copyfile(geo, state / "GeoLite2-City.mmdb")
profile = {
    "runner": "process",
    "pg_container": pg_container,
    "database": "indexd",
    "state_dir": str(state),
    "config_file": str(sec / "indexd.yml"),
    "admin_url": f"http://127.0.0.1:{admin_port}/api",
    "admin_password_file": str(sec / "admin-password"),
    "app_url": f"http://127.0.0.1:{app_port}",
    "release_dir": str(node / "releases"),
    "backup_dir": str(node / "backups"),
    "migration_dir": str(migration_dir),
    "geoip_sha256": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
    "gomemlimit": "320MiB",
}
(stage / "fixture-profile.json").write_text(json.dumps(profile, indent=2) + "\n")
print(json.dumps({"config": str(sec / "indexd.yml"), "configMode": oct(os.stat(sec / "indexd.yml").st_mode & 0o777),
                  "profile": str(stage / "fixture-profile.json"),
                  "geoipSha256Ok": hashlib.sha256((state / "GeoLite2-City.mmdb").read_bytes()).hexdigest() == profile["geoip_sha256"]}))
