from pathlib import Path
import subprocess,json,hashlib,os
base=Path('/var/lib/indexd-migration');report=json.loads((base/'proxy-prepared.json').read_text());live=Path('/etc/caddy/Caddyfile');prepared=base/'Caddyfile.storage-proxy'
assert hashlib.sha256(live.read_bytes()).hexdigest()==report['sourceSHA256'],'Live proxy changed; review before activation'
assert hashlib.sha256(prepared.read_bytes()).hexdigest()==report['preparedSHA256']
tmp=live.with_suffix('.storage.tmp');tmp.write_bytes(prepared.read_bytes());os.chmod(tmp,live.stat().st_mode & 0o777);os.chown(tmp,live.stat().st_uid,live.stat().st_gid);os.replace(tmp,live)
subprocess.run(['systemctl','reload','caddy'],check=True)
print(json.dumps({'proxyActivated':True,'host':'sia.enclave.host','upstream':'TLS through public providers to minipc','oldNanIndexerRestarted':False}))
