#!/usr/bin/env python3
"""Prepare an exclusive public NoCloud seed for owned RPC guest initialization.

Embeds verified public runtime/library files. Engine JWT is generated only in
that guest. No TLS private key, state export, mounts or client startup is added.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time


def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def build(config):
    origin=time.monotonic()
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=config['bootId']:
        raise ValueError('Build host boot changed')
    instance=config['instance'];key=config['publicKey'].strip()
    if not re.fullmatch(r'rpc-owned-[a-z0-9-]{8,64}',instance) or not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?',key):
        raise ValueError('Explicit instance and public SSH key required')
    archive=Path(config['archive']);receipt=config['storageReceipt']
    if archive.stat().st_size!=receipt['bytes'] or digest(archive)!=receipt['sha256']:
        raise ValueError('Storage archive changed')
    output=Path(config['output']);output.mkdir(mode=0o700)
    def guard():
        mem=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
        disk=os.statvfs(output)
        if mem<2*1024**3 or disk.f_bavail*disk.f_frsize<16*1024**3 or time.monotonic()-origin>=90:
            raise ValueError('Seed resource/deadline guard')
    guard();writes=[];records={}
    def add(path,data,mode):
        if path in records or len(data)>16*1024**2:raise ValueError('Duplicate or oversized seed member')
        writes.append({'path':path,'permissions':mode,'owner':'root:root','encoding':'b64','content':base64.b64encode(data).decode()})
        records[path]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mode':mode}
    prefix='opt/enclave-rpc/nbd/'
    files={prefix+k:v for k,v in receipt['files'].items()};aliases={prefix+'lib/'+n:v for n,v in receipt['sonames'].items() if n!=v}
    with tarfile.open(archive,'r:') as t:
        members=t.getmembers()
        if len(members)!=len(files)+len(aliases) or {m.name for m in members}!=set(files)|set(aliases):raise ValueError('Archive member mismatch')
        for m in members:
            if m.uid!=0 or m.gid!=0:raise ValueError('Archive ownership mismatch')
            if m.name in aliases:
                if not m.issym() or m.linkname!=aliases[m.name]:raise ValueError('Archive alias mismatch')
                continue
            row=files[m.name]
            if not m.isfile() or m.mode!=0o755 or m.size!=row['bytes']:raise ValueError('Archive file mismatch')
            data=t.extractfile(m).read()
            if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('Archive digest mismatch')
            add('/'+m.name,data,'0755')
    for path,row in config['payload'].items():
        if not (path.startswith('/opt/enclave-rpc/') or path.startswith('/etc/systemd/system/')) or '..' in Path(path).parts:
            raise ValueError('Unexpected payload path')
        data=base64.b64decode(row['content'],validate=True)
        if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('Payload changed')
        add(path,data,row['mode'])
    identity={'schema':'owned-rpc-identity/1','instance':instance,'runtimePins':config['runtimePins']}
    add('/etc/enclave-rpc/identity.json',json.dumps(identity,sort_keys=True).encode(),'0644')
    add('/etc/enclave-rpc/storage-client.json',json.dumps({'files':receipt['files'],'sonames':receipt['sonames']},sort_keys=True).encode(),'0644')
    add('/etc/ssh/sshd_config.d/00-rpc-key-only.conf',b'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n','0644')
    cloud={'users':[{'name':'rpcadmin','groups':['sudo'],'shell':'/bin/bash','sudo':'ALL=(ALL) NOPASSWD:ALL','lock_passwd':True,'ssh_authorized_keys':[key]}],
           'ssh_pwauth':False,'disable_root':True,'package_update':False,'package_upgrade':False,'write_files':writes,
           'runcmd':[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','enclave-rpc-identity.service']]}
    seed=output/'seed';seed.mkdir()
    (seed/'meta-data').write_text('instance-id: '+instance+'\nlocal-hostname: '+instance+'\n')
    data=('#cloud-config\n'+json.dumps(cloud,indent=2)+'\n').encode()
    if len(data)>24*1024**2:raise ValueError('Seed content bound')
    (seed/'user-data').write_bytes(data)
    tool=Path(config['xorriso'])
    if digest(tool)!=config['xorrisoSha256']:raise ValueError('Seed tool changed')
    env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LD_LIBRARY_PATH':config['libraryPath']}
    def run(args,name):
        guard()
        with (output/name).open('xb') as f:
            subprocess.run([str(tool),*map(str,args)],stdout=f,stderr=subprocess.STDOUT,env=env,timeout=20,check=True)
        guard()
    iso=output/'seed.iso'
    run(['-as','mkisofs','-V','cidata','-J','-r','-o',iso,seed/'user-data',seed/'meta-data'],'build.txt')
    if iso.stat().st_size>64*1024**2:raise ValueError('Seed exceeds boot contract')
    extracted=output/'readback'
    run(['-osirrox','on','-indev',iso,'-extract','/',extracted],'readback.txt')
    for name in ['user-data','meta-data']:
        if (seed/name).read_bytes()!=(extracted/name).read_bytes():raise ValueError('Seed readback differs')
    if digest(archive)!=receipt['sha256']:raise ValueError('Source archive changed')
    result={'instance':instance,'seed':str(iso),'bytes':iso.stat().st_size,'sha256':digest(iso),'records':records,
            'seconds':time.monotonic()-origin,'readbackVerified':True,'storageAttached':False,'clientsStarted':False,
            'engineSecretIncluded':False,'invocation':os.environ.get('INVOCATION_ID')}
    (output/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__=='__main__':
    import sys
    print(json.dumps(build(json.loads(sys.argv[1]))))
