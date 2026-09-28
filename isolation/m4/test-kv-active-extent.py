#!/usr/bin/env python3
"""Compare attention-cache tail trimming with full extents on a hybrid GGUF.
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
run(['g++','-O2','-I',repo/'wasm/llama-shim',repo/'test/fixtures/kv-active-extent.cpp','-L',rt,'-lenclave_llama','-Wl,-rpath-link,'+str(rt),'-o',w/'fixture'])
env=dict(os.environ,ENCLAVE_GGML_BACKEND_DIR=str(rt/'backends'),GGML_BACKEND_PATH=str(rt/'backends/libggml-cpu.so'),ENCLAVE_GGML_N_THREADS='2',ENCLAVE_GGML_N_THREADS_BATCH='2',ENCLAVE_GGML_N_UBATCH='64',ENCLAVE_GGML_N_RS_SEQ='1',ENCLAVE_KV_EXTENT_DEBUG='1')
for alias in ('0','1'):
 with (w/('kv-'+alias+'.txt')).open('w') as f:
  run([rt/'ld-linux-x86-64.so.2','--library-path',rt,w/'fixture',a.model.resolve(),w/('kv-'+alias+'.bin')],env=dict(env,ENCLAVE_GGML_KV_ACTIVE_EXTENT=alias),stdout=f,stderr=subprocess.STDOUT)
rows=[]
for alias in ('0','1'):
 r=array.array('f');r.frombytes((w/('kv-'+alias+'.bin')).read_bytes());rows.append(r)
assert len(rows[0])==len(rows[1]) and len(rows[0])>0
assert all(math.isfinite(x) for r in rows for x in r)
d=max(abs(x-y) for x,y in zip(*rows));assert d == 0,d
assert "[kv-extent]" in (w/"kv-1.txt").read_text(), "fixture did not exercise tail trimming"
print('KV_ACTIVE_EXTENT_PASS; max_logit_difference=',d)
