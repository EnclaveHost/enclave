"""Read three fixed public configuration/source files from the private prepared OS; never execute them."""
from pathlib import Path
import fcntl, hashlib, json, os, sys, tempfile, time
p=Path(__file__).resolve().parent
cfg=json.loads((p/'INPUT.json').read_text())
def sha(path):
    with open(path,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def pins():
    for x in cfg['pins']:assert sha(x['path'])==x['sha256']
pins();assert os.sched_getaffinity(0)=={1}
sys.path.insert(0,str(Path(cfg['product']).parent))
import offline_mask as om
fx=om.OsEffects();image=Path(cfg['image'])
def ident():
    s=image.lstat();return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode&0o777]
before=ident();assert before==cfg['identity'] and not image.is_symlink()
lock=os.open(cfg['lock']['path'],os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
st=os.fstat(lock);assert [st.st_dev,st.st_ino]==cfg['lock']['identity']
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
fd=fx.hold_qemu_locks(str(image),{'device':before[0],'inode':before[1]})
root=Path(tempfile.mkdtemp(prefix='rpc-prepared-read-'));mnt=root/'mnt';mnt.mkdir();raw=mnt/'root'
handles=[];out={'readOnly':True,'files':{},'cleanup':[]}
with (p/'ATTEMPT.json').open('x') as f:json.dump({'time':time.time(),'imageIdentity':before,'temp':str(root)},f)
def register(h):
    handles.append(h)
    (p/'PROCESS.json').write_text(json.dumps({'pid':h['pid'],'start':h['start'],'mount':h['mount']})+'\n')
try:
    opts=f"driver=raw,offset={cfg['offset']},size={cfg['length']},file.driver=qcow2,file.file.driver=file,file.file.filename={image}"
    h=fx.export_start(['/usr/bin/nbdfuse','-r',str(raw),'[','/usr/bin/qemu-nbd','-r','--image-opts',opts,']'],
                      str(mnt),str(raw),cfg['length'],15,1<<20,register,'/usr/bin/fusermount3')
    dbg=om.Debugfs(fx,'/usr/bin/debugfs',str(raw),{'commandSeconds':10,'maxOutputBytes':1<<20},om.Deadline(60,time.monotonic),lambda *a:None)
    for guest,expected in cfg['files'].items():
        meta=dbg.stat(guest);assert meta['type']=='regular' and meta['size']<=1<<20
        data=dbg.cat(guest);assert len(data)==meta['size'];digest=hashlib.sha256(data).hexdigest()
        out['files'][guest]={'sha256':digest,'size':len(data),'matchesLocalReference':digest==expected}
        if guest.endswith('/manifest.json'):
            v=json.loads(data);out['installedBinaryPins']=v['binaries'];out['installedMounts']=v['mounts']
        if guest.endswith('/chain.json'):
            v=json.loads(data);out['checkpointEpoch']=(v.get('checkpoint') or {}).get('epoch');out['baseOriginL1Block']=(v.get('baseBootstrap') or {}).get('l1Block')
    out['cleanup'].append(fx.export_stop(h,'/usr/bin/fusermount3',15,1<<20))
finally:
    for h in handles:
        if not h.get('closed'):out['cleanup'].append(fx.export_force_cleanup(h,'/usr/bin/fusermount3'))
    fx.release(fd);os.close(lock)
    out['imageIdentityUnchanged']=ident()==before
    pins();(p/'RESULT.json').write_text(json.dumps(out,indent=2)+'\n')
assert out['imageIdentityUnchanged'] and all(x['result']=='complete' and not x['survivors'] and not x['mountPresent'] for x in out['cleanup'])
