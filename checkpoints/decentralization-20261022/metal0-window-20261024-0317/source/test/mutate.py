from pathlib import Path
import subprocess,tempfile,shutil
root=Path(__file__).resolve().parents[1]
mutants=[('approval',"a.humanApproved===true","true"),('expiry',"now<LIMIT.expiresAt","true"),('scope',"a.maxPerApp===1","true"),('ambiguity',"need(fs.existsSync(path.join(dir,id+'.intent.json'))===fs.existsSync(path.join(dir,id+'.result.json')),'ambiguous or incomplete extension attempt; reconcile, never re-sign')","need(true,'ambiguous or incomplete extension attempt; reconcile, never re-sign')"),('charge',"BigInt(r.lease.maxChargeWei)<=BigInt(LIMIT.maxChargeWei)","true"),('lease-extension',"Number(after.leaseUntil)>Number(lease.leaseUntil)","true")]
for name,a,b in mutants:
 with tempfile.TemporaryDirectory(prefix='window-mutant-') as t:
  d=Path(t);(d/'test').mkdir();shutil.copy2(root/'test/window.test.mjs',d/'test/window.test.mjs');s=(root/'window.mjs').read_text();assert s.count(a)==1,name;(d/'window.mjs').write_text(s.replace(a,b))
  r=subprocess.run(['node','--test','test/window.test.mjs'],cwd=d,capture_output=True,text=True,timeout=20)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'SyntaxError' not in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout,name+': survived or invalid failure\n'+r.stdout[-2000:]
  print(name+': detected',flush=True)
print('6/6 weakened controls detected; no production effects')
