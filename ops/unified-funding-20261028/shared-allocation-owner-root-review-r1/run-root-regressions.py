from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
d=Path('/home/steven/Documents/Codex/2026-10-23/it/work/shared-allocation-owner-r1-20261029')
os.sched_setaffinity(0,{1})
manifest=d/'author-delivery-manifest.json'
assert hashlib.sha256(manifest.read_bytes()).hexdigest()=='24f8045f5f3737453171a7c3379d65db596c319e6da7b0a8a9f46113b23351c1'
m=json.loads(manifest.read_text());assert len(m)==261
source=d/'author-delivery'
def check():
 for n,h in m.items():assert hashlib.sha256((source/n).read_bytes()).hexdigest()==h,n
 assert hashlib.sha256((p/'root-qualification-retention.test.mjs').read_bytes()).hexdigest()=='4325f079c715001d5683b3b18dbced84ec2fbfc41b2687dc4617abb879cfcd9a'
check()
tmp=Path(tempfile.mkdtemp(prefix='allocation-root-regression-',dir='/home/steven/Documents/Codex/2026-10-18/wo/work'))
os.environ.update(TMPDIR=str(tmp),TEST_TMPDIR=str(tmp),ALLOCATION_CANDIDATE_ROOT=str(source))
(p/'root-temp.json').write_text(json.dumps({'path':str(tmp),'owned':True}))
try:
 with (p/'root-original.tap').open('x') as f:
  r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=180 --test --experimental-test-isolation=process --test-concurrency=1 --test-timeout=30000 "$1"','allocation-root-regressions',str(p/'root-qualification-retention.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=60)
 check();(p/'root-original.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'root-remaining-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)
