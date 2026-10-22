import subprocess,json,time
from pathlib import Path
m=json.loads(Path('outputs/storage-final-source-snapshot.json').read_text());assert m['sourceFenced'] and not m['sourceResumed']
base=['ssh','-p','32422','-o','BatchMode=yes','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
start=time.monotonic();log=Path('work/private/indexd-recovery/final-transfer.log').open('ab')
src=subprocess.Popen(['ssh','-o','BatchMode=yes','nan','tar -C /var/lib/indexd-migration/final-20261019 -czf - indexd.pgdump consensus.db indexd.yml indexd GeoLite2-City.mmdb counts.json manifest.json'],stdout=subprocess.PIPE,stderr=log)
dst=subprocess.run(base+["sudo sh -c 'umask 077; mkdir /var/lib/enclave-indexd/final-source && tar --no-same-owner -xzf - -C /var/lib/enclave-indexd/final-source'"],stdin=src.stdout,stdout=log,stderr=log)
src.stdout.close();assert src.wait()==0 and dst.returncode==0,'Final transfer failed; source stays fenced'
print(json.dumps({'finalStateTransferred':True,'elapsedSeconds':round(time.monotonic()-start,1)}))
r=subprocess.run(base+['sudo python3 migration/restore-final.py'],capture_output=True,text=True)
if r.returncode:log.write(r.stdout.encode()+r.stderr.encode());raise RuntimeError('Final restore failed; protected diagnostics retained; source stays fenced')
report=json.loads(r.stdout);Path('outputs/storage-final-restore-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
