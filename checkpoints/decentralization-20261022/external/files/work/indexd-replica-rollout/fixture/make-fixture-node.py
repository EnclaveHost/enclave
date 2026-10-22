#!/usr/bin/env python3
"""Create the rollout fixture's indexd node: directories, a 0600 indexd.yml with GENERATED disposable secrets (admin
password, a fresh recovery phrase from the release binary's own 'indexd seed', the fixture PostgreSQL password),
the pre-placed reviewed GeoLite2 database (indexd would otherwise download it), and the replicactl profile.
Prints only paths and booleans, never a secret. Network isolation of the fixture node: syncer on loopback with
bootstrap off and no peers, UPnP off, explorer off, web UI not opened."""
import hashlib
import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parent
node = here / "node"
sec = here / "secrets"
state = node / "state"
for d in (node, state, node / "releases", node / "backups"):
    d.mkdir(parents=True, exist_ok=True)
os.chmod(node / "backups", 0o700)

pg = dict(l.split("=", 1) for l in (sec / "postgres.env").read_text().split() if "=" in l)
admin_pw = secrets.token_urlsafe(24)
(sec / "admin-password").write_text(admin_pw)
os.chmod(sec / "admin-password", 0o600)
out = subprocess.run([str(root / "release" / "indexd-v0.6.0-fence.1-linux-amd64"), "seed"], capture_output=True, text=True, check=True).stdout
phrase = next(l.split(":", 1)[1].strip() for l in out.splitlines() if l.startswith("Recovery Phrase:"))

cfg = f"""autoOpenWebUI: false
directory: {state}
recoveryPhrase: "{phrase}"
adminAPI:
  address: 127.0.0.1:59980
  password: "{admin_pw}"
applicationAPI:
  address: 127.0.0.1:59982
  advertiseURL: http://127.0.0.1:59982
syncer:
  address: 127.0.0.1:59981
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
  port: 55433
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
(sec / "indexd.yml").write_text(cfg)
os.chmod(sec / "indexd.yml", 0o600)
geo = root / "src" / "GeoLite2-City.mmdb"
shutil.copyfile(geo, state / "GeoLite2-City.mmdb")
profile = {
    "runner": "process",
    "pg_container": "enclave-rollout-fixture-pg",
    "database": "indexd",
    "state_dir": str(state),
    "config_file": str(sec / "indexd.yml"),
    "admin_url": "http://127.0.0.1:59980/api",
    "admin_password_file": str(sec / "admin-password"),
    "app_url": "http://127.0.0.1:59982",
    "release_dir": str(node / "releases"),
    "backup_dir": str(node / "backups"),
    "migration_dir": str(root / "migration"),
    "geoip_sha256": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
    "gomemlimit": "320MiB",
}
(here / "fixture-profile.json").write_text(json.dumps(profile, indent=2) + "\n")
print(json.dumps({"config": str(sec / "indexd.yml"), "configMode": oct(os.stat(sec / "indexd.yml").st_mode & 0o777),
                  "profile": str(here / "fixture-profile.json"),
                  "geoipSha256Ok": hashlib.sha256((state / "GeoLite2-City.mmdb").read_bytes()).hexdigest() == profile["geoip_sha256"]}))
