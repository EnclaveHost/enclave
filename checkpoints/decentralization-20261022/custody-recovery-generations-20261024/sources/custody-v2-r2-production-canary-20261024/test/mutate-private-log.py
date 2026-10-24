from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
cases=[
('aggregate-cap','private-log.mjs','total+b.length<=LOG_CAP','true'),
('host-generation','private-log.mjs','opened.hostStartTicks===hostStartTicks','true'),
('file-identity','private-log.mjs','before.dev===opened.files?.[name]?.dev&&before.ino===opened.files?.[name]?.ino','true'),
('failed-capture','private-log.mjs',"c.status==='complete'",'true'),
('completion','private-log.mjs',"!requireComplete||status==='complete'",'true'),
('private-mode','private-log.mjs','(s.mode&0o777)===0o600','true'),
('runtime-provenance','launch-runtime.mjs',"privateLogs:inspectCanaryLogs({dir:path.join(bundle,'logs'),hostPid:host.pid,hostStartTicks:host.startTicks})","privateLogs:{status:'open',hostPid:host.pid}"),
]
for name,file,old,new in cases:
 with tempfile.TemporaryDirectory(prefix='custody-log-mut-') as tmp:
  d=Path(tmp);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir()
  for p in ['private-log.test.mjs','launch-runtime.test.mjs']:shutil.copyfile(root/'test'/p,d/'test'/p)
  p=d/'driver'/file;s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  r=subprocess.run(['node','--test','test/private-log.test.mjs','test/launch-runtime.test.mjs'],cwd=d,capture_output=True,text=True,timeout=25)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,(name,r.returncode,r.stdout[-1500:])
  print(name+': detected',flush=True)
print('7/7 log/provenance guard mutations detected; local processes and synthetic runtime fixtures only')
