import pathlib,json,subprocess
root=pathlib.Path('/opt/enclave-retained/cc96aad');manifest=root/'manifest.json'
verified_log=pathlib.Path('/var/log/enclave-retained-verification.log')
rows=json.loads(manifest.read_text())['verifiedObjects'];lines=verified_log.read_text().splitlines()
if len(lines)!=len(rows) or json.loads(lines[-1])['verified']!=len(rows):raise RuntimeError('verification is incomplete; keep current service')
config=pathlib.Path('/etc/enclave-bootstrap/config.json');backup=config.with_suffix('.before-retained.json')
if not backup.exists():backup.write_bytes(config.read_bytes())
config.write_text(json.dumps({'directory':str(root),'manifest':str(manifest),'maxObjectBytes':1<<30,'bind':'0.0.0.0','port':8189}))
drop=pathlib.Path('/etc/systemd/system/enclave-bootstrap-gateway.service.d');drop.mkdir(exist_ok=True)
(drop/'retained.conf').write_text('[Service]\nExecStart=\nExecStart=/usr/local/bin/node '+str(root/'server.mjs')+' /etc/enclave-bootstrap/config.json\n')
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
print('activated verified replica manifest',len(rows),flush=True)
