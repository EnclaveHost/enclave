"""Fixed one-shot SSH/native -> independent local owner -> native frame bridge.

No transport exit is remote-death evidence. Native supervision and the original
owner service retain their own deadlines; ambiguous attempts are never replayed.
"""
import hashlib
import importlib.util
import ipaddress
import os
from pathlib import Path
import re
import selectors
import struct
import subprocess
import sys
import time
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('rpc_operator_exchange',HERE/'owner_bootstrap_exchange.py')
x=importlib.util.module_from_spec(spec);spec.loader.exec_module(x)
c=x.c


def envelope(original):
    unit='enclave-rpc-operator-bootstrap-'+original['attempt']+'.service';row=x.b.e.show(unit)
    expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'Type':'exec','RuntimeMaxUSec':'40s','TimeoutStopUSec':'1s','MemoryMax':str(128<<20),
        'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group',
        'Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    c.hex32(expected['InvocationID'])
    if any(row[k]!=v for k,v in expected.items()) or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Independent operator transport required')
    start=int(row['ExecMainStartTimestampMonotonic'])*1000
    if not 0<=time.monotonic_ns()-start<5_000_000_000 or start+170_000_000_000>=original['deadlineMonotonicNs']:raise ValueError('Operator/owner must fit original window')
    return row


def native_command(cfg,original,key_fd,hosts_fd):
    fields={'host','user','port','key','knownHosts','controller','manager','managerSha256','original','bootstrap','bootstrapSha256','sshSha256'}
    if set(cfg)!=fields:raise ValueError('Exact fixed native SSH configuration required')
    ip=ipaddress.ip_address(cfg['host'])
    if str(ip)!=cfg['host'] or ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local:raise ValueError('Explicit native host required')
    if not re.fullmatch('[A-Za-z0-9_-]{1,32}',cfg['user']) or type(cfg['port']) is not int or not 1<=cfg['port']<=65535:raise ValueError('Explicit SSH identity/port required')
    for n in ('controller','manager','bootstrap'):
        if not isinstance(cfg[n],str) or not re.fullmatch(r'[A-Z]:\\[A-Za-z0-9_.\\-]{1,240}',cfg[n]) or '..' in cfg[n].split('\\'):raise ValueError('Fixed canonical native command path required')
    for n in ('managerSha256','bootstrapSha256','original','sshSha256'):c.protocol.digest(cfg[n])
    if cfg['original']!=original:raise ValueError('Original native attempt differs')
    with open('/usr/bin/ssh','rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=cfg['sshSha256']:raise ValueError('Pinned SSH executable changed')
    remote='"'+cfg['controller']+'" bootstrap-staged "'+cfg['manager']+'" '+cfg['managerSha256']+' '+original+' "'+cfg['bootstrap']+'" '+cfg['bootstrapSha256']
    # OpenSSH closes inherited descriptors above stderr before reading options.
    # Retain the exact input in THIS process; SSH opens its parent's pinned inode.
    # A dead parent cannot provide a replacement identity or trigger a retry.
    held_root='/proc/'+str(os.getpid())+'/fd/'
    return ['/usr/bin/ssh','-F','/dev/null','-T','-q','-p',str(cfg['port']),'-i',held_root+str(key_fd),
        '-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','PasswordAuthentication=no',
        '-o','KbdInteractiveAuthentication=no','-o','PreferredAuthentications=publickey','-o','ClearAllForwardings=yes',
        '-o','ConnectTimeout=3','-o','ServerAliveInterval=2','-o','ServerAliveCountMax=2',
        '-o','GlobalKnownHostsFile=/dev/null','-o','UserKnownHostsFile='+held_root+str(hosts_fd),
        cfg['user']+'@'+cfg['host'],remote]


def exchange_command(binding,attempt):
    props=['Type=exec','RuntimeMaxSec=20','TimeoutStopSec=1','MemoryMax=128M','MemorySwapMax=0','CPUQuota=100%',
        'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
    return ['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit=enclave-rpc-owner-exchange-'+attempt+'.service',
        *['--property='+p for p in props],'/usr/bin/python3','-B',str(HERE/'owner_bootstrap_exchange.py'),binding['path']]


def split_frame(data,offset=0):
    if len(data)-offset<4:return None
    n=struct.unpack('!I',data[offset:offset+4])[0]
    if not 0<n<=x.LIMIT:raise ValueError('Bootstrap frame bound')
    if len(data)-offset<4+n:return None
    return bytes(data[offset:offset+4+n]),x.decode(bytes(data[offset+4:offset+4+n]))


def bridge(native_args,exchange_args,pass_fds,expected,root,clock,until):
    processes={};streams={};buffers={};pending={};closed=set();sel=selectors.DefaultSelector();enrolled=None;enrolled_wire=None;offered=False
    def spawn(name,args,wire=None,fds=()):
        p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=fds)
        processes[name]=p
        for label,pipe in (('out',p.stdout),('err',p.stderr)):
            os.set_blocking(pipe.fileno(),False);key=name+'-'+label;streams[key]=pipe;buffers[key]=bytearray();sel.register(pipe,selectors.EVENT_READ,key)
        os.set_blocking(p.stdin.fileno(),False)
        if wire is not None:queue(name,wire)
    def queue(name,wire):
        key=name+'-in';pending[key]=memoryview(wire);streams[key]=processes[name].stdin;sel.register(streams[key],selectors.EVENT_WRITE,key)
    try:
        c.write_new(root/'native-submit.intent',c.encode({'clock':clock,'native':expected,'rpcReady':False}))
        spawn('native',native_args,fds=pass_fds)
        while True:
            if time.monotonic()>=until:raise TimeoutError('Bootstrap transport ambiguous; held')
            c.validate(clock)
            for key,_ in sel.select(.01):
                name=key.data
                if name.endswith('-in'):
                    try:n=os.write(key.fd,pending[name][:65536])
                    except (BlockingIOError,InterruptedError):continue
                    if n<=0:raise ValueError('Bootstrap input failed')
                    pending[name]=pending[name][n:]
                    if not pending[name]:sel.unregister(key.fileobj);key.fileobj.close();closed.add(name)
                else:
                    try:chunk=os.read(key.fd,4096)
                    except (BlockingIOError,InterruptedError):continue
                    if not chunk:sel.unregister(key.fileobj);closed.add(name);continue
                    buffers[name].extend(chunk)
                    cap=8192 if name.endswith('-err') else (2 if name=='native-out' else 1)*(x.LIMIT+4)
                    if len(buffers[name])>cap:raise ValueError('Bootstrap output bound')
            if enrolled is None:
                first=split_frame(buffers['native-out'])
                if first is not None:
                    enrolled_wire,enrolled=first
                    if (set(enrolled)!={'schema','original','plan','enrollmentSha256','enrollment'} or enrolled['schema']!='native-rpc-bootstrap-enrollment/1' or
                            any(enrolled[k]!=v for k,v in expected.items())):raise ValueError('Native enrollment lineage differs')
                    c.protocol.digest(enrolled['enrollmentSha256'])
                    c.write_new(root/'exchange-submit.intent',c.encode({'clock':clock,'enrollmentSha256':enrolled['enrollmentSha256'],'wireSha256':hashlib.sha256(enrolled_wire).hexdigest(),'rpcReady':False}))
                    spawn('owner',exchange_args,enrolled_wire)
            if enrolled is not None and not offered and 'owner-out' in closed and 'owner-err' in closed:
                code=processes['owner'].poll()
                if code is not None:
                    if code!=0:raise ValueError('Original owner exchange failed; held')
                    reply=split_frame(buffers['owner-out'])
                    if reply is None or len(reply[0])!=len(buffers['owner-out']):raise ValueError('One complete owner response required')
                    wire,value=reply
                    if set(value)!={'schema','enrollmentSha256','offer'} or value['schema']!='native-rpc-bootstrap-offer/1' or value['enrollmentSha256']!=enrolled['enrollmentSha256']:raise ValueError('Owner response belongs to another enrollment')
                    c.write_new(root/'offer.json',wire[4:]);queue('native',wire);offered=True
            code=processes['native'].poll()
            if code is not None and 'native-out' in closed and 'native-err' in closed:
                if code!=0 or not offered or 'native-in' not in closed:raise ValueError('Native bootstrap incomplete; held')
                last=split_frame(buffers['native-out'],len(enrolled_wire))
                if last is None or len(enrolled_wire)+len(last[0])!=len(buffers['native-out']):raise ValueError('Exact final native result required')
                raw,result=last
                if (set(result)!={'schema','original','plan','enrollmentSha256','acquisitionRequested','rpcReady','providerOperationFenced','reservationMayRelease'} or
                        result['schema']!='native-rpc-bootstrap-result/1' or any(result[k]!=v for k,v in expected.items()) or result['enrollmentSha256']!=enrolled['enrollmentSha256'] or
                        result['acquisitionRequested'] is not True or any(result[k] is not False for k in ('rpcReady','providerOperationFenced','reservationMayRelease'))):raise ValueError('Unqualified native result')
                c.validate(clock);c.write_new(root/'response.json',raw[4:]);return result
    finally:
        sel.close()
        for p in processes.values():
            if p.poll() is None:p.kill();p.wait(timeout=1)
            for stream in (p.stdin,p.stdout,p.stderr):stream.close()
        # Only local SSH/systemd-run transports have been reaped. Independent
        # native/owner service death and writer settlement are NOT asserted.


def run(config):
    if set(config)!={'schema','exchange','native'} or config['schema']!='enclave-rpc-operator-bootstrap/1':raise ValueError('Exact original operator configuration required')
    exchange=c.protocol.decode(c.read_pinned(config['exchange']))
    if set(exchange)!={'schema','owner','native'} or exchange['schema']!='enclave-rpc-owner-exchange/1':raise ValueError('Pinned owner exchange required')
    owner=exchange['owner'];original=c.validate(owner['clock']);unit=envelope(original);x.b.verify_pins(owner['pins'])
    resource,template=x.admission(owner)
    export=c.protocol.decode(c.read_pinned(template['exportPreparation']))
    if resource['availableMiB']-resource['pendingMiB']-1792<max(27648,export['floorMiB'],resource['floorMiB']):raise ValueError('Whole operator/owner capacity refused')
    parent=c.directory(Path(owner['clock']['path']).parent)
    if any(os.path.lexists(parent/n) for n in ('bootstrap-exchange','owner-enrollment','bootstrap-entry.intent','bootstrap')):raise ValueError('Original bootstrap already consumed')
    fds=[]
    try:
        for name in ('key','knownHosts'):
            binding=config['native'][name];fds.append(x.b.e.held(binding['path'],16384,wanted=binding['sha256']))
        args=native_command(config['native'],exchange['native']['original'],*fds)
        root=parent/'bootstrap-transport';root.mkdir(mode=0o700);c.sync_directory(parent)
        c.write_new(root/'transport.intent',c.encode({'clock':owner['clock'],'exchange':config['exchange'],'native':exchange['native'],'unit':unit,'resource':resource,'rpcReady':False}))
        c.validate(owner['clock']);x.b.verify_pins(owner['pins'])
        return bridge(args,exchange_command(config['exchange'],original['attempt']),(),exchange['native'],root,owner['clock'],min(int(unit['ExecMainStartTimestampMonotonic'])/1e6+39,original['deadlineMonotonicNs']/1e9))
    finally:
        for fd in fds:os.close(fd)


if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:raise SystemExit('One protected operator configuration required')
    try:print(c.encode(run(c.protocol.decode(c.read(sys.argv[1])))).decode(),end='')
    except Exception:
        print('Bootstrap transport refused or ambiguous; original attempt retained',file=sys.stderr);raise SystemExit(1)
