#!/usr/bin/env python3
"""Guest-root-only, exact-unit-guarded tuning. Never touches snapshots or chain-client units."""
import datetime,hashlib,json,pathlib,subprocess
unit='enclave-rpc-base-snapshot.service'
path=pathlib.Path('/etc/systemd/system')/unit
original=path.read_bytes(); text=original.decode()
assert text.count('--download-concurrency 8')==1, 'unexpected download concurrency'
assert 'MemoryMax=4G' in text and 'MemorySwapMax=0' in text and '--resumable=true' in text
assert '--force' not in text and '--prune-unlisted' not in text
exec_line=next(s for s in text.splitlines() if s.startswith('ExecStart='))
assert '--manifest-url https://mainnet-v2-snapshots.base.org/1792886410/manifest.json' in exec_line
assert '--with-txs-distance 140000 --with-receipts-distance 140000 --with-state-history-distance 140000' in exec_line
assert not pathlib.Path('/srv/enclave-base-holder/snapshot-complete').exists(), 'already completed'
assert subprocess.run(['systemctl','is-active','enclave-base-holder.service'],text=True,capture_output=True).stdout.strip()!='active'
drop=pathlib.Path('/etc/systemd/system')/(unit+'.d')/'30-download-concurrency.conf'
assert not drop.exists(), 'drop-in already exists; review it instead'
backup=pathlib.Path('/root/enclave-rpc-base-download-tuning-20261025');backup.mkdir(mode=0o700)
(backup/'original-unit.service').write_bytes(original)
protected={u:subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip() for u in ['enclave-l1-el.service','enclave-l1-cl.service']}
assert all(int(p)>0 for p in protected.values())
subprocess.run(['systemctl','stop',unit],check=True,timeout=150)
assert subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip()=='0'
assert path.read_bytes()==original
new='[Service]\nExecStart=\n'+exec_line.replace('--download-concurrency 8','--download-concurrency 16')+'\n'
drop.parent.mkdir(exist_ok=True)
with drop.open('x') as f:f.write(new)
subprocess.run(['systemctl','daemon-reload'],check=True)
loaded=subprocess.check_output(['systemctl','show',unit,'-p','ExecStart','-p','MemoryMax','-p','MemorySwapMax'],text=True)
assert '--download-concurrency 16' in loaded and 'MemoryMax=4294967296' in loaded and 'MemorySwapMax=0' in loaded
subprocess.run(['systemctl','start','--no-block',unit],check=True)
for u,p in protected.items():assert subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip()==p, u+' changed'
receipt={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'unitSha256':hashlib.sha256(original).hexdigest(),'dropInSha256':hashlib.sha256(new.encode()).hexdigest(),'concurrencyBefore':8,'concurrencyAfter':16,'memoryMaxBytes':4294967296,'protectedPidsUnchanged':protected,'rollback':'Stop only snapshot service, remove exact 30-download-concurrency.conf after checking its hash, daemon-reload, start snapshot service; never delete partials or use --force.'}
(backup/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2));print(loaded)
