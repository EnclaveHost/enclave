from pathlib import Path
import subprocess,json,shlex
p=Path(__file__).resolve().parent
code='''import json,pathlib,hashlib,collections,subprocess
root=pathlib.Path('/var/lib/enclave-maintenance/funding-operator-switch-20261029-r2')
names=['state.json','pre-stop.json','post-stop.json','stop.json','new-identity.json','gate.json','gate-restored.json','funding-config.json']
r={n:json.loads((root/n).read_text()) for n in names}
j=pathlib.Path('/var/lib/private/enclave-relay/sessions-relayer.json').read_bytes();d=json.loads(j)
r['currentJournal']={'sha256':hashlib.sha256(j).hexdigest(),'count':len(d.get('txs',[])),'statuses':dict(collections.Counter(x.get('status','absent') for x in d.get('txs',[])))}
r['gateStatus']=json.loads(subprocess.check_output(['python3','/opt/enclave-funding-staged/maintenance-r1/session_gate.py','status','--op','funding-operator-switch-20261029-r2']))
r['r1PrestopFailure']={'error':(pathlib.Path('/var/lib/enclave-maintenance/funding-operator-switch-20261029-r1/apply.err')).read_text(),'state':json.loads(pathlib.Path('/var/lib/enclave-maintenance/funding-operator-switch-20261029-r1/state.json').read_text())}
print(json.dumps(r))
'''
ssh=['ssh','-J','minipc','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
r=subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=30);assert r.returncode==0,r.stderr
j=json.loads(r.stdout);(p/'production-evidence.json').write_text(json.dumps(j,indent=2)+'\n')
print(json.dumps({'phase':j['state.json']['phase'],'journal':j['currentJournal'],'pre':j['pre-stop.json'],'post':j['post-stop.json'],'gateAbsent':j['gateStatus']['gateAbsent']}))
