from pathlib import Path
import hashlib,json,os,subprocess,tempfile,time,signal
p=Path(__file__).resolve().parent
b=Path('/vm/enclave-volumes/rpc-production-maint/os-backup-20261030T061922Z-1a31c4/os.qcow2')
assert os.sched_getaffinity(0)=={1}
for f,h in json.loads((p/'INPUT-PINS.json').read_text()).items():
 with open(f,'rb') as s:assert hashlib.file_digest(s,'sha256').hexdigest()==h
layout=json.loads((p.parent/'rpc-backup-readonly-layout-r1/RESULT.json').read_text())
r=layout['root'];offset=r['firstLba']*512;length=(r['lastLba']-r['firstLba']+1)*512
st=b.lstat();before=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns);assert st.st_ino==148392253 and st.st_size==18581159936 and st.st_mode&0o777==0o400 and not b.is_symlink()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'time':time.time(),'backupStat':before,'scope':'full read-only e2fsck -fn on verified backup root partition only'},f)
t=Path(tempfile.mkdtemp(prefix='rpc-backup-fsck-'));mnt=t/'mnt';mnt.mkdir();raw=mnt/'root';err=(p/'export.stderr').open('xb')
opts=f'driver=raw,offset={offset},size={length},file.driver=qcow2,file.file.driver=file,file.file.filename={b}'
export=subprocess.Popen(['/usr/bin/nbdfuse','-r',str(raw),'[','/usr/bin/qemu-nbd','-r','--image-opts',opts,']'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=err,start_new_session=True)
(p/'PROCESS.json').write_text(json.dumps({'exportPid':export.pid,'temp':str(t)}))
check=None;rc=None
try:
 end=time.monotonic()+10
 while not raw.exists():
  assert export.poll() is None and time.monotonic()<end
  time.sleep(.1)
 assert raw.stat().st_size==length
 with (p/'fsck.stdout').open('xb') as out,(p/'fsck.stderr').open('xb') as e:
  check=subprocess.Popen(['/usr/bin/e2fsck','-fn',str(raw)],stdin=subprocess.DEVNULL,stdout=out,stderr=e,env={'PATH':'/usr/bin:/bin','LANG':'C'},start_new_session=True)
  end=time.monotonic()+120
  while check.poll() is None:
   assert time.monotonic()<end and out.tell()+e.tell()<1<<20,'fsck deadline/output limit'
   time.sleep(.1)
  rc=check.returncode
finally:
 if check is not None and check.poll() is None:
  os.killpg(check.pid,signal.SIGTERM)
  try:check.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(check.pid,signal.SIGKILL);check.wait(timeout=3)
 un=subprocess.run(['/usr/bin/fusermount3','-u',str(mnt)],capture_output=True,timeout=10)
 try:export.wait(timeout=10)
 except subprocess.TimeoutExpired:
  os.killpg(export.pid,signal.SIGTERM)
  try:export.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(export.pid,signal.SIGKILL);export.wait(timeout=3)
 err.close()
 assert un.returncode==0 and not os.path.ismount(mnt) and export.returncode==0,'export cleanup'
st=b.lstat();assert before==(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
assert (p/'export.stderr').stat().st_size==0
result={'fsckExit':rc,'readOnly':True,'partitionOffset':offset,'partitionLength':length,'backupStatUnchanged':True,'exporterGone':not Path('/proc/'+str(export.pid)).exists(),'scope':'full read-only filesystem check; no repairs, image modification, publication or readiness claim'}
with (p/'RESULT.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
print(json.dumps(result));assert rc==0,'full readonly fsck did not pass'
