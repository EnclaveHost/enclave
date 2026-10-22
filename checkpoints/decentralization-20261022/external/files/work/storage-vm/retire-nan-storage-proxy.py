from pathlib import Path
import subprocess, hashlib, json, os, datetime

live = Path('/etc/caddy/Caddyfile')
base = Path('/var/lib/indexd-migration')
source = live.read_text()
expected = json.loads((base/'proxy-prepared.json').read_text())['preparedSHA256']
assert hashlib.sha256(source.encode()).hexdigest() == expected, 'Caddy changed; inspect before replacing'
start = source.index('sia.enclave.host {')
depth = 0
end = None
for pos in range(source.index('{', start), len(source)):
    if source[pos] == '{': depth += 1
    elif source[pos] == '}':
        depth -= 1
        if depth == 0:
            end = pos + 1
            break
assert end and 'reverse_proxy https://134.199.235.187' in source[start:end]
replacement = 'sia.enclave.host {\n    respond "Storage endpoint moved; refresh DNS" 503\n}'
prepared = source[:start] + replacement + source[end:]
backup = base/'Caddyfile.before-storage-proxy-retirement'
assert not backup.exists(), 'Retirement already attempted; inspect existing state'
backup.write_text(source); backup.chmod(0o600)
candidate = base/'Caddyfile.storage-proxy-retired'
candidate.write_text(prepared); candidate.chmod(0o600)
check = subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'], capture_output=True)
assert check.returncode == 0, 'Caddy validation failed'
new_hash = hashlib.sha256(prepared.encode()).hexdigest()
rollback = base/'restore-storage-proxy.py'
rollback.write_text('from pathlib import Path\nimport hashlib,subprocess\np=Path("/etc/caddy/Caddyfile")\n'
    +f'assert hashlib.sha256(p.read_bytes()).hexdigest()=="{new_hash}", "Caddy changed; manual review required"\n'
    +'p.write_bytes(Path("/var/lib/indexd-migration/Caddyfile.before-storage-proxy-retirement").read_bytes())\n'
    +'subprocess.run(["systemctl","reload","caddy"],check=True)\n')
rollback.chmod(0o600)
subprocess.run(['systemd-run','--unit=enclave-storage-proxy-rollback','--on-active=15m','/usr/bin/python3',str(rollback)],check=True,capture_output=True)
tmp=live.with_suffix('.retire.tmp'); tmp.write_text(prepared)
os.chmod(tmp,live.stat().st_mode & 0o777); os.chown(tmp,live.stat().st_uid,live.stat().st_gid);os.replace(tmp,live)
subprocess.run(['systemctl','reload','caddy'],check=True)
print(json.dumps({'changedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'nanStorageProxyDisabled':True,'oldRouteHTTP':503,'automaticRollbackMinutes':15,'beforeSHA256':expected,'afterSHA256':new_hash,'otherCaddyRoutesUnchanged':True}))
