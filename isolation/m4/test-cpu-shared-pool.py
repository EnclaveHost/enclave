#!/usr/bin/env python3
"""Exercise concurrent CPU backends and graph plans sharing one native team."""
import argparse, os, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for k in ('engine-src','runtime','out'): p.add_argument('--'+k,type=Path,required=True)
p.add_argument('--cpus',default='0,2,3,4,5,6')
a=p.parse_args();r=Path(__file__).resolve().parents[2];a.out.mkdir();rt=a.runtime.resolve();exe=a.out.resolve()/'fixture'
subprocess.run(['g++','-O2','-pthread','-DGGML_MAX_NAME=128','-I',str(a.engine_src.resolve()/'ggml/include'),str(r/'test/fixtures/cpu-shared-pool.cpp'),'-L',str(rt/'backends'),'-L',str(rt),'-lggml-cpu','-l:libggml.so.0','-l:libggml-base.so.0','-Wl,-rpath-link,'+str(rt),'-o',str(exe)],check=True)
env={**os.environ,'SHIELDED_CPU_COMPUTE':a.cpus,'ENCLAVE_GGML_SHARED_CPU_POOL':'1'}
subprocess.run([str(rt/'ld-linux-x86-64.so.2'),'--library-path',str(rt)+':'+str(rt/'backends'),str(exe)],env=env,check=True)
