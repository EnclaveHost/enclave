import hashlib
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'shielded'))
from protocol import *
from public_weight_cache import PublicWeightCache
import wire

def request(action, bid, data, offset=0, digest=None):
    return struct.pack('<BQQQ', action, bid, offset, len(data)) + (digest or hashlib.sha256(data).digest())

class CacheTests(unittest.TestCase):
    def test_cuda_missing_kernel_refuses_before_listening(self):
        import worker
        with patch.object(worker, 'DEVICE', 'cuda'), \
             patch.object(worker.torch.cuda, 'is_available', return_value=True), \
             patch.object(worker, '_field_kernel', side_effect=ImportError('fixture missing kernel')), \
             patch.object(worker.socket, 'socket') as listen:
            with self.assertRaisesRegex(ImportError, 'fixture missing kernel'):
                worker.serve('127.0.0.1', 0, 1, quiet=True)
            listen.assert_not_called()

    def test_identity_eviction_and_private_copies(self):
        cache=PublicWeightCache(16)
        a,b,c=bytearray(b'a'*8),b'b'*8,b'c'*8
        da,db,dc=[hashlib.sha256(v).digest() for v in (a,b,c)]
        def get(d,n=8):
            out=bytearray(n)
            hit=cache.copy_to(d,n,lambda entry:out.__setitem__(slice(None),entry))
            return hit,bytes(out)
        self.assertTrue(cache.admit(da,a)); a[0]=99
        self.assertEqual(get(da),(True,b'a'*8))
        self.assertTrue(cache.admit(db,b)); self.assertTrue(cache.admit(da,b'a'*8))
        with self.assertRaises(ValueError):cache.admit(da,b)
        self.assertTrue(cache.admit(dc,c)); self.assertFalse(get(db)[0])
        self.assertFalse(get(da,7)[0]); self.assertTrue(get(da)[0])
        self.assertFalse(cache.admit(hashlib.sha256(b'x'*17).digest(),b'x'*17))
        self.assertLessEqual(cache.used,16)
        self.assertFalse(PublicWeightCache().admit(da,b'a'*8))

    def test_admission_and_reservations(self):
        ledger=ReservationLedger(4096)
        s=ShieldedWorkerState(4096,ledger=ledger,public_weight_cache_bytes=1024)
        good=request(0,1,b'a'*8)
        with self.assertRaises(ProtocolViolation):s.handle(CMD_PUBLIC_WEIGHT_CACHE,good)
        hello=s.handle(CMD_HELLO,struct.pack('<IQ',1,1024))
        self.assertEqual(hello['public_weight_cache_bytes'],1024)
        weights=s.handle(CMD_ALLOC_BUFFER,wire.pack_alloc(64,'weights'))['bid']
        activation=s.handle(CMD_ALLOC_BUFFER,wire.pack_alloc(104,'activations'))['bid']
        for payload in [good[:i] for i in range(57)]+[good+b'x',bytes([2])+good[1:],
                        request(0,activation,b'a'*8),request(0,999,b'a'*8),
                        request(0,weights,b'a'*8,60),request(0,weights,b'a'*8,2**64-1),
                        request(0,weights,b'')]:
            with self.assertRaises(ProtocolViolation):s.handle(CMD_PUBLIC_WEIGHT_CACHE,payload)
        s.handle(CMD_PUBLIC_WEIGHT_CACHE,good)
        self.assertEqual((s.allocated,s.host_allocated,ledger.reserved),(104,64,1024))
        spec={'nodes':[{'op':'FIELD_GEMM','K':32,'N':2}],
              'outputs':[{'bid':activation,'offset':96,'nbytes':8}]}
        s.handle(CMD_GRAPH_INSTALL,json.dumps(spec).encode())
        self.assertEqual((s.allocated,s.host_allocated,ledger.reserved),(168,0,1024))
        with self.assertRaises(ProtocolViolation):s.handle(CMD_PUBLIC_WEIGHT_CACHE,good)
        s.release(); self.assertEqual(ledger.reserved,0)
        disabled=ShieldedWorkerState(4096)
        disabled.handle(CMD_HELLO,struct.pack('<I',1))
        disabled.handle(CMD_ALLOC_BUFFER,wire.pack_alloc(64,'weights'))
        with self.assertRaises(ProtocolViolation):disabled.handle(CMD_PUBLIC_WEIGHT_CACHE,good)

    def test_real_cpu_worker_reconnect_and_field_result(self):
        import worker
        import numpy as np
        self.assertNotIn('fused_field_gemm', sys.modules, 'CPU import must not require Triton')
        worker.DEVICE='cpu'
        worker.torch.set_num_threads(1)
        cache=PublicWeightCache(64); ledger=ReservationLedger(4096)
        data=bytes(range(64)); outputs=[]
        for cold in (True,False):
            c=worker.Connection(None,'test',4096,lambda _:None,ledger,cache)
            c.handle(CMD_HELLO,struct.pack('<IQ',1,1024))
            bid=struct.unpack('<Q',c.handle(CMD_ALLOC_BUFFER,wire.pack_alloc(64,'weights')))[0]
            abid=struct.unpack('<Q',c.handle(CMD_ALLOC_BUFFER,wire.pack_alloc(104,'activations')))[0]
            self.assertEqual(c.handle(CMD_PUBLIC_WEIGHT_CACHE,request(0,bid,data)),bytes([not cold]))
            if cold:
                c.handle(CMD_SET_TENSOR,wire.pack_set_tensor(bid,0,data))
                self.assertEqual(c.handle(CMD_PUBLIC_WEIGHT_CACHE,request(1,bid,data)),b'\1')
            # Mutating a link buffer cannot poison the retained public copy.
            c.handle(CMD_SET_TENSOR,wire.pack_set_tensor(bid,0,b'\0'*64))
            self.assertEqual(c.handle(CMD_PUBLIC_WEIGHT_CACHE,request(0,bid,data)),b'\1')
            spec={'nodes':[{'op':'FIELD_GEMM','K':32,'N':2,'max_m':1,
                   'w':{'bid':bid,'offset':0},'x':{'bid':abid,'offset':0},
                   'y':{'bid':abid,'offset':96}}],
                  'outputs':[{'bid':abid,'offset':96,'nbytes':8}]}
            c.handle(CMD_GRAPH_INSTALL,json.dumps(spec).encode())
            # Three residue planes of public test input ones: expected row sums.
            payload=struct.pack('<III',1,1,0)+bytes([1])*96
            outputs.append(c.handle(CMD_FIELD_GEMM24,payload))
            self.assertEqual(c.state.allocated,168)
            with self.assertRaises(ProtocolViolation):c.handle(CMD_PUBLIC_WEIGHT_CACHE,request(0,bid,data))
            c.storage.clear(); c.nodes.clear(); c.state.release()
            self.assertEqual(ledger.reserved,0)
        expected=b''.join(int(v).to_bytes(3,'little',signed=True)
                          for v in np.frombuffer(data,dtype=np.uint8).reshape(2,32).sum(axis=1))
        self.assertEqual(outputs,[expected,expected])
        self.assertEqual(cache.used,64)
        self.assertNotIn('fused_field_gemm', sys.modules, 'CPU arithmetic must not load a CUDA kernel')

if __name__=='__main__':unittest.main()
