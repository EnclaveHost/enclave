import json,subprocess
from pathlib import Path
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B=Path('/home/steven/Documents/Codex/2026-10-26/my')
i=B/'work/tr004-readonly/enclave-rpc-production/base-origin.qcow2'; v=B/'work/tr004/base-view/nbd'; o=P/'logs/base-journal-copy-1626'
assert 'ro' in subprocess.check_output(['findmnt','-rn','-T',str(i),'-o','OPTIONS'],text=True).strip().split(',')
b=i.stat()
for name,c in [('candidate-inode','stat <1950053>'),('candidate-imap','imap <1950053>'),('fs-stats','stats')]:
 with (o/(name+'.out')).open('xb') as f,(o/(name+'.err')).open('xb') as e:
  r=subprocess.run(['timeout','--kill-after=5','45','debugfs','-R',c,str(v)],stdout=f,stderr=e,timeout=55)
 assert r.returncode==0
 print(name,(o/(name+'.out')).read_text()[:8000])
a=i.stat();assert (b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns)==(a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)
