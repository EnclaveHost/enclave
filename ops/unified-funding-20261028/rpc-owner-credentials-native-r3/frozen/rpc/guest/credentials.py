"""Prepare owner-controlled, per-role TLS identities and a pinned guest SSH key.

Private bundles/seed media are NEVER public artifacts. No network service,
production data, account, chain state or VM is touched by this module.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time


def sha(data):return hashlib.sha256(data).hexdigest()


def private_directory(path):
    path=Path(path)
    if not path.is_absolute() or path.resolve(strict=True)!=path:raise ValueError('Canonical private directory required')
    for p in [path,*path.parents]:
        s=p.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0,os.geteuid()) or s.st_mode&0o022:
            raise ValueError('Directory authority mismatch')
    if stat.S_IMODE(path.stat().st_mode)!=0o700:raise ValueError('Private directory mode required')
    return path


def private_read(path):
    path=Path(path);private_directory(path.parent);s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or s.st_size>32768:
        raise ValueError('Bounded owned private file required')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        actual=os.fstat(f.fileno())
        if (actual.st_dev,actual.st_ino,actual.st_mode,actual.st_uid,actual.st_nlink)!=(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink):
            raise ValueError('Private file identity changed')
        data=f.read(32769)
    if len(data)>32768:raise ValueError('Private file grew')
    return data


class Tools:
    def __init__(self,pins):
        if set(pins)!={'openssl','ssh-keygen'}:raise ValueError('Exact credential tools required')
        self.pins=pins;self.deadline=time.monotonic()+45
        for row in pins.values():
            path=Path(row['path'])
            if not path.is_absolute() or path.resolve()!=path:raise ValueError('Canonical tool required')
            with path.open('rb') as f:
                if hashlib.file_digest(f,'sha256').hexdigest()!=row['sha256']:raise ValueError('Credential tool changed')
    def run(self,name,args,data=None,allow_failure=False):
        remaining=self.deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('Credential preparation deadline')
        env={'PATH':'/usr/bin:/bin','LANG':'C','OPENSSL_CONF':'/dev/null'}
        r=subprocess.run([self.pins[name]['path'],*map(str,args)],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                         env=env,timeout=min(5,remaining))
        if len(r.stdout)+len(r.stderr)>65536:raise ValueError('Credential tool output bound')
        if r.returncode and not allow_failure:
            # Do not include arbitrary tool diagnostics or private input in public errors.
            raise ValueError('Credential tool failed: '+name+' exit '+str(r.returncode))
        return r
    def public_der(self,key):return self.run('openssl',['pkey','-in',key,'-pubout','-outform','DER']).stdout
    def certificate_der(self,cert):
        public=self.run('openssl',['x509','-in',cert,'-pubkey','-noout']).stdout
        return self.run('openssl',['pkey','-pubin','-outform','DER'],public).stdout


def validate_identity(attempt,instance):
    if not re.fullmatch('[a-f0-9]{32}',attempt) or not re.fullmatch(r'rpc-owned-[a-z0-9-]{8,64}',instance):
        raise ValueError('Explicit attempt and guest instance required')


def generate(parent,attempt,instance,pins):
    validate_identity(attempt,instance);parent=private_directory(parent);tools=Tools(pins)
    old=os.umask(0o077)
    try:
        root=parent/attempt;root.mkdir(mode=0o700)  # no reuse or silent key replacement
        result={'schema':'owned-rpc-credentials/1','attempt':attempt,'instance':instance,'roles':{},'containsPrivateKeys':True}
        for role in ('l1','base'):
            role_dir=root/role;role_dir.mkdir(mode=0o700)
            issuer=role_dir/'issuer';server=role_dir/'server';client=role_dir/'client'
            for p in (issuer,server,client):p.mkdir(mode=0o700)
            ca=issuer/'ca-cert.pem';ca_key=issuer/'ca-key.pem'
            tls_name='rpc-storage-'+attempt+'-'+role;client_cn='rpc-client-'+attempt+'-'+role
            tools.run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',ca_key,'-out',ca,'-days','365',
                '-subj','/CN=rpc-owner-'+attempt+'-'+role,'-addext','basicConstraints=critical,CA:TRUE,pathlen:0',
                '-addext','keyUsage=critical,keyCertSign,cRLSign'])
            for folder,prefix,subject,usage in ((server,'server',tls_name,'serverAuth'),(client,'client',client_cn,'clientAuth')):
                key=folder/(prefix+'-key.pem');cert=folder/(prefix+'-cert.pem');csr=issuer/(prefix+'.csr');ext=issuer/(prefix+'.ext')
                tools.run('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN='+subject])
                ext.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage='+usage+'\nsubjectAltName=DNS:'+subject+'\n')
                tools.run('openssl',['x509','-req','-in',csr,'-CA',ca,'-CAkey',ca_key,'-set_serial','0x'+secrets.token_hex(16),
                    '-out',cert,'-days','365','-extfile',ext])
                (folder/'ca-cert.pem').write_bytes(private_read(ca))
                if tools.public_der(key)!=tools.certificate_der(cert):raise ValueError('Certificate/private-key mismatch')
            tools.run('openssl',['verify','-CAfile',ca,'-purpose','sslserver','-verify_hostname',tls_name,server/'server-cert.pem'])
            tools.run('openssl',['verify','-CAfile',ca,'-purpose','sslclient',client/'client-cert.pem'])
            result['roles'][role]={'tlsName':tls_name,'clientDN':'CN='+client_cn,
                'caSha256':sha(private_read(ca)),'serverCertificateSha256':sha(private_read(server/'server-cert.pem')),
                'clientCertificateSha256':sha(private_read(client/'client-cert.pem')),
                'clientPublicKeySha256':sha(tools.public_der(client/'client-key.pem'))}
        host=root/'ssh';host.mkdir(mode=0o700)
        tools.run('ssh-keygen',['-q','-t','ed25519','-N','','-C',instance,'-f',host/'ssh_host_ed25519_key'])
        # ssh-keygen's public output can have0644; protect the whole bundle uniformly.
        (host/'ssh_host_ed25519_key.pub').chmod(0o600)
        public=tools.run('ssh-keygen',['-y','-f',host/'ssh_host_ed25519_key']).stdout.decode().strip()
        if public.split()[:2]!=private_read(host/'ssh_host_ed25519_key.pub').decode().split()[:2]:raise ValueError('SSH host key mismatch')
        result['sshHostPublicKey']=' '.join(public.split()[:2])
        result['sshHostFingerprint']='SHA256:'+base64.b64encode(hashlib.sha256(base64.b64decode(public.split()[1],validate=True)).digest()).decode().rstrip('=')
        receipt=json.dumps(result,sort_keys=True,indent=2).encode()+b'\n'
        (root/'PUBLIC.json').write_bytes(receipt)
        return {'path':str(root),'publicReceiptSha256':sha(receipt),'public':result}
    finally:os.umask(old)


def guest_material(bundle,receipt_sha,instance,pins):
    """Return only guest-scoped secrets in memory; never print this return value."""
    root=private_directory(bundle);raw=private_read(root/'PUBLIC.json')
    if sha(raw)!=receipt_sha:raise ValueError('Credential receipt changed')
    public=json.loads(raw);validate_identity(public['attempt'],public['instance'])
    if root.name!=public['attempt']:raise ValueError('Credential attempt directory mismatch')
    if public['schema']!='owned-rpc-credentials/1' or public['instance']!=instance or set(public['roles'])!={'l1','base'}:
        raise ValueError('Credential/guest identity mismatch')
    tools=Tools(pins);writes={}
    for role,row in public['roles'].items():
        client=root/role/'client'
        ca=private_read(client/'ca-cert.pem');cert=private_read(client/'client-cert.pem');key=private_read(client/'client-key.pem')
        if sha(ca)!=row['caSha256'] or sha(cert)!=row['clientCertificateSha256']:raise ValueError('Guest public credential changed')
        if sha(tools.public_der(client/'client-key.pem'))!=row['clientPublicKeySha256'] or tools.public_der(client/'client-key.pem')!=tools.certificate_der(client/'client-cert.pem'):
            raise ValueError('Guest private credential changed')
        tools.run('openssl',['verify','-CAfile',client/'ca-cert.pem','-purpose','sslclient',client/'client-cert.pem'])
        prefix='/etc/enclave-rpc/storage/'+public['attempt']+'/'+role+'/'
        for name,data in [('ca-cert.pem',ca),('client-cert.pem',cert),('client-key.pem',key)]:
            writes[prefix+name]={'data':data,'private':name=='client-key.pem','mode':'0600'}
    host=root/'ssh';private=private_read(host/'ssh_host_ed25519_key').decode()
    pub=tools.run('ssh-keygen',['-y','-f',host/'ssh_host_ed25519_key']).stdout.decode().strip()
    if ' '.join(pub.split()[:2])!=public['sshHostPublicKey']:raise ValueError('Guest SSH key changed')
    return {'writes':writes,'ssh_keys':{'ed25519_private':private,'ed25519_public':public['sshHostPublicKey']},'public':public}


def seed_material(config,instance):
    """Private in-memory cloud-init fragment and public-only verification records."""
    material=guest_material(config['bundle'],config['publicReceiptSha256'],instance,config['tools'])
    public=material['public'];attempt=public['attempt']
    directories=['/etc/enclave-rpc/storage','/etc/enclave-rpc/storage/'+attempt]
    directories.extend('/etc/enclave-rpc/storage/'+attempt+'/'+role for role in ('l1','base'))
    # Explicit ssh_keys bypasses automatic generation; an empty ssh_genkeytypes
    # list is invalid under the installed cloud-init schema. Omit that setting.
    cloud={'bootcmd':[['/usr/bin/install','-d','-m','0700',*directories]],
           'ssh_keys':material['ssh_keys'],'ssh_deletekeys':True,
           'ssh_quiet_keygen':True,'ssh_publish_hostkeys':{'enabled':False}}
    # /etc/enclave-rpc itself must remain traversable for the EL/CL group JWT.
    return material['writes'],cloud,{'publicReceiptSha256':config['publicReceiptSha256'],
        'attempt':attempt,'sshHostPublicKey':public['sshHostPublicKey'],
        'sshHostFingerprint':public['sshHostFingerprint'],'roles':public['roles']}
