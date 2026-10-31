#!/usr/bin/env python3
"""Verify the seeded private NBD closure; never attach storage or start clients."""
import hashlib
import importlib.util
import json
from pathlib import Path
import os
import stat
import subprocess


def module(name, filename):
    spec=importlib.util.spec_from_file_location(name,filename)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value


def install():
    identity=module('identity','/opt/enclave-rpc/identity.py')
    config=Path('/etc/enclave-rpc/identity.json');identity.protected(config,mode=0o644)
    identity.check_context(json.loads(config.read_text()))
    manifest=Path('/etc/enclave-rpc/storage-client.json');identity.protected(manifest,mode=0o644)
    config=json.loads(manifest.read_text());root=Path('/opt/enclave-rpc/nbd');lib=root/'lib'
    for p in [root,lib]:
        st=p.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:
            raise ValueError('Unprotected private library directory')
    if set(config)!={'files','sonames'} or len(config['files'])!=14 or len(config['sonames'])!=13:
        raise ValueError('Exact private closure required')
    for name,row in config['files'].items():
        path=Path(name)
        if path.is_absolute() or '..' in path.parts or len(path.parts)>2:
            raise ValueError('Unsafe private member')
        p=root/path;st=identity.protected(p,mode=0o755)
        if st.st_size!=row['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=row['sha256']:
            raise ValueError('Private storage binary changed')
    for name,target in config['sonames'].items():
        if Path(name).name!=name or Path(target).name!=target or 'lib/'+target not in config['files']:
            raise ValueError('Invalid library alias')
        if name==target:continue
        p=lib/name
        try:p.symlink_to(target)
        except FileExistsError:
            if not p.is_symlink() or os.readlink(p)!=target:
                raise ValueError('Conflicting existing library alias')
    validator=module('storage_library','/opt/enclave-rpc/storage_library.py')
    r=subprocess.run([str(lib/'ld-linux-x86-64.so.2'),'--inhibit-cache','--library-path',str(lib),'--list',str(root/'nbd-client')],
                     env={'PATH':'/usr/bin:/bin','LANG':'C'},capture_output=True,text=True,timeout=5,check=True)
    if len(r.stdout)>16384 or r.stderr:raise ValueError('Unexpected loader output')
    validator.validate_loader(r.stdout,lib,config['sonames'])
    print(json.dumps({'privateStorageClientVerified':True,'storageAttached':False}))

if __name__=='__main__':install()
