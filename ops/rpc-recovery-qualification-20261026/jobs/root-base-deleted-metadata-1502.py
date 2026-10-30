import hashlib, importlib.util, json, os, subprocess, tempfile, time
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
i=p/'rpc-memory-recovery-stage/r1/inspect_os_disk.py'
assert hashlib.sha256(i.read_bytes()).hexdigest()=='287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531'
s=importlib.util.spec_from_file_location('inspector',i); I=importlib.util.module_from_spec(s);s.loader.exec_module(I)
m=Path('/home/steven/.local/state/enclave-rpc-production/manifest.json')
assert hashlib.sha256(m.read_bytes()).hexdigest()=='a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'
disk=Path(json.loads(m.read_text())['disks']['base']['path'])
for unit in (*I.VM_UNITS,'enclave-rpc-qual-vm.service'):
 assert I.unit_active(unit) in ('inactive','failed'),unit
assert not I.open_by_others(str(disk))
before=disk.stat(); out=p/'logs/base-deleted-metadata-1502';out.mkdir(mode=0o700)
mnt=tempfile.mkdtemp(prefix='rpc-base-read-'); raw=Path(mnt)/'base.raw';proc=None
record={'readonly':True,'disk':str(disk),'commands':{}}
try:
 proc=subprocess.Popen(['nbdfuse','-r',str(raw),'[','qemu-nbd','-r','-f','qcow2',str(disk),']'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 deadline=time.monotonic()+45
 while not raw.exists() or raw.stat().st_size==0:
  assert time.monotonic()<deadline and proc.poll() in (None,0);time.sleep(.2)
 for name,command in [('superblock','stats'),('root','ls -l /'),('deleted','lsdel')]:
  start=time.monotonic()
  with (out/(name+'.out')).open('wb') as fo, (out/(name+'.err')).open('wb') as fe:
   r=subprocess.run(['timeout','--signal=TERM','--kill-after=5','60','debugfs','-R',command,str(raw)],stdout=fo,stderr=fe,stdin=subprocess.DEVNULL,timeout=70)
  record['commands'][name]={'command':command,'returncode':r.returncode,'elapsed':time.monotonic()-start}
finally:
 r=subprocess.run(['fusermount3','-u',mnt],capture_output=True,timeout=30);record['unmountRc']=r.returncode
 if proc:
  try:proc.wait(timeout=30)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 os.rmdir(mnt)
 after=disk.stat();record['diskUnchanged']=all(getattr(before,k)==getattr(after,k) for k in ('st_size','st_ino','st_mtime_ns','st_ctime_ns'))
 (out/'record.json').write_text(json.dumps(record,indent=2)+'\n')
assert record['diskUnchanged'] and record['unmountRc']==0
print(json.dumps(record,indent=2))
