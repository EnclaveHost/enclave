from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
cases=[
 ('missing-is-not-fresh','capture-host-copy.mjs','if(recoveryState)return send(200,recoveryState.read(),','if(false&&recoveryState)return send(200,recoveryState.read(),','recovery-host.test.mjs'),
 ('no-early-put','capture-host-copy.mjs','if(recoveryState)recoveryState.requireRead();','if(false)recoveryState.requireRead();','recovery-host.test.mjs'),
 ('no-submit','capture-host-copy.mjs',"if(recoveryState)return send(503,{error:'recovery_submit_disabled'});","if(false)return send(503,{error:'recovery_submit_disabled'});",'recovery-host.test.mjs'),
 ('fault-mode','capture-host-copy.mjs','if(recoveryState&&cfg.canaryRecoveryFault===','if(false&&cfg.canaryRecoveryFault===','recovery-host.test.mjs'),
 ('sealed-hash','recovery-state.mjs','sha256hex(bytes)===expected.sha256','true','recovery-state.test.mjs'),
 ('genesis-disabled','launch-bundle.mjs','genesis:!recovery','genesis:true','launch-bundle.test.mjs'),
 ('single-successor','launch-runtime.mjs',"if(v.recovery)save(path.join(v.recovery.previous.runtimeDir,'successor.json')","if(false)save(path.join(v.recovery.previous.runtimeDir,'successor.json')",'launch-runtime.test.mjs'),
 ('predecessor-recheck','recovery-runtime.mjs','matchStopped(recovery,inspectStopped({...prev,io}));','void 0;','recovery-runtime.test.mjs'),
 ('same-committee','recovery-runtime.mjs','r.evidence?.deploymentId===committeeId','true','recovery-runtime.test.mjs'),
 ('recovered-identity','recovery-runtime.mjs',"['identity','encKey','endpoint'].every(k=>g[k]===q?.[k])",'true','recovery-runtime.test.mjs'),
 ('recovered-generation','recovery-runtime.mjs',"['unit','invocation','bundleDigest','hostPid','guestPid'].every(k=>after[k]===prior[k])",'true','recovery-runtime.test.mjs'),
 ('recovery-deadline','recovery-runtime.mjs','now()-began<=120000','true','recovery-runtime.test.mjs'),
]
for name,file,old,new,target in cases:
 with tempfile.TemporaryDirectory(prefix='custody-recovery-mut-') as tmp:
  d=Path(tmp);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copyfile(root/'test'/target,d/'test'/target)
  p=d/'driver'/file;s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  r=subprocess.run(['node','--test','--test-force-exit',str(Path('test')/target)],cwd=d,capture_output=True,text=True,timeout=40)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,(name,r.returncode,r.stdout[-2000:],r.stderr[-500:])
  print(name+': detected',flush=True)
print('12/12 recovery guard mutations detected; HTTP and filesystem checks plus synthetic runtime/chain fixtures, not production SNP recovery')
