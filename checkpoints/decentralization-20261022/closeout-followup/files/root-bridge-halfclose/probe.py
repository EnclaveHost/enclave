import socket,threading,time,tempfile,importlib.util,json,hashlib
from pathlib import Path
here=Path(__file__).resolve().parent
source=here/'runner-snapshot.py'
spec=importlib.util.spec_from_file_location('candidate_runner',source)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
stop=threading.Event()
server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(.2)
threads=[]
def respond(s):
    try:
        s.settimeout(2)
        while s.recv(1024): pass
        while not stop.is_set():
            s.sendall(b'x'*1024);time.sleep(.01)
    except OSError: pass
    finally: s.close()
def accept():
    while not stop.is_set():
        try: c,_=server.accept()
        except socket.timeout: continue
        except OSError: break
        t=threading.Thread(target=respond,args=(c,),daemon=True);t.start();threads.append(t)
t=threading.Thread(target=accept,daemon=True);t.start()
with tempfile.TemporaryDirectory() as d:
    path=d+'/bridge';listener=socket.socket(socket.AF_UNIX);listener.bind(path);listener.listen()
    cfg=dict(m.BRIDGE_DEFAULTS,maxConns=1,maxConnsPerEndpoint=1)
    bridge=m.Bridge(True,cfg);bridge.add(listener,server.getsockname());bridge.start()
    a=socket.socket(socket.AF_UNIX);a.settimeout(2);a.connect(path)
    assert a.recv(1)==b'\1'
    a.sendall(b'request');a.shutdown(socket.SHUT_WR)
    first=a.recv(1024)
    b=socket.socket(socket.AF_UNIX);b.settimeout(2);b.connect(path)
    status=b.recv(1)
    time.sleep(.1)
    rest=bytearray();old_closed=False
    try:
        for _ in range(100):
            data=a.recv(65536)
            if not data: old_closed=True;break
            rest.extend(data)
    except OSError: old_closed=True
    stats=bridge.stop();a.close();b.close()
stop.set();server.close();t.join(1)
for th in threads: th.join(2)
out={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'firstTransferBytes':len(first),'newConnectionStatus':status.hex(),'healthyHalfClosedTransferTerminated':old_closed,'halfClosedEvicted':stats['halfClosedEvicted'],'loopError':stats['loopError'],'openAtStop':stats['openAtStop'],'note':'Offline real AF_UNIX to TCP bridge. Old peer half-closes request and continuously receives response; new connection arrives at configured cap1. No production test.'}
(here/'result.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
