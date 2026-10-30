#!/usr/bin/env python3
"""Archive explicitly named, cold user-owned tmpfs trees to NVMe, preserving original paths atomically.
No active app/VM changes. Root reviews the inventory, then runs --apply. Archives stay for rollback.
"""
import ctypes,hashlib,json,os,shutil,stat,sys,time,uuid
from pathlib import Path
BASE=Path('/vm/enclave-volumes/build-tmp-recovery/20261025')
ROOTS=[Path('/tmp/claude-1000/-home-steven-Projects-enclave/2502245f-8429-4cab-92b0-2cd51aac30e8'),Path('/tmp/enclavedns-aur'),Path('/tmp/urlprobe'),Path('/tmp/go-build314875697'),Path('/tmp/go-build2883938849'),Path('/tmp/go-build3079425436'),Path('/tmp/head-src'),Path('/tmp/rpa-src')]
ROOTS += [Path('/tmp/claude-1000/-home-steven-Projects-enclave/ea984051-2406-474d-8dae-2c2f504ea89d/scratchpad')/n for n in ('dl-jdk','jdk21','mingw')]
OUT=Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/tmpfs-recovery')
UID=os.getuid();DEV=Path('/tmp').stat().st_dev

def snapshot(root,cold=False):
    assert root.is_dir() and not root.is_symlink(),f'not a real directory: {root}'
    result={};total=0
    for path in [root,*sorted(root.rglob('*'))]:
        s=path.lstat();rel=str(path.relative_to(root));kind=stat.S_IFMT(s.st_mode)
        assert s.st_uid==UID,f'foreign owner {path}'
        if cold:assert s.st_dev==DEV and time.time()-s.st_mtime>86400,f'not cold tmpfs: {path}'
        r={'kind':kind,'mode':stat.S_IMODE(s.st_mode),'mtimeNs':s.st_mtime_ns}
        if stat.S_ISREG(s.st_mode):
            assert s.st_nlink==1,f'hardlinked file: {path}'
            h=hashlib.sha256()
            with path.open('rb') as f:
                for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
            after=path.lstat();assert (s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),f'file changed: {path}'
            r.update(bytes=s.st_size,sha256=h.hexdigest());total+=s.st_size
        elif stat.S_ISLNK(s.st_mode):
            target=os.readlink(path)
            if not os.path.isabs(target):assert (path.parent/target).resolve().is_relative_to(root.resolve()),f'external relative link: {path}'
            r['target']=target
        else:assert stat.S_ISDIR(s.st_mode),f'special file: {path}'
        result[rel]=r
    return result,total

def ancestors():
    ids=set();p=os.getpid()
    while p>1:
        ids.add(p)
        try:p=int(Path(f'/proc/{p}/stat').read_text().rsplit(')',1)[1].split()[1])
        except (OSError,ValueError):break
    return ids

def refs(root):
    hits=[];unreadable=0;skip=ancestors();needle=str(root)
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) in skip:continue
        try:
            cmd=(proc/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
            if needle in cmd:hits.append([proc.name,'command mentions path'])
            for f in [proc/'cwd',proc/'exe',*list((proc/'fd').iterdir())]:
                try:
                    v=os.readlink(f)
                    if v==needle or v.startswith(needle+'/'):hits.append([proc.name,str(f)])
                except OSError:pass
            if needle in (proc/'maps').read_text():hits.append([proc.name,'memory map'])
        except (OSError,PermissionError):unreadable+=1
    return hits,unreadable

def exchange(a,b):
    libc=ctypes.CDLL(None,use_errno=True);f=libc.renameat2
    f.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];f.restype=ctypes.c_int
    if f(-100,os.fsencode(a),-100,os.fsencode(b),2):raise OSError(ctypes.get_errno(),'renameat2 exchange failed')

def available():return next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))

def main():
    apply=sys.argv[1:]==['--apply'];assert apply or not sys.argv[1:]
    OUT.mkdir(parents=True,exist_ok=True);report={'apply':apply,'started':time.time(),'availableBeforeKiB':available(),'items':[]}
    if apply:BASE.mkdir(parents=True,exist_ok=True);BASE.chmod(0o700)
    try:
        for root in ROOTS:
            item={'source':str(root)};report['items'].append(item)
            try:
                hits,unknown=refs(root);item.update(references=hits,unreadableProc=unknown)
                assert not hits,'active reference: retained'
                tree,size=snapshot(root,True);item.update(bytes=size,entries=len(tree))
                if not apply:item['status']='eligible';continue
                dest=BASE/root.name;assert not dest.exists(),f'archive already exists: {dest}'
                assert shutil.disk_usage(BASE).free>size+10*1024**3,'destination headroom'
                shutil.copytree(root,dest,symlinks=True,copy_function=shutil.copy2)
                assert snapshot(dest)[0]==tree,'copied content/metadata differs'
                assert snapshot(root,True)[0]==tree,'source changed during copy'
                hits,unknown=refs(root);assert not hits,f'became active: {hits}'
                (BASE/(root.name+'.manifest.json')).write_text(json.dumps(tree,sort_keys=True))
                # sync destination filesystem before replacing the original path
                dfd=os.open(BASE,os.O_RDONLY|os.O_DIRECTORY)
                try:
                    libc=ctypes.CDLL(None,use_errno=True)
                    if libc.syncfs(dfd)!=0:raise OSError(ctypes.get_errno(),'syncfs failed')
                finally:os.close(dfd)
                old=root.parent/('.rpc-tmp-archive-'+uuid.uuid4().hex);old.symlink_to(dest,target_is_directory=True)
                exchange(root,old) # original path is now the archive link; old holds the intact original directory
                try:assert snapshot(old)[0]==tree,'original changed at exchange'
                except BaseException:exchange(root,old);old.unlink();raise
                shutil.rmtree(old) # only verified redundant tmpfs copy; NVMe archive and original path are retained
                item.update(status='archived',destination=str(dest),manifest=str(BASE/(root.name+'.manifest.json')))
            except Exception as e:item.update(status='retained',reason=str(e))
    finally:
        report.update(finished=time.time(),availableAfterKiB=available())
        name=('apply' if apply else 'inventory')+'-'+str(time.time_ns())+'.json';(OUT/name).write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
if __name__=='__main__':main()
