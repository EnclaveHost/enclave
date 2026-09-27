#!/usr/bin/env python3
"""Exercise the production backend's parser, without opening GPU connections.
Usage: check-shielded-worker-config.py /absolute/runtime
"""
import ctypes, os, subprocess, sys
from pathlib import Path
rt=Path(sys.argv[1]).resolve()
if len(sys.argv)>2:
 ctypes.CDLL(str(rt/'libggml-base.so.0'),mode=ctypes.RTLD_GLOBAL)
 ctypes.CDLL(str(rt/'libggml.so.0'),mode=ctypes.RTLD_GLOBAL)
 lib=ctypes.CDLL(str(rt/'backends/libggml-shielded.so'),mode=ctypes.RTLD_GLOBAL)
 # The setter parses the pool before installing this callback. No graph or
 # model is executed, and the callback is never called by this test.
 cb=ctypes.CFUNCTYPE(ctypes.c_int)(lambda:1)
 fn=lib.ggml_backend_shielded_set_weight_verifier
 fn.argtypes=[ctypes.c_void_p,ctypes.c_void_p];fn.restype=ctypes.c_int
 sys.exit(0 if fn(ctypes.cast(cb,ctypes.c_void_p),None)==0 else 2)
base='unix:/run/enclave-shield/gpu0|9501|0|16642998272'
ring='|/dev/enclave-shielded-shm/card-0|67108864'
for value,ok in [(base,True),(base+ring,True),
 (base+ring+'\nunix:/run/enclave-shield/gpu1|9502|0|16642998272|/dev/enclave-shielded-shm/card-1|67108864',True),
 (base+ring.replace('card-0','../elsewhere'),False),
 (base+ring.replace('/dev/enclave-shielded-shm','/dev/shm/untrusted'),False),
 (base+ring.replace('67108864','67108865'),False),
 (base.replace('gpu0','gpu0/../../elsewhere')+ring,False),
 (base.replace('|9501|0|','|9501|123|')+ring,False),
 (base+ring+'\n'+base.replace('gpu0','gpu1')+ring,False)]:
 env={**os.environ,'SHIELDED_WORKERS':value,'LD_LIBRARY_PATH':str(rt)+':'+str(rt/'backends')}
 r=subprocess.run([sys.executable,__file__,str(rt),'child'],env=env,capture_output=True,text=True)
 if (r.returncode==0)!=ok:raise SystemExit('parser result mismatch: '+r.stderr)
print('PASS: socket and shared-ring broker routes; malformed paths, sizes, duplicate rings and raw-vsock override refused')
