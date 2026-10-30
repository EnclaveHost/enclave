"""Local backing-chain validation helpers; no actions at import/assembly."""
import os,stat,hashlib,fcntl,struct,time,json
from pathlib import Path

def backing_fields(st):
    return {key:getattr(st,attr) for key,attr in (
        ('device','st_dev'),('inode','st_ino'),('bytes','st_size'),('mtimeNs','st_mtime_ns'),
        ('ctimeNs','st_ctime_ns'),('mode','st_mode'),('uid','st_uid'),('gid','st_gid'),('links','st_nlink'))}

def validate_frozen_receipt(receipt,manifest):
    row=manifest['frozenBacking']
    assert row['path']==receipt['path']==manifest['recoveryBackingPath'],'backing-path-policy'
    mapping={'device':'st_dev','inode':'st_ino','bytes':'st_size','mtimeNs':'st_mtime_ns','ctimeNs':'st_ctime_ns','mode':'st_mode','uid':'st_uid','gid':'st_gid','links':'st_nlink'}
    for key,field in mapping.items():assert row[key]==receipt['identity'][field],'backing-receipt-identity'
    assert stat.S_ISREG(row['mode']) and not row['mode']&0o022 and row['links']==1 and row['uid'] in (0,os.geteuid()),'backing-file-policy'
    assert receipt['readOnly'] is True and receipt['qemuCompatibleLocksHeldDuringHash'] is True,'backing-evidence-policy'
    assert receipt['bytesHashed']==row['bytes']>0 and receipt['allocatedBytes']<=7<<30,'backing-evidence-size'
    for key in ('sha256','header104Sha256'):
        digest=row[key];assert digest==receipt[key] and len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'backing-content-pin'
    assert row['parents']==receipt['parents'],'backing-parent-evidence'
    assert row['device']==manifest['parent']['device'],'backing-filesystem-policy'
    return row

def backing_identity(row,fd=None):
    path=Path(row['path'])
    assert path.is_absolute() and str(path)==str(path.resolve(strict=True)),'backing-canonical-path'
    for q in [path,*path.parents]:
        st=q.lstat();assert not stat.S_ISLNK(st.st_mode),'backing-symlink'
        if q!=path:assert stat.S_ISDIR(st.st_mode) and st.st_uid in (0,os.geteuid()) and not st.st_mode&0o022,'backing-directory-authority'
    st=path.lstat();actual=backing_fields(st)
    assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid in (0,os.geteuid()) and not st.st_mode&0o022,'backing-live-authority'
    assert all(actual[k]==row[k] for k in actual if k in row),'backing-identity-drift'
    for name,identity in row.get('parents',{}).items():
        v=Path(name).lstat();assert [v.st_dev,v.st_ino,v.st_uid,v.st_mode]==identity,'backing-parent-drift'
    if fd is not None:assert backing_fields(os.fstat(fd))==actual,'backing-fd-drift'
    return actual

def backing_header(row,fd):
    raw=os.pread(fd,104,0)
    assert len(raw)==104 and hashlib.sha256(raw).hexdigest()==row['header104Sha256'],'backing-header-drift'

def lock_backing(row,held):
    backing_identity(row)
    fd=os.open(row['path'],os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    # Register immediately so partial lock acquisition is always unwound by caller.
    held.append((row,fd));backing_identity(row,fd)
    for byte in (201,202,203):
        fcntl.fcntl(fd,fcntl.F_OFD_SETLK,struct.pack('@hhqqi4x',fcntl.F_RDLCK,os.SEEK_SET,byte,1,0))
    occupied=fcntl.fcntl(fd,fcntl.F_OFD_GETLK,struct.pack('@hhqqi4x',fcntl.F_WRLCK,os.SEEK_SET,100,200,0))
    assert struct.unpack('@hhqqi4x',occupied)[0]==fcntl.F_UNLCK,'backing-writer-conflict'
    backing_identity(row,fd);backing_header(row,fd)
    return fd

def verify_frozen_hash(row,fd,tick,seconds=10):
    assert 'sha256' in row,'frozen-full-hash-required'
    until=time.monotonic()+seconds;digest=hashlib.sha256();offset=0
    while offset<row['bytes']:
        tick();assert time.monotonic()<until,'backing-hash-time-bound'
        raw=os.pread(fd,min(1<<20,row['bytes']-offset),offset);assert raw,'backing-hash-short-read'
        digest.update(raw);offset+=len(raw)
    assert digest.hexdigest()==row['sha256'],'backing-full-hash-drift'
    backing_identity(row,fd);return {'fullHashChecked':True,'bytes':offset,'sha256':digest.hexdigest()}

def validate_backing_chain(info,expected_paths,virtual_bytes):
    assert isinstance(info,list) and len(info)==len(expected_paths),'backing-chain-length'
    for i,(entry,path) in enumerate(zip(info,expected_paths)):
        assert entry['filename']==path and entry['format']=='qcow2' and entry['virtual-size']==virtual_bytes,'backing-chain-identity'
        assert not entry.get('encrypted',False),'encrypted-backing-unexpected'
        assert entry.get('dirty-flag') is False,'dirty-backing-unexpected'
        children=entry.get('children',[])
        assert len(children)==1 and children[0]['name']=='file','unexpected-backing-children'
        child=children[0]['info']
        assert child['filename']==path and child['format']=='file' and not child.get('children') and not child.get('backing-filename'),'external-backing-child'
        data=entry.get('format-specific',{}).get('data',{})
        assert data.get('corrupt') is False,'corrupt-backing-unexpected'
        assert not any(k in data for k in ('data-file','data-file-raw','encrypt')),'external-backing-data'
        assert not any(k in entry for k in ('data-file','data-file-raw')),'external-backing-data'
        if i+1<len(expected_paths):
            assert entry.get('backing-filename')==expected_paths[i+1],'backing-path-mismatch'
            assert entry.get('full-backing-filename',entry.get('backing-filename'))==expected_paths[i+1],'backing-resolved-path-mismatch'
            assert entry.get('backing-filename-format')=='qcow2','backing-format-mismatch'
        else:assert not entry.get('backing-filename') and not entry.get('full-backing-filename'),'unexpected-ancestor'
    return True
