"""Bounded FD-anchored metadata-only ownership migration of a PRIVATE COW.
No mutation on import. Root parent stays 0700 until caller verifies completion.
"""
import os, stat, time, json, hashlib

def remap_tree(root, old, new, ledger=None, tick=lambda:None, seconds=60):
    deadline=time.monotonic()+seconds
    records={};count=0;encoded=0;device=None
    def budget():
        tick()
        if time.monotonic()>=deadline:raise RuntimeError('ownership-time-bound')
    def metadata(fd):
        s=os.fstat(fd)
        if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):raise RuntimeError('ownership-file-type')
        if s.st_mode & 0o6022:raise RuntimeError('ownership-privilege-or-write-mode')
        if stat.S_ISREG(s.st_mode) and s.st_nlink!=1:raise RuntimeError('ownership-hardlink')
        names=os.listxattr(fd)
        if len(names)>16:raise RuntimeError('ownership-xattr-count')
        attrs={};total=0
        for name in names:
            if name.startswith(('system.posix_acl_','security.','trusted.')):raise RuntimeError('ownership-privileged-xattr')
            value=os.getxattr(fd,name);total+=len(value)+len(name)
            if total>4096:raise RuntimeError('ownership-xattr-bound')
            attrs[name]=hashlib.sha256(value).hexdigest()
        return [s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_nlink,attrs]
    def walk(parent,name,rel,depth):
        nonlocal count,encoded,device
        budget()
        if depth>32:raise RuntimeError('ownership-depth')
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=parent)
        try:
            row=metadata(fd);budget()
            if device is None:device=row[0]
            if row[0]!=device:raise RuntimeError('ownership-cross-device')
            count+=1;encoded+=len(json.dumps([rel,row],separators=(',',':')).encode())
            if count>20000 or encoded>3<<20:raise RuntimeError('ownership-ledger-bound')
            expected=ledger.get(rel) if ledger is not None else None
            if ledger is None:
                if tuple(row[3:5])!=old:raise RuntimeError('ownership-source-identity')
            else:
                if expected!=row:raise RuntimeError('ownership-preflight-drift')
                budget();os.fchown(fd,*new)
                after=metadata(fd);want=list(row);want[3:5]=list(new)
                if after!=want:raise RuntimeError('ownership-metadata-changed')
                row=after
            records[rel]=row
            if stat.S_ISDIR(row[2]):
                seen=set()
                with os.scandir(fd) as entries:
                    for entry in entries:
                        budget();n=entry.name
                        if n in seen or len(n.encode())>255:raise RuntimeError('ownership-entry-name')
                        seen.add(n)
                        if len(seen)>20000:raise RuntimeError('ownership-directory-count')
                        walk(fd,n,rel+'/'+n,depth+1)
                if ledger is not None:os.fsync(fd)
            elif ledger is not None:os.fsync(fd)
            after=metadata(fd)
            if after!=row:raise RuntimeError('ownership-concurrent-metadata-change')
        finally:os.close(fd)
    base=os.open(root,os.O_RDONLY|os.O_NOFOLLOW|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        device=os.fstat(base).st_dev
        for name in ('cl','tmp-cl'):walk(base,name,name,0)
        if ledger is not None and set(records)!=set(ledger):raise RuntimeError('ownership-tree-changed')
        if ledger is not None:os.fsync(base)
    finally:os.close(base)
    budget()
    return records
