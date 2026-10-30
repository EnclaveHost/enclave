import json, os, pathlib, sys, time
P=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B=P.parent.parent/'outputs/rpc-production-final-20261025/base-multipart-production-20261026'
a=json.loads((B/'admission.json').read_text())
checks={}
for k,p in a['targets'].items():
 s=os.statvfs(p); free=s.f_bavail*s.f_frsize; q=a['admission'][k]
 needed=q['logicalReservationBytes']+q['floorBytes']+q['externalReservationBytes']
 checks[k]={'free':free,'needed':needed,'margin':free-needed}
 if free<needed: raise SystemExit('capacity refusal '+k)
r={'atEpoch':time.time(),'checks':checks,'parts':'0-0'}
(B/'canary-copy-admission.json').write_text(json.dumps(r,indent=2)+'\n')
os.chdir(P)
os.execvp('bash',['bash','recovery-multipart-stage/r3/jobs/root-preservation.sh',str(B/'copy-request.json'),(B/'copy-request.sha256').read_text().strip(),str(B/'manifest.json'),(B/'manifest.sha256').read_text().strip(),'copy','0-0'])
