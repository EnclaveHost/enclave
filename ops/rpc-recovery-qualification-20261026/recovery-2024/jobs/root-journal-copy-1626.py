"""Read existing read-only NBD view; preserve a bounded journal copy locally.
No mounts, repairs, source writes, process control or database extraction.
"""
import hashlib, json, os, pathlib, shutil, subprocess, time
P = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B = pathlib.Path('/home/steven/Documents/Codex/2026-10-26/my')
image = B / 'work/tr004-readonly/enclave-rpc-production/base-origin.qcow2'
view = B / 'work/tr004/base-view/nbd'
out = P / 'logs/base-journal-copy-1626'
assert not out.exists()
assert shutil.disk_usage(P).free > 200 * 1024**3, 'local capacity floor'
mount = subprocess.check_output(['findmnt','-rn','-T',str(image),'-o','OPTIONS'], text=True).strip()
assert 'ro' in mount.split(','), mount
for pid, required in [(2253790, ('nbdfuse','-r')), (2253798, ('qemu-nbd','--read-only','--format=qcow2'))]:
    args = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    assert all(x.encode() in args for x in required), (pid,args)
    if pid == 2253790:
        assert pathlib.Path(f'/proc/{pid}/cwd').resolve() == B
fd = pathlib.Path('/proc/2253798/fd/10')
assert fd.resolve() == image
info = pathlib.Path('/proc/2253798/fdinfo/10').read_text()
flags = int(next(x.split()[1] for x in info.splitlines() if x.startswith('flags:')),8)
assert flags & os.O_ACCMODE == os.O_RDONLY
assert view.is_file()
before = image.stat()
out.mkdir(mode=0o700)
record = {'readOnly':True, 'source':str(image),'view':str(view),'started':time.time(),'commands':{}}
commands = [('superblock','logdump -S'),('journal-inode','stat <8>'),('db-inode','stat <1949710>'),('db-blocks','blocks <1949710>'),('dump',f'dump <8> {out}/journal-8.bin')]
try:
    for name, command in commands:
        with (out/(name+'.out')).open('xb') as fo, (out/(name+'.err')).open('xb') as fe:
            r = subprocess.run(['prlimit','--fsize=1074790400:1074790400','timeout','--kill-after=5','180','debugfs','-R',command,str(view)], stdin=subprocess.DEVNULL,stdout=fo,stderr=fe,timeout=190)
        record['commands'][name]={'rc':r.returncode,'command':command}
        assert r.returncode == 0, name
    j=out/'journal-8.bin'
    assert j.stat().st_size == 1073741824
    h=hashlib.sha256()
    with j.open('rb') as f:
        while b:=f.read(1024*1024): h.update(b)
    record['journalSha256']=h.hexdigest()
    record['journalBytes']=j.stat().st_size
finally:
    after=image.stat()
    record['sourceUnchanged']=all(getattr(before,k)==getattr(after,k) for k in ('st_ino','st_size','st_mtime_ns','st_ctime_ns'))
    record['finished']=time.time()
    (out/'record.json').write_text(json.dumps(record,indent=2)+'\n')
assert record['sourceUnchanged']
print(json.dumps(record,indent=2))
