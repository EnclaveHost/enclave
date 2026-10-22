from pathlib import Path
import subprocess,json,datetime
paths=['opt/enclave-predict','opt/nan-relay','opt/enclave-dns','opt/enclave-directory-bridge','opt/enclave-gateway','opt/nan-site','opt/enclave-get','opt/enclave-recovery','usr/bin/node','usr/bin/caddy']
source=['ssh','-o','BatchMode=yes','nan','python3','/var/lib/indexd-migration/stream-control-code.py']
destination=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo tar --zstd -C / -xf - --no-same-owner']
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with open('work/control-vm/transfer-code-errors.log','wb') as errors:
 a=subprocess.Popen(source,stdout=subprocess.PIPE,stderr=errors)
 b=subprocess.Popen(destination,stdin=a.stdout,stdout=subprocess.DEVNULL,stderr=errors);a.stdout.close()
 br=b.wait();ar=a.wait()
 if ar or br: raise SystemExit('Transfer failed; inspect private error log')
report={'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'paths':paths,'servicesStarted':False,'liveAccountStateCopied':False,'contentDeduplicated':True}
Path('outputs/control-vm-code-staging.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
