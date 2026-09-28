#!/usr/bin/env python3
"""Compare multislotted recurrent in-place updates with copies on a hybrid GGUF.
Usage: --runtime <measured closure rt> --model <small hybrid GGUF> --out <new dir>
The model is CPU-only; eight resident sessions branch into sixteen, diverge,
rewind one speculative token and recycle cells. Full logits must agree.
"""
import argparse, array, math, os, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for n in ('runtime','model','out'): p.add_argument('--'+n,type=Path,required=True)
a=p.parse_args();rt=a.runtime.resolve();w=a.out.resolve();w.mkdir();repo=Path(__file__).resolve().parents[2]
def run(cmd,**kw):return subprocess.run([str(x) for x in cmd],check=True,**kw)
run(['g++','-O2','-I',repo/'wasm/llama-shim',repo/'test/fixtures/rs-multislot.cpp','-L',rt,'-lenclave_llama','-Wl,-rpath-link,'+str(rt),'-o',w/'fixture'])
env=dict(os.environ,ENCLAVE_GGML_BACKEND_DIR=str(rt/'backends'),GGML_BACKEND_PATH=str(rt/'backends/libggml-cpu.so'),ENCLAVE_GGML_N_THREADS='2',ENCLAVE_GGML_N_THREADS_BATCH='2',ENCLAVE_GGML_N_UBATCH='16',ENCLAVE_GGML_N_RS_SEQ='1',ENCLAVE_RS_DEBUG='1')
for alias in ('0','1'):
 with (w/('rs-'+alias+'.txt')).open('w') as f:
  run([rt/'ld-linux-x86-64.so.2','--library-path',rt,w/'fixture',a.model.resolve(),w/('rs-'+alias+'.bin')],env=dict(env,ENCLAVE_GGML_RS_ALIAS=alias),stdout=f,stderr=subprocess.STDOUT)
rows=[]
for alias in ('0','1'):
 r=array.array('f');r.frombytes((w/('rs-'+alias+'.bin')).read_bytes());rows.append(r)
assert len(rows[0])==len(rows[1]) and len(rows[0])>0
assert all(math.isfinite(x) for r in rows for x in r)
d=max(abs(x-y) for x,y in zip(*rows));assert d<0.0001,d
print('RS_MULTISLOT_PASS; max_logit_difference=',d)
