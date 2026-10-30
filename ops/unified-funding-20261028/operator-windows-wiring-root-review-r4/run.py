from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{1})
m=json.loads((p/'pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
tmp=Path(tempfile.mkdtemp(prefix='ow1-',dir='/home/steven/Documents/Codex/2026-10-18/wo/work'))
os.environ['TMPDIR']=str(tmp);os.environ['TEST_TMPDIR']=str(tmp)
(p/'temp-dir.json').write_text(json.dumps({'path':str(tmp),'owned':True}))
files=[str(p/n) for n in ['retained-root-boundary-v2.test.mjs','retained-root-quarantine.test.mjs','retained-shipped-client.test.mjs','root-installer-boundaries.test.mjs','root-powershell-bounds.test.mjs','root-trust-inputs.test.mjs']]+[str(p/'candidate/test/windows-permit'/n) for n in ['od-r1-operator-effects-store.test.mjs','od-r1-direct-sender.test.mjs','od-r1-sponsored.test.mjs','od-r2-direct-continuity.test.mjs','ow-r1-operator-windows-wiring.test.mjs','ow-r4-system-identity.test.mjs']]
try:
 with (p/'result.tap').open('x') as f:
  r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=180 --import "$1"/test-liveness.mjs --test --experimental-test-isolation=process --test-concurrency=1 --test-timeout=180000 "${@:2}"','owned-ow1',str(p),*files],stdout=f,stderr=subprocess.STDOUT,timeout=250)
 check();(p/'result.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)
