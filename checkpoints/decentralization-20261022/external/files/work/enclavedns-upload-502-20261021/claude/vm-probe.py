import subprocess,json,re,pathlib
def sh(a):
    p=subprocess.run(a,text=True,capture_output=True); return p.stdout
red=lambda s: re.sub(r'(?i)(authorization|password|secret|token|signature|x-amz-[a-z-]+|credential)([=:" ]+)[^\s",]+', r'\1\2<redacted>', s)[:320]
r={}
for u in ['enclave-indexd','enclave-indexd-postgres','caddy']:
    r[u]=dict(x.split('=',1) for x in sh(['systemctl','show',u,'-p','ActiveState','-p','SubState','-p','NRestarts','-p','ActiveEnterTimestamp','-p','MainPID','-p','MemoryCurrent']).splitlines() if '=' in x)
pat=re.compile(r'(?i)error|fail|timeout|timed out|refus|denied|insufficient|no space|5\d\d|panic|context deadline|upload|slab|contract|host')
for u in ['enclave-indexd','caddy']:
    lines=sh(['journalctl','-u',u,'--since','2026-10-21 17:50:00','--until','2026-10-21 18:15:00','-o','short-iso','--no-pager']).splitlines()
    sel=[red(l) for l in lines if pat.search(l)]
    r[u+'Journal']={'lines':len(lines),'matching':len(sel),'last':sel[-40:]}
r['disk']=sh(['df','-h','/var/lib/enclave-indexd','/']).strip()
r['mem']=[x for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.split(':')[0] in ('MemTotal','MemAvailable')]
print(json.dumps(r,indent=1))
