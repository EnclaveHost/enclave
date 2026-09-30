#!/usr/bin/env python3
"""Build the offline prototype; never modifies runtime binaries or services."""
import argparse
from pathlib import Path
import subprocess

p=argparse.ArgumentParser()
p.add_argument('output',type=Path)
p.add_argument('--sanitize',action='store_true')
p.add_argument('--ggml-src',type=Path,default=Path.home()/'Projects/llama.cpp')
p.add_argument('--ggml-lib',type=Path,default=Path.home()/'Projects/llamacpp-lib')
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[2];src=root/'wasm/ggml-shielded'
flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer'] if a.sanitize else ['-O3']
flags+=['-ffp-contract=off','-ffunction-sections','-fdata-sections']
objects=[]
for name in ['shielded-simd','shielded-field','tweetnacl']:
    obj=a.output/(name+'.o');objects.append(str(obj))
    extra=['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-DSH_SIMD_AVX512'] if name=='shielded-simd' else []
    subprocess.run(['cc',*flags,*extra,'-c',str(src/(name+'.c')),'-o',str(obj)],check=True)
subprocess.run(['c++',*flags,'-std=c++17','-I'+str(a.ggml_src/'ggml/include'),
    str(root/'shielded/bench/streamed-refill.cpp'),*objects,'-L'+str(a.ggml_lib),
    '-lggml','-lggml-base','-lcrypto','-pthread','-lm','-Wl,--gc-sections',
    '-Wl,-rpath,'+str(a.ggml_lib),'-o',str(a.output/'bench')],check=True)
print(a.output/'bench')
