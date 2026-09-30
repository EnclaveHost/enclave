from pathlib import Path
import os,socket,subprocess,sys,threading
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'shielded'))
import worker,wire
from protocol import *
from public_weight_cache import PublicWeightCache
worker.DEVICE='cpu';worker.torch.set_num_threads(1)
servers=[];threads=[];errors=[];counts=[]
def serve(server):
 try:
  ledger=ReservationLedger(16<<20);cache=PublicWeightCache(2<<20)
  for turn in range(4 if os.environ.get('TEST_COMPACT') else 3):
   sock,addr=server.accept();sock.settimeout(15)
   c=worker.Connection(sock,addr,16<<20,lambda _:None,ledger,cache);gemms=0
   try:
    while True:
     cmd,payload=wire.recv_request(sock)
     if cmd in (CMD_FIELD_GEMM,CMD_FIELD_GEMM24):
      gemms+=1
      if turn==1 and gemms==2:break
     reply=c.handle(cmd,payload);sock.sendall(wire.build_response(wire.STATUS_OK,reply))
     if turn==0 and gemms==1:break
   except (EOFError,ConnectionError):pass
   finally:c.nodes.clear();c.storage.clear();c.state.release();sock.close()
   counts.append((turn,gemms))
 except BaseException as e:errors.append(e)
for i in range(2):
 s=socket.socket();s.bind(('127.0.0.1',0));s.listen(3);s.settimeout(20);servers.append(s)
 t=threading.Thread(target=serve,args=(s,),daemon=True);t.start();threads.append(t)
env={k:v for k,v in os.environ.items() if not k.startswith('SHIELDED_')}
r=subprocess.run(sys.argv[1:]+[str(s.getsockname()[1]) for s in servers],env=env,timeout=45)
for t in threads:t.join(3)
for s in servers:s.close()
assert r.returncode==0 and not errors,(r.returncode,errors,counts)
assert sum(turn==0 and n==1 for turn,n in counts)==2,counts
assert sum(turn==1 and n==2 for turn,n in counts)==2,counts
print('actual CPU workers: both split connections recovered')
