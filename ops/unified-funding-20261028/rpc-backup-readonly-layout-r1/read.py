from pathlib import Path
import os,json,hashlib,subprocess,struct,tempfile,time,zlib,uuid,signal
P=Path(__file__).resolve().parent
B=Path('/vm/enclave-volumes/rpc-production-maint/os-backup-20261030T061922Z-1a31c4/os.qcow2')
assert os.sched_getaffinity(0)=={1}
for p,h in json.loads((P/'INPUT-PINS.json').read_text()).items():
 with open(p,'rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==h,p
def ident():
 s=B.lstat();assert not B.is_symlink() and s.st_ino==148392253 and s.st_size==18581159936 and s.st_mode&0o777==0o400
 return {k:getattr(s,k) for k in ['st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode']}
before=ident()
for u in ['enclave-rpc-production-vm.service','enclave-rpc-production-guard.service']:
 r=subprocess.run(['/usr/bin/systemctl','--user','show',u,'-p','MainPID','-p','ActiveState'],capture_output=True,text=True,timeout=5)
 assert r.returncode==0 and 'MainPID=0' in r.stdout and 'ActiveState=inactive' in r.stdout,u
with (P/'ATTEMPT.json').open('x') as f:json.dump({'time':time.time(),'scope':'verified readonly backup GPT/ext4 superblocks only','identity':before},f)
info=subprocess.run(['/usr/bin/qemu-img','info','--output=json',str(B)],capture_output=True,timeout=10,check=True)
i=json.loads(info.stdout);assert i['format']=='qcow2' and not i.get('backing-filename') and not i.get('full-backing-filename')
size=i['virtual-size'];assert 0<size<=64*(1<<30) and size%512==0
t=Path(tempfile.mkdtemp(prefix='rpc-backup-layout-'));mnt=t/'mnt';mnt.mkdir();raw=mnt/'raw'
err=(P/'export.stderr').open('xb');proc=subprocess.Popen(['/usr/bin/nbdfuse','-r',str(raw),'[','/usr/bin/qemu-nbd','-r','-f','qcow2',str(B),']'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=err,start_new_session=True)
(P/'PROCESS.json').write_text(json.dumps({'pid':proc.pid,'temp':str(t)}))
result=None
try:
 deadline=time.monotonic()+10
 while not raw.exists():
  assert proc.poll() is None and time.monotonic()<deadline,'readonly exporter unavailable'
  time.sleep(.1)
 assert raw.stat().st_size==size
 with raw.open('rb') as f:
  def read(off,n):
   assert 0<=off and 0<n<=4*(1<<20) and off+n<=size
   f.seek(off);b=f.read(n);assert len(b)==n;return b
  def header(lba):
   b=bytearray(read(lba*512,512));assert b[:8]==b'EFI PART'
   rev,hs,crc,res=struct.unpack_from('<IIII',b,8);assert rev==0x10000 and 92<=hs<=512 and res==0
   struct.pack_into('<I',b,16,0);assert zlib.crc32(b[:hs])==crc,'header CRC'
   this,other,first,last=struct.unpack_from('<QQQQ',b,24);assert this==lba and first<=last<size//512
   table,n,es,tcrc=struct.unpack_from('<QIII',b,72);assert 0<n<=512 and 128<=es<=4096 and es%128==0
   assert table>0 and (table*512+n*es)<=size
   tb=read(table*512,n*es);assert zlib.crc32(tb)==tcrc,'table CRC'
   return {'this':this,'other':other,'firstUsable':first,'lastUsable':last,'diskGuid':str(uuid.UUID(bytes_le=bytes(b[56:72]))),'tableLba':table,'entries':n,'entrySize':es,'tableSha256':hashlib.sha256(tb).hexdigest()},tb
  a,ta=header(1);b,tb=header(size//512-1)
  assert a['other']==b['this'] and b['other']==a['this'] and ta==tb
  for k in ['firstUsable','lastUsable','diskGuid','entries','entrySize']:assert a[k]==b[k],k
  assert a['tableLba']>1 and a['tableLba']*512+len(ta)<=a['firstUsable']*512
  assert b['tableLba']>b['lastUsable'] and b['tableLba']*512+len(tb)<=b['this']*512
  parts=[]
  for x in range(a['entries']):
   e=ta[x*a['entrySize']:(x+1)*a['entrySize']]
   if e[:16]==b'\0'*16:continue
   start,end=struct.unpack_from('<QQ',e,32);assert a['firstUsable']<=start<=end<=a['lastUsable']
   p={'index':x+1,'type':str(uuid.UUID(bytes_le=e[:16])),'guid':str(uuid.UUID(bytes_le=e[16:32])),'firstLba':start,'lastLba':end,'name':e[56:128].decode('utf-16-le').rstrip('\0')}
   sb=read(start*512+1024,1024)
   if struct.unpack_from('<H',sb,56)[0]==0xef53:
    compat,incompat,ro=struct.unpack_from('<III',sb,92)
    p['ext4']={'uuid':str(uuid.UUID(bytes=sb[104:120])),'label':sb[120:136].rstrip(b'\0').decode(),'state':struct.unpack_from('<H',sb,58)[0],'blockSize':1024<<struct.unpack_from('<I',sb,24)[0],'blocksLo':struct.unpack_from('<I',sb,4)[0],'blocksHi':struct.unpack_from('<I',sb,336)[0],'compat':compat,'incompat':incompat,'roCompat':ro,'needsRecovery':bool(incompat&4),'journalUuid':str(uuid.UUID(bytes=sb[208:224])),'journalDevice':struct.unpack_from('<I',sb,228)[0]}
   parts.append(p)
  ordered=sorted(parts,key=lambda x:x['firstLba']);assert all(x['lastLba']<y['firstLba'] for x,y in zip(ordered,ordered[1:]))
  roots=[x for x in parts if x.get('ext4',{}).get('label')=='cloudimg-rootfs'];assert len(roots)==1
  result={'virtualSize':size,'primary':a,'backup':b,'partitions':parts,'root':roots[0],'scope':'readonly GPT CRC/layout and ext4 superblock; no fsck or image mutation; stat continuity not new full hash'}
finally:
 un=subprocess.run(['/usr/bin/fusermount3','-u',str(mnt)],capture_output=True,timeout=10)
 try:proc.wait(timeout=10)
 except subprocess.TimeoutExpired:
  os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
 err.close()
 assert un.returncode==0 and not os.path.ismount(mnt) and proc.returncode==0,'export cleanup not successful'
assert ident()==before,'backup stat changed'
assert (P/'export.stderr').stat().st_size==0,'export diagnostics require review'
result.update({'backupIdentityUnchanged':True,'exporterGone':not Path('/proc/'+str(proc.pid)).exists()})
with (P/'RESULT.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
print(json.dumps(result))
