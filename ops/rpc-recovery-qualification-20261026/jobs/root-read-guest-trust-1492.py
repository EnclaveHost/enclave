import hashlib,importlib.util,json,os,subprocess,tempfile,time
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
i=p/'rpc-memory-recovery-stage/r1/inspect_os_disk.py';assert hashlib.sha256(i.read_bytes()).hexdigest()=='287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531'
s=importlib.util.spec_from_file_location('inspect_pinned',i);I=importlib.util.module_from_spec(s);s.loader.exec_module(I)
m=Path('/home/steven/.local/state/enclave-rpc-production/manifest.json');assert hashlib.sha256(m.read_bytes()).hexdigest()=='a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'
osd=Path(json.loads(m.read_text())['disks']['os']['path'])
for u in (*I.VM_UNITS,'enclave-rpc-qual-vm.service'):
 assert I.unit_active(u) in ('inactive','failed'),u
assert not I.open_by_others(str(osd))
before=osd.stat();out=p/'logs/guest-trust-1492';out.mkdir(mode=0o700)
mnt=tempfile.mkdtemp(prefix='rpc-trust-read-');raw=Path(mnt)/'os.raw';proc=None;rec={'readonly':True,'osDisk':str(osd),'files':{}}
try:
 proc=subprocess.Popen(['nbdfuse','-r',str(raw),'[','qemu-nbd','-r','-f','qcow2',str(osd),']'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 end=time.monotonic()+60
 while not raw.exists() or raw.stat().st_size==0:
  assert time.monotonic()<end and proc.poll() in (None,0),'read-only mapping unavailable';time.sleep(.2)
 off,part=I.root_offset(str(raw));dev=f'{raw}?offset={off}'
 for src,name in [('/usr/share/keyrings/ubuntu-archive-keyring.gpg','ubuntu-archive-keyring.gpg'),('/etc/apt/sources.list.d/ubuntu.sources','ubuntu.sources'),('/usr/lib/os-release','os-release'),('/etc/fstab','fstab')]:
  rc,b=I.debugfs(dev,f'cat {src}');assert rc==0 and 0<len(b)<1048576,(src,rc,len(b))
  (out/name).write_bytes(b);rec['files'][name]={'path':src,'size':len(b),'sha256':hashlib.sha256(b).hexdigest()}
finally:
 r=subprocess.run(['fusermount3','-u',mnt],capture_output=True,timeout=30);rec['unmountRc']=r.returncode
 if proc:
  try:proc.wait(timeout=30)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 os.rmdir(mnt)
after=osd.stat();rec['osUnchanged']=all(getattr(before,k)==getattr(after,k) for k in ('st_size','st_ino','st_mtime_ns','st_ctime_ns'));assert rec['osUnchanged'] and rec['unmountRc']==0
(out/'record.json').write_text(json.dumps(rec,indent=1)+'\n');print(json.dumps(rec,indent=1))
