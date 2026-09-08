"""Drive the real C upload client against the actual CPU worker admission/cache.
End each leg just after successful graph resolution, before pad refill starts.
"""
from pathlib import Path
import os
import socket
import struct
import subprocess
import sys
import threading
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'shielded'))
import worker
import wire
from protocol import *
from public_weight_cache import PublicWeightCache
worker.DEVICE='cpu';worker.torch.set_num_threads(1)
cache=PublicWeightCache(2<<20);ledger=ReservationLedger(16<<20)
server=socket.socket();server.bind(('127.0.0.1',0));server.listen(2)
errors=[];stats=[]
def serve():
    try:
        for turn in range(2):
            sock,addr=server.accept();sock.settimeout(10)
            c=worker.Connection(sock,addr,16<<20,lambda _:None,ledger,cache)
            uploads=0
            try:
                while True:
                    cmd,payload=wire.recv_request(sock)
                    reply=c.handle(cmd,payload)
                    if cmd==CMD_SET_TENSOR:uploads+=1
                    if cmd==CMD_GRAPH_INSTALL:
                        assert len(c.nodes)==1
                        # Independent expected bytes check after the actual cache
                        # populated the new link's buffer and graph used it.
                        expected=worker.np.array([(i%31)-15 for i in range(64*17003)],dtype=worker.np.int8)
                        assert worker.np.array_equal(c.nodes[0].wf.numpy().reshape(-1),expected)
                        assert c.state.allocated==c.state.buffers[2].size+64*17003
                        sock.sendall(wire.build_response(wire.STATUS_VIOLATION,b'fixture: graph resolved'))
                        break
                    sock.sendall(wire.build_response(wire.STATUS_OK,reply))
            finally:
                c.nodes.clear();c.storage.clear();c.state.release();sock.close()
            stats.append(uploads)
    except BaseException as e:errors.append(e)
t=threading.Thread(target=serve);t.start()
try:
    subprocess.run([sys.argv[1],str(server.getsockname()[1])],check=True,timeout=20)
finally:
    t.join(timeout=15);server.close()
assert not t.is_alive() and not errors,(errors,stats)
assert stats==[2,0] and cache.used==64*17003,stats
print('public-cache-socket: C client and CPU worker cold/warm exact bytes PASS')
