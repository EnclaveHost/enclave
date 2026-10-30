from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{1})
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as s:
  while b:=s.read(1048576):h.update(b)
 return h.hexdigest()
def check():
 for n,h in json.loads((p/'pins.json').read_text()).items():assert sha(p/n)==h,n
 for n,h in json.loads((p/'external-pins.json').read_text()).items():assert sha(n)==h,n
 for n,target in json.loads((p/'dependency-symlinks.json').read_text()).items():assert str(Path(n).resolve())==target,n
 assert os.sched_getaffinity(0)=={1}
check()
assert not (p/'result.tap').exists(),'single-use: prior result exists'
avail=next(int(l.split()[1])//1024 for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
assert avail>=27648,'pre-start host floor'
files=[str(p/n) for n in json.loads((p/'test-files.json').read_text())]
tmp=Path(tempfile.mkdtemp(prefix='shared-alloc-test-',dir=str(p)))
(p/'temp-dir.json').write_text(json.dumps({'path':str(tmp),'owned':True}))
env=dict(os.environ,TMPDIR=str(tmp),TEST_TMPDIR=str(tmp),PATH='/usr/sbin:/usr/bin:/sbin:/bin')
for k in ['NODE_OPTIONS','NODE_PATH','ENCLAVE_DERIVE_VECTORS']:env.pop(k,None)
rc=1
try:
 with (p/'result.tap').open('x') as f:
  r=subprocess.run(['/usr/sbin/unshare','-Urn','/usr/sbin/bash','-c','/usr/sbin/ip link set lo up && exec /usr/sbin/node --max-old-space-size=180 --import "$1"/test-liveness.mjs --test --experimental-test-isolation=process --test-concurrency=1 --test-timeout=180000 "${@:2}"','shared-alloc-tests',str(p),*files],stdout=f,stderr=subprocess.STDOUT,timeout=300,env=env)
  rc=r.returncode
 check()
 (p/'result.rc').write_text(str(rc)+'\n')
finally:
 (p/'remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(rc)
