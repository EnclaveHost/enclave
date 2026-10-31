from pathlib import Path
import subprocess,json,hashlib,time,shlex,os
p=Path(__file__).resolve().parent;rows=json.loads((p/'INPUTS.json').read_text())
(p/'ATTEMPT.json').write_text(json.dumps({'time':time.time(),'newFilesOnly':True})+'\n')
argv=json.loads((p/'SSH.json').read_text())+[shlex.join(json.loads((p/'REMOTE.json').read_text()))]
with (p/'stdout.txt').open('xb') as out,(p/'stderr.txt').open('xb') as err:
 proc=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=out,stderr=err)
 try:
  for row in rows:
   source=Path(row['path']);before=source.stat();h=hashlib.sha256()
   with source.open('rb') as f:
    while b:=f.read(1024**2):proc.stdin.write(b);h.update(b)
   after=source.stat();assert h.hexdigest()==row['sha256'];assert (before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns)
  proc.stdin.close();rc=proc.wait(timeout=170)
 finally:
  if proc.poll() is None:proc.kill();proc.wait()
(p/'RESULT.json').write_text(json.dumps({'exit':rc,'sourceInputsUnchanged':True,'remote':json.loads((p/'stdout.txt').read_text()) if rc==0 else None})+'\n')
raise SystemExit(rc)
