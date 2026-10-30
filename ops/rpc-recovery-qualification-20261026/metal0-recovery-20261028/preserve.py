import os,stat,json,hashlib,shutil,subprocess,datetime
from pathlib import Path
os.umask(0o077)
base=Path('/home/steven/enclave-prod')
out=base/'metal0-recovery-20261028'
units=['enclave-metal','enclave-guestd','enclave-network-agent','enclave-rpc-production-vm']
for u in units:
 s=subprocess.check_output(['systemctl','--user','show',u,'-p','ActiveState','--value'],text=True).strip()
 assert s in ('inactive','failed'),(u,s)
assert shutil.disk_usage('/').free>850*1024**3
out.mkdir(mode=0o700)
rows=[]
def digest(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 return h.hexdigest()
def copy(src,dst):
 if src.is_dir():
  dst.mkdir(mode=0o700)
  for x in sorted(src.iterdir()):copy(x,dst/x.name)
 else:
  st=src.lstat(); assert stat.S_ISREG(st.st_mode),str(src)
  shutil.copy2(src,dst,follow_symlinks=False)
  assert digest(src)==digest(dst),str(src)
  assert src.stat().st_mtime_ns==st.st_mtime_ns,str(src)
  rows.append({'source':str(src),'copy':str(dst),'bytes':st.st_size,'sha256':digest(dst)})
for tag in ['gdf2432626','gd125fa739']:copy(base/'guestd-root'/tag,out/tag)
settings=out/'settings';settings.mkdir(mode=0o700)
for u in units[:3]:
 src=Path.home()/'.config/systemd/user'/(u+'.service')
 copy(src,settings/src.name)
 d=src.with_name(src.name+'.d')
 if d.exists():copy(d,settings/d.name)
copy(Path('/home/steven/Projects/enclave/metal/config.json'),settings/'metal-config.json')
copy(base/'enclave-network/metal0/config.json',settings/'network-config.json')
pads=Path('/vm/enclave-volumes/metal0-recovery-20261028');pads.mkdir(mode=0o700)
links=[]
for tag,ino,size in [('gdf2432626',148242435,549755813888),('gd125fa739',148242434,206158430208)]:
 src=Path('/vm/enclave-volumes/.shield-pads')/(tag+'.padbank');st=src.lstat()
 assert stat.S_ISREG(st.st_mode) and st.st_dev==64769 and st.st_ino==ino and st.st_size==size
 assert subprocess.run(['fuser',str(src)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==1
 dst=pads/src.name;os.link(src,dst,follow_symlinks=False);after=dst.stat()
 assert (after.st_dev,after.st_ino,after.st_size)==(st.st_dev,st.st_ino,st.st_size)
 links.append({'source':str(src),'preserved':str(dst),'inode':ino,'bytes':size,'links':after.st_nlink})
receipt={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verifiedFiles':len(rows),'verifiedBytes':sum(x['bytes'] for x in rows),'files':rows,'padLinks':links,'limitations':'Pad hardlinks protect unlink only; no old volatile keys recovered. Private settings are not public evidence.'}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='files'},indent=2))
