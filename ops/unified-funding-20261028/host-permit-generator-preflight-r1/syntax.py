from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
rows=[json.loads(x) for x in (p/'generation.log').read_text().splitlines() if '"file"' in x]
assert len(rows)==5 and all(r['ok'] for r in rows)
rc=0
with (p/'syntax.log').open('x') as f:
 for row in rows:
  src=p/'outputs'/row['file'];assert hashlib.sha256(src.read_bytes()).hexdigest()==row['sha256']
  r=subprocess.run(['node','--check',str(src)],stdout=f,stderr=subprocess.STDOUT,timeout=10)
  f.write(json.dumps({'file':row['file'],'syntaxExit':r.returncode})+'\n');f.flush();rc|=r.returncode
(p/'syntax.rc').write_text(str(rc)+'\n')
raise SystemExit(rc)
