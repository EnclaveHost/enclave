from pathlib import Path
import base64,hashlib,json,os,shlex,stat,subprocess,time

os.umask(0o077)
p=Path(__file__).resolve().parent;c=json.loads((p/'SPEC.json').read_text());s=Path(c['sourceRoot'])
def sha(data):return hashlib.sha256(data).hexdigest()
def write(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def record(name,row):write(p/name,json.dumps(row,indent=2).encode()+b'\n')
def authority(path):
    assert path.resolve(strict=True)==path
    for q in [path,*path.parents]:
        st=q.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid in (0,os.geteuid()) and not st.st_mode&0o022
    assert stat.S_IMODE(path.stat().st_mode)==0o700
authority(p/'private')
pins=json.loads((p/'PINS.json').read_text())
def check_pins():
    for row in pins:assert sha(Path(row['path']).read_bytes())==row['sha256']
check_pins()
observer=['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),c['resourceConfig']]
r=subprocess.run(observer,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3)
assert r.returncode==0 and len(r.stdout)<16384 and len(r.stderr)<4096
admission=json.loads(r.stdout)
assert admission['authenticated'] is True and admission['unreadUnits']==0
# 128 MiB queue wrapper + 256 MiB local scope. Remote unit has its own gate.
assert admission['availableMiB']-admission['pendingMiB']-384>=max(27648,admission['floorMiB'])
record('ADMISSION.json',admission)
write(p/'INTENT.json',json.dumps({'createdUtcNs':time.time_ns(),'source':c['source'],'destination':str(p/'private'/c['attempt']),'receiptSha256':c['receiptSha256'],'remoteUnit':c['remoteUnit'],'noRetry':True}).encode())
remote=['sudo','-n','systemd-run','--quiet','--wait','--pipe','--unit='+c['remoteUnit'],
    '--property=User=controladmin','--property=MemoryMax=128M','--property=MemorySwapMax=0','--property=CPUQuota=100%',
    '--property=TasksMax=8','--property=RuntimeMaxSec=20','--property=TimeoutStopSec=1','--property=KillMode=control-group',
    '--property=PrivateNetwork=yes','--property=NoNewPrivileges=yes','--property=ProtectSystem=strict','--property=ProtectHome=read-only','--property=LimitCORE=0',
    '/usr/bin/python3','-I','-B','-c',(p/'read_remote.py').read_text()]
ssh=json.loads((p/'SSH.json').read_text())
start=time.monotonic()
try:r=subprocess.run(ssh+[shlex.join(remote)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
except subprocess.TimeoutExpired:
    record('FAILURE.json',{'reason':'transport-timeout','remoteDeathProven':False,'noRetry':True});raise SystemExit(2)
# Neither stdout nor stderr from this credential-bearing transport is persisted.
record('TRANSPORT.json',{'rc':r.returncode,'seconds':time.monotonic()-start,'stdoutBytes':len(r.stdout),'stderrBytes':len(r.stderr),'remoteDeathProven':False})
assert r.returncode==0 and len(r.stdout)<65536 and len(r.stderr)<4096
write(p/'private'/'transport.json',r.stdout)
payload=json.loads(r.stdout)
record('REMOTE-IDENTITY.json',{k:payload[k] for k in ('pid','processStart','bootId','invocation')})
names=['PUBLIC.json']+[role+'/'+kind+'/'+name for role in ('l1','base') for kind in ('server','client') for name in ('ca-cert.pem',kind+'-cert.pem',kind+'-key.pem')]
assert set(payload)=={'files','invocation','bootId','availableMiB','originalsUnchanged','pid','processStart'} and set(payload['files'])==set(names)
assert payload['originalsUnchanged'] is True
assert type(payload['pid']) is int and payload['pid']>1 and str(payload['processStart']).isdigit()
assert len(payload['invocation'])==32 and all(x in '0123456789abcdef' for x in payload['invocation'])
query_code="from pathlib import Path;import json;pid="+str(payload['pid'])+";p=Path('/proc')/str(pid)/'stat';print(json.dumps({'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'processStart':p.read_text().rsplit(')',1)[1].split()[19] if p.exists() else None}))"
terminal=subprocess.run(ssh+[shlex.join(['/usr/bin/python3','-I','-B','-c',query_code])],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
assert terminal.returncode==0 and len(terminal.stdout)<4096 and len(terminal.stderr)<4096
state=json.loads(terminal.stdout);record('REMOTE-EXACT-EXIT.json',state)
assert state['bootId']==payload['bootId'] and state['processStart']!=payload['processStart']
files={name:base64.b64decode(payload['files'][name],validate=True) for name in names}
assert all(0<len(data)<=16384 for data in files.values()) and sha(files['PUBLIC.json'])==c['receiptSha256']
public=json.loads(files['PUBLIC.json']);assert public['schema']=='owned-rpc-credentials/1' and public['attempt']==c['attempt'] and public['instance']==c['instance'] and set(public['roles'])=={'l1','base'}
root=p/'private'/c['attempt'];root.mkdir(mode=0o700)
for role in ('l1','base'):
    (root/role).mkdir(mode=0o700)
    for kind in ('server','client'):(root/role/kind).mkdir(mode=0o700)
for name,data in files.items():write(root/name,data)
assert sha(Path(c['openssl']['path']).read_bytes())==c['openssl']['sha256']
def ssl(args,data=None):
    result=subprocess.run([c['openssl']['path'],*map(str,args)],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','LANG':'C','OPENSSL_CONF':'/dev/null'},timeout=3)
    assert result.returncode==0 and len(result.stdout)+len(result.stderr)<16384,'Local credential verification failed'
    return result.stdout
for role in ('l1','base'):
    row=public['roles'][role]
    assert row['tlsName']=='rpc-storage-'+c['attempt']+'-'+role and row['clientDN']=='CN=rpc-client-'+c['attempt']+'-'+role
    for kind in ('server','client'):
        d=root/role/kind;ca=d/'ca-cert.pem';cert=d/(kind+'-cert.pem');key=d/(kind+'-key.pem')
        assert sha(ca.read_bytes())==row['caSha256'] and sha(cert.read_bytes())==row[kind+'CertificateSha256']
        key_der=ssl(['pkey','-in',key,'-pubout','-outform','DER'])
        cert_pub=ssl(['x509','-in',cert,'-pubkey','-noout']);cert_der=ssl(['pkey','-pubin','-outform','DER'],cert_pub)
        assert key_der==cert_der
        if kind=='client':assert sha(key_der)==row['clientPublicKeySha256']
        args=['verify','-CAfile',ca,'-purpose','sslserver' if kind=='server' else 'sslclient']
        if kind=='server':args+=['-verify_hostname',row['tlsName']]
        ssl(args+[cert])
for name,data in files.items():
    path=root/name;authority(path.parent);st=path.lstat()
    assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and path.read_bytes()==data
for directory in [root/role/kind for role in ('l1','base') for kind in ('server','client')]+[root/'l1',root/'base',root,root.parent]:
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
check_pins()
record('RESULT.json',{'schema':'owned-rpc-server-credential-stage/1','attempt':c['attempt'],'instance':c['instance'],'destination':str(root),'publicReceiptSha256':c['receiptSha256'],'files':13,'keyPairsVerified':4,'privateModesVerified':True,'sourceMetadataUnchanged':True,'remoteInvocation':payload['invocation'],'remoteBootId':payload['bootId'],'remoteAvailableMiB':payload['availableMiB'],'seconds':time.monotonic()-start,'issuerKeysTransferred':False,'guestSshPrivateKeyTransferred':False,'credentialsRotated':False,'exportStarted':False,'vmStarted':False,'rpcReady':False})
print(json.dumps({'credentialStageComplete':True,'files':13,'privateContentsPrinted':False,'exportStarted':False}))
