import hashlib, json, os, pathlib, time
P=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B=P.parent.parent/'outputs/rpc-production-final-20261025/base-multipart-production-20261026'
for n in ['rmp-r3-canary-copy-1758','rmp-r3-canary-verify-1761']:
 if (P/'logs'/f'{n}.rc').read_text().strip()!='0': raise SystemExit('canary not successful')
a=json.loads((B/'admission.json').read_text());checks={}
p0=pathlib.Path(a['targets']['root'])/'part-0000.bin'
s=p0.lstat(); rec=json.loads(p0.with_suffix('.json').read_text())
ident={'ctimeNs':s.st_ctime_ns,'dev':s.st_dev,'ino':s.st_ino,'mtimeNs':s.st_mtime_ns,'nlink':s.st_nlink,'size':s.st_size}
if ident!=rec['destIdentity'] or s.st_size!=4294967296: raise SystemExit('verified part0 changed')
for k,p in a['targets'].items():
 s=os.statvfs(p); free=s.f_bavail*s.f_frsize; q=a['admission'][k]
 remaining=q['logicalReservationBytes']-(4294967296 if k=='root' else 0)
 needed=remaining+q['floorBytes']+q['externalReservationBytes']
 checks[k]={'free':free,'remainingReservation':remaining,'needed':needed,'margin':free-needed}
 if free<needed: raise SystemExit('capacity refusal '+k)
r={'atEpoch':time.time(),'checks':checks,'parts':'1-8','canaryJobsConfirmed':True}
(B/'bulk-copy-admission.json').write_text(json.dumps(r,indent=2)+'\n')
os.chdir(P)
os.execvp('bash',['bash','recovery-multipart-stage/r3/jobs/root-preservation.sh',str(B/'copy-request.json'),(B/'copy-request.sha256').read_text().strip(),str(B/'manifest.json'),(B/'manifest.sha256').read_text().strip(),'copy','1-8'])
