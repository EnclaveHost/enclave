#!/usr/bin/env python3
"""Proof harness: no default route, no DNS, exact TCP endpoints over AF_UNIX bridges."""
import os,sys,json,socket,ssl,threading,subprocess,pathlib,select,tempfile,shutil,datetime
ROOT=pathlib.Path(__file__).resolve().parent
REPO=ROOT.parent/'enclave'
def forward(a,b):
    try:
        while True:
            ready,_,_=select.select([a,b],[],[],40)
            if not ready: break
            for source in ready:
                data=source.recv(65536)
                if not data:return
                (b if source is a else a).sendall(data)
    except OSError: pass
    finally:a.close();b.close()
def take(sock,n):
    out=b''
    while len(out)<n:
        part=sock.recv(n-len(out))
        if not part:raise OSError('short ClientHello')
        out+=part
    return out

def tls_hello(sock):
    header=take(sock,5)
    if header[0]!=22:raise OSError('not TLS handshake')
    data=take(sock,int.from_bytes(header[3:5],'big'))
    if data[0]!=1:raise OSError('not ClientHello')
    pos=4+2+32
    pos+=1+data[pos]
    n=int.from_bytes(data[pos:pos+2],'big');pos+=2+n
    pos+=1+data[pos]
    end=pos+2+int.from_bytes(data[pos:pos+2],'big');pos+=2
    while pos<end:
        kind=int.from_bytes(data[pos:pos+2],'big');n=int.from_bytes(data[pos+2:pos+4],'big');pos+=4
        if kind==0:
            field=data[pos:pos+n]
            if field[2]!=0:raise OSError('non-host SNI')
            size=int.from_bytes(field[3:5],'big')
            return header+data,field[5:5+size].decode('ascii')
        pos+=n
    raise OSError('missing SNI')

def unix_server(endpoint):
    listener=socket.socket(socket.AF_UNIX);listener.bind(endpoint['socket']);listener.listen(64)
    def loop():
        while True:
            try:a,_=listener.accept()
            except OSError:return
            def connect(a):
                try:
                    first=b''
                    if endpoint['port']==443:
                        a.settimeout(10);first,sni=tls_hello(a)
                        if sni not in endpoint['sni']:raise OSError('SNI forbidden')
                    b=socket.create_connection((endpoint['ip'],endpoint['port']),10)
                    if first:b.sendall(first)
                except (OSError,IndexError,UnicodeError):a.close();return
                forward(a,b)
            threading.Thread(target=connect,args=(a,),daemon=True).start()
    threading.Thread(target=loop,daemon=True).start();return listener

def child(manifest):
    m=json.load(open(manifest));p_hostname=json.load(open(m['profile']))['hostname']
    subprocess.run(['mount','--make-rprivate','/'],check=True)
    subprocess.run(['mount','--bind',m['hosts'],'/etc/hosts'],check=True)
    subprocess.run(['mount','--bind',m['resolv'],'/etc/resolv.conf'],check=True)
    subprocess.run(['ip','link','set','lo','up'],check=True)
    # Hide the previously used runtime, bundle cache and transfer archive in
    # this private mount namespace. The client must retrieve public bytes.
    hidden=[ROOT.parent/'direct-bootstrap-hardware-release-v3',ROOT.parent/'bootstrap-hardware/guests/store']
    empty=ROOT/'empty-local-artifacts';empty.mkdir(exist_ok=True)
    for local in hidden:subprocess.run(['mount','--bind',str(empty),str(local)],check=True)
    blank=ROOT/'empty-archive';blank.write_bytes(b'')
    subprocess.run(['mount','--bind',str(blank),str(ROOT/'artifacts.tar.gz')],check=True)
    listeners=[]
    for ip in sorted(set(e['ip'] for e in m['endpoints'])):
        subprocess.run(['ip','address','add',ip+'/32','dev','lo'],check=True)
    for e in m['endpoints']:
        listener=socket.socket();listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);listener.bind((e['ip'],e['port']));listener.listen(64);listeners.append(listener)
        def loop(listener,e):
            while True:
                try:a,_=listener.accept()
                except OSError:return
                def connect(a):
                    b=socket.socket(socket.AF_UNIX)
                    try:b.connect(e['socket'])
                    except OSError:a.close();b.close();return
                    forward(a,b)
                threading.Thread(target=connect,args=(a,),daemon=True).start()
        threading.Thread(target=loop,args=(listener,e),daemon=True).start()
    negative=[]
    for host,port in [('62.238.4.214',443),('192.168.8.238',443),('127.0.0.1',32423),('1.1.1.1',53),('146.190.246.39',8189),('146.190.246.39',443),('134.209.248.172',443)]:
        try:s=socket.create_connection((host,port),1);s.close();raise RuntimeError('blocked destination reachable')
        except OSError as err:negative.append({'host':host,'port':port,'blocked':True,'error':str(err)})
    dns=[]
    for hostname in ['enclave.host','api.enclave.host',p_hostname]:
        try:socket.getaddrinfo(hostname,443);raise RuntimeError('Enclave DNS unexpectedly available')
        except socket.gaierror:dns.append({'hostname':hostname,'blocked':True})
    api=[]
    for e in m['endpoints']:
        if e['port']!=443 or p_hostname not in e['sni']:continue
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);context.check_hostname=False;context.verify_mode=ssl.CERT_NONE
        try:
            with socket.create_connection((e['ip'],443),2) as raw:
                with context.wrap_socket(raw,server_hostname='api.enclave.host'):raise RuntimeError('API TLS allowed')
        except (ssl.SSLError,OSError):api.append({'ip':e['ip'],'servername':'api.enclave.host','blocked':True})
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(ROOT/'isolated-profile-result.json','w') as out,open(ROOT/'isolated-error.log','w') as err:
        run=subprocess.run(['node','scripts/network/native-profile.mjs','--profile',m['profile'],'--release-id','5ef70f6a950b1deadcf21119a0e02ba2f75dea029d870ef25a0e6d7940ac9aad','--artifact-gateways',','.join(json.load(open(m['profile']))['startup']['gateways']),'--vcpus','1','--out',str(ROOT/'isolated-client-profile.json')],cwd=REPO,stdout=out,stderr=err,timeout=180)
    json.dump({'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':run.returncode,'blockedProbes':negative,'blockedDNS':dns,'blockedAPISNI':api,'defaultRoutes':subprocess.check_output(['ip','route','show','default'],text=True).strip(),'allowedTCP':[{'ip':e['ip'],'port':e['port'],'sni':e['sni']} for e in m['endpoints']],'rpcDNS':m['rpcDNS'],'refusedPackageReplica':'http://146.190.246.39:8189/ipfs','generalInternet':False,'hiddenLocalArtifacts':[str(p) for p in hidden]+[str(ROOT/'artifacts.tar.gz')]},open(ROOT/'isolation.json','w'),indent=2)
    return run.returncode

def main():
    if len(sys.argv)>1 and sys.argv[1]=='child':return child(sys.argv[2])
    from urllib.parse import urlparse
    p=json.load(open(ROOT/'base-profile.json'));p['stateDir']=str(ROOT/'isolated-profile-state')
    # Simulate total refusal of one directory. Three others must suffice from a
    # new empty cache; no local production route state is mounted as input.
    p['startup']['gateways']=['http://146.190.246.39:8189/ipfs']+p['startup']['gateways'][1:]
    profile=ROOT/'isolated-profile.json';profile.write_text(json.dumps(p,indent=2)+'\n')
    if pathlib.Path(p['stateDir']).exists():raise RuntimeError('proof requires a fresh state directory')
    temp=pathlib.Path(tempfile.mkdtemp(prefix='enclave-native-netns-'));listeners=[]
    try:
        endpoints=set();dns={}
        for origin in p['rpc']:
            u=urlparse(origin);ip=socket.getaddrinfo(u.hostname,u.port or 443,socket.AF_INET,socket.SOCK_STREAM)[0][4][0]
            dns[u.hostname]=ip;endpoints.add((ip,u.port or 443))
        for origin in p['startup']['gateways'][1:]:
            u=urlparse(origin);endpoints.add((u.hostname,u.port or 80))
        entries=[{'ip':ip,'port':port,'socket':str(temp/str(i)),'sni':([name for name,addr in dns.items() if addr==ip] or [p['hostname']]) if port==443 else []} for i,(ip,port) in enumerate(sorted(endpoints))]
        hosts=temp/'hosts';hosts.write_text('127.0.0.1 localhost\n'+''.join(ip+' '+name+'\n' for name,ip in dns.items()))
        resolv=temp/'resolv.conf';resolv.write_text('nameserver 127.0.0.1\noptions timeout:1 attempts:1\n')
        manifest=temp/'manifest.json';manifest.write_text(json.dumps({'profile':str(profile),'hosts':str(hosts),'resolv':str(resolv),'rpcDNS':dns,'endpoints':entries}))
        for e in entries:listeners.append(unix_server(e))
        return subprocess.run(['unshare','--user','--map-root-user','--net','--mount','python3',str(pathlib.Path(__file__).resolve()),'child',str(manifest)],timeout=200).returncode
    finally:
        for l in listeners:l.close()
        shutil.rmtree(temp)
if __name__=='__main__':sys.exit(main())
