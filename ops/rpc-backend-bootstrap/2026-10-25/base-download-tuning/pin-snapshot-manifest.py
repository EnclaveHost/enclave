#!/usr/bin/env python3
"""Guest-root-only pin of the exact Base download manifest; preserves all download/client limits."""
import datetime,hashlib,json,pathlib,subprocess,os
sha='1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
raw=pathlib.Path('/tmp/base-1792886410-manifest.json').read_bytes();assert hashlib.sha256(raw).hexdigest()==sha
doc=json.loads(raw);assert (doc['block'],doc['chain_id'],doc['storage_version'],doc['base_url'])==(53048526,8453,2,'https://mainnet-v2-snapshots.base.org')
unit='enclave-rpc-base-snapshot.service'
drop=pathlib.Path('/etc/systemd/system')/(unit+'.d')/'30-download-concurrency.conf'
old=drop.read_bytes();assert hashlib.sha256(old).hexdigest()=='d2fc22dba1f055fce33b02ef6368c15b5d10707fa2a5ae87dc4701752c543b52'
source='--manifest-url https://mainnet-v2-snapshots.base.org/1792886410/manifest.json';assert old.decode().count(source)==1
assert not pathlib.Path('/srv/enclave-base-holder/snapshot-complete').exists()
protected={u:subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip() for u in ['enclave-l1-el.service','enclave-l1-cl.service']};assert all(int(p)>0 for p in protected.values())
p=pathlib.Path('/opt/enclave-rpc/snapshots/base-1792886410-manifest.json');assert not p.exists()
p.parent.mkdir(mode=0o755,exist_ok=True)
with p.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
p.chmod(0o644);assert p.stat().st_uid==0
backup=pathlib.Path('/root/enclave-rpc-base-download-tuning-20261025')
with (backup/'dropin-before-manifest-pin.conf').open('xb') as f:f.write(old)
subprocess.run(['systemctl','stop',unit],check=True,timeout=150)
assert subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip()=='0'
assert drop.read_bytes()==old
new=old.decode().replace(source,'--manifest-path '+str(p));drop.write_text(new)
subprocess.run(['systemctl','daemon-reload'],check=True)
loaded=subprocess.check_output(['systemctl','show',unit,'-p','ExecStart','-p','MemoryMax','-p','MemorySwapMax'],text=True)
assert '--manifest-path '+str(p) in loaded and '--download-concurrency 16' in loaded and 'MemoryMax=4294967296' in loaded and 'MemorySwapMax=0' in loaded
subprocess.run(['systemctl','start','--no-block',unit],check=True)
for u,pid in protected.items():assert subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip()==pid
receipt={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'snapshotManifestSha256':sha,'snapshotManifestBytes':len(raw),'snapshotManifestPath':str(p),'newDropInSha256':hashlib.sha256(new.encode()).hexdigest(),'protectedPidsUnchanged':protected,'note':'Client now consumes these exact root-owned manifest bytes and re-verifies reusable outputs. This is metadata identity, not chain authentication or snapshot completion.'}
(backup/'manifest-pin-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2));print(loaded)
