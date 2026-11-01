"""One public native enrollment in, one original owner's endpoint offer out.

Runs only in its fixed independently bounded exchange service. It submits the
separate owner bootstrap service once. Transport death is never owner death,
writer settlement, readiness or permission to repeat an ambiguous submission.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('rpc_exchange_bootstrap',HERE/'owner_bootstrap_entry.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
c=b.c
spec=importlib.util.spec_from_file_location('rpc_exchange_pipe',HERE/'relay_owner.py')
pipe=importlib.util.module_from_spec(spec);spec.loader.exec_module(pipe)
LIMIT=131072


def decode(raw):
    if not 0<len(raw)<=LIMIT:raise ValueError('Native frame bound')
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise ValueError('Duplicate native frame field')
            result[key]=value
        return result
    def constant(_):raise ValueError('Finite JSON required')
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=constant)
    if not isinstance(value,dict):raise ValueError('Native frame object required')
    return value


def envelope(original):
    unit='enclave-rpc-owner-exchange-'+original['attempt']+'.service'
    row=b.e.show(unit)
    expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'Type':'exec','RuntimeMaxUSec':'20s','TimeoutStopUSec':'1s','MemoryMax':str(128<<20),
        'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group',
        'Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    c.hex32(expected['InvocationID'])
    if (any(row[k]!=v for k,v in expected.items()) or
            Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):
        raise ValueError('Independent exchange envelope differs')
    start=int(row['ExecMainStartTimestampMonotonic'])*1000
    if not 0<=time.monotonic_ns()-start<5_000_000_000 or start+143_000_000_000>=original['deadlineMonotonicNs']:
        raise ValueError('Exchange and owner must fit original window')
    return row


def admission(owner):
    template=c.protocol.decode(c.read_pinned(owner['preparation']))
    export=c.protocol.decode(c.read_pinned(template['exportPreparation']))
    if export['clock']!=owner['clock']:raise ValueError('Original resource configuration required')
    args=['/usr/bin/node',str(HERE/'observe_resources.mjs'),export['resourceConfig']['path']]
    c.read_pinned(export['resourceConfig'])
    for path in args:
        with open(path,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=export['runtimePins'][path]:raise ValueError('Resource reader changed')
    r=subprocess.run(args,capture_output=True,check=True,timeout=3)
    if len(r.stdout)+len(r.stderr)>65536:raise ValueError('Resource output bound')
    resource=c.protocol.decode(r.stdout)
    # Existing whole-owner1408 plus exchange128 and explicit64 startup allowance.
    if (resource.get('authenticated') is not True or resource.get('unreadUnits')!=0 or
            any(type(resource.get(k)) is not int or resource[k]<0 for k in ('availableMiB','pendingMiB','floorMiB')) or
            resource['availableMiB']-resource['pendingMiB']-1600<max(27648,export['floorMiB'],resource['floorMiB'])):
        raise ValueError('Whole exchange/owner admission refused')
    return resource,template


def submit(owner_binding,original,continuous=False):
    unit='enclave-rpc-owner-bootstrap-'+('stream-' if continuous else '')+original['attempt']+'.service'
    runtime=b.e.stream_runtime(original) if continuous else 120
    props=['Type=exec','RuntimeMaxSec='+str(runtime),'TimeoutStopSec=1','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%',
        'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL',
        'NoNewPrivileges=yes','LimitCORE=0','UMask=0077','StandardInput=null','StandardOutput=journal','StandardError=journal']
    args=['/usr/bin/systemd-run','--user','--quiet','--unit='+unit,*['--property='+p for p in props],
        '/usr/bin/python3','-B',str(HERE/'owner_bootstrap_entry.py'),owner_binding['path']]
    # A timeout kills only local systemd-run. The durable caller intent stays held.
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2)
    if result.returncode!=0:raise ValueError('Owner submission refused or ambiguous')


def read_offer(parent,enrollment,owner_config):
    folder=parent/'bootstrap';offer_path=folder/'host-offer.json'
    # Publisher links complete fsynced bytes, then removes pending. Never accept
    # an intermediate two-link inode or anything from an older bootstrap.
    if not offer_path.exists() or (folder/'host-offer.pending').exists():return None
    enrolled=c.protocol.decode(c.read(folder/'enrollment.json'))
    candidate=c.protocol.decode(c.read_pinned(enrollment))['enrollment']['info']
    wanted={'receiptSha256':enrollment['sha256'],'requestSha256':candidate['requestSha256'],
        'certificateSha256':hashlib.sha256(base64.b64decode(candidate['certificate'],validate=True)).hexdigest(),
        'guestAuthenticated':False,'rootsGranted':False,'rpcReady':False}
    if enrolled!=wanted:raise ValueError('Published offer belongs to another enrollment')
    prepared=c.protocol.decode(c.read(parent/'owner-enrollment'/'RESULT.json'))
    intent=c.protocol.decode(c.read(parent/'bootstrap-entry.intent'))
    if (prepared['enrollment']!=enrollment or prepared['clock']!=owner_config['clock'] or
            intent['clock']!=owner_config['clock'] or intent['relay']!=prepared['relay']):
        raise ValueError('Original owner entry lineage differs')
    identity=intent['unit'];actual=b.e.show(identity['Id'])
    if (identity['Id']!='enclave-rpc-owner-bootstrap-'+('stream-' if owner_config['schema']=='enclave-rpc-owner-bootstrap-entry/4' else '')+parent.name+'.service' or
            any(actual[k]!=identity[k] for k in ('Id','MainPID','InvocationID','ControlGroup')) or
            not identity['InvocationID'] or int(identity['MainPID'])<=0):
        raise ValueError('Original owner service identity differs')
    fd=b.e.held(str(offer_path),LIMIT)
    try:
        before=os.fstat(fd);raw=os.read(fd,LIMIT+1);after=os.fstat(fd)
        identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        if identity(before)!=identity(after) or len(raw)!=before.st_size:raise ValueError('Offer changed during read')
    finally:os.close(fd)
    offer=decode(raw)
    if set(offer)!={'proof','ownerServerDer','exportServerDer','policy'}:raise ValueError('Exact signed endpoint offer required')
    signed=offer['proof']['offer']
    if signed['requestSha256']!=wanted['requestSha256'] or signed['clientCertificateSha256']!=wanted['certificateSha256']:
        raise ValueError('Signed endpoint differs from actual request')
    return offer


def write_frame(fd,raw,until):
    if not 0<len(raw)<=LIMIT:raise ValueError('Native response frame bound')
    data=memoryview(struct.pack('!I',len(raw))+raw)
    while data:
        left=until-time.monotonic()
        if left<=0:raise TimeoutError('Offer delivery ambiguous')
        _,ready,_=select.select([],[fd],[],min(.05,left))
        if not ready:continue
        try:n=os.write(fd,data)
        except (BlockingIOError,InterruptedError):continue
        if n<=0:raise ValueError('Offer write failed')
        data=data[n:]


def run(config,input_fd=0,output_fd=1):
    if set(config)!={'schema','native','owner'} or config['schema'] not in ('enclave-rpc-owner-exchange/1','enclave-rpc-owner-exchange/2'):raise ValueError('Exact operator exchange configuration required')
    continuous=config['schema']=='enclave-rpc-owner-exchange/2'
    native=config['native'];owner=config['owner']
    if set(native)!={'original','plan'}:raise ValueError('Original native manager/plan required')
    for digest in native.values():c.protocol.digest(digest)
    if set(owner)!={'schema','clock','listen','pins','bootstrapPolicy','preparation'} or owner['schema']!='enclave-rpc-owner-bootstrap-entry/'+('4' if continuous else '3'):raise ValueError('Original v3 owner template required')
    original=c.validate(owner['clock']);unit=envelope(original);b.verify_pins(owner['pins'])
    start=int(unit['ExecMainStartTimestampMonotonic'])/1e6;until=min(start+19,original['deadlineMonotonicNs']/1e9)
    resource,template=admission(owner)
    parent=c.directory(Path(owner['clock']['path']).parent)
    if any(os.path.lexists(parent/n) for n in ('bootstrap','bootstrap-entry.intent','owner-enrollment')):raise ValueError('Original owner bootstrap already consumed')
    pipe.transport(input_fd);pipe.transport(output_fd)
    root=parent/'bootstrap-exchange';root.mkdir(mode=0o700);c.sync_directory(parent)
    c.write_new(root/'ingress.intent',c.encode({'clock':owner['clock'],'native':native,'unit':unit,'resource':resource,'rpcReady':False}))
    ingress=min(start+8,until)
    size=struct.unpack('!I',pipe.read_exact(input_fd,4,ingress))[0]
    if not 0<size<=LIMIT:raise ValueError('Native enrollment frame bound')
    raw=pipe.read_exact(input_fd,size,ingress);frame=decode(raw)
    # Require actual EOF before any owner submission. Trailing frames consume and
    # refuse this exchange; a stalled input is stopped by the independent unit.
    while True:
        left=ingress-time.monotonic()
        if left<=0:raise TimeoutError('Enrollment EOF cutoff')
        ready,_,_=select.select([input_fd],[],[],min(.05,left))
        if ready:
            if os.read(input_fd,1):raise ValueError('One enrollment only')
            break
    if set(frame)!={'schema','original','plan','enrollmentSha256','enrollment'} or frame['schema']!='native-rpc-bootstrap-enrollment/1' or any(frame[k]!=v for k,v in native.items()):raise ValueError('Original native frame differs')
    c.protocol.digest(frame['enrollmentSha256'])
    enrolled=frame['enrollment'];nested=c.encode(enrolled)
    if len(nested)>65536:raise ValueError('Original owner enrollment bound')
    if (set(enrolled)!={'token','vmGuid','ownershipReceiptSha256','originalOriginMs','originalDeadlineMs','enrollment'} or
            any(enrolled[k]!=v for k,v in template['native'].items()) or
            enrolled['originalOriginMs']!=str(original['windowsOriginMilliseconds']) or enrolled['originalDeadlineMs']!=str(original['windowsDeadlineMilliseconds'])):
        raise ValueError('Native enrollment reset or substituted original identity')
    enrollment=c.write_new(root/'enrollment.json',nested)
    owner={**owner,'enrollment':enrollment};binding=c.write_new(root/'owner-entry.json',c.encode(owner))
    c.validate(owner['clock']);b.verify_pins(owner['pins'])
    if time.monotonic()>=until-3 or c.remaining(owner['clock'])<125:raise ValueError('Original owner submission time exhausted')
    c.write_new(root/'submit.intent',c.encode({'clock':owner['clock'],'owner':binding,'native':native,'nativeEnrollmentSha256':frame['enrollmentSha256'],'enrollment':enrollment,'rpcReady':False}))
    if continuous:submit(binding,original,True)
    else:submit(binding,original)
    while time.monotonic()<until:
        c.validate(owner['clock']);offer=read_offer(parent,enrollment,owner)
        if offer is not None:break
        time.sleep(.01)
    else:raise TimeoutError('Original owner offer absent; held')
    response=c.encode({'schema':'native-rpc-bootstrap-offer/1','enrollmentSha256':frame['enrollmentSha256'],'offer':offer}).strip()
    if len(response)>LIMIT:raise ValueError('Native framed offer bound')
    c.validate(owner['clock']);c.write_new(root/'response.json',response)
    write_frame(output_fd,response,until)
    return {'rpcReady':False,'reservationMayRelease':False}


if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:raise SystemExit('One protected operator exchange configuration required')
    try:run(c.protocol.decode(c.read(sys.argv[1])))
    except Exception:
        print('Owner exchange refused or ambiguous; original attempt retained',file=sys.stderr);raise SystemExit(1)
