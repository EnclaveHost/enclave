#!/usr/bin/env python3
"""Rebuild the accepted Shield engine patch set and its matching CPU module.

Inputs: a local llama.cpp git object store containing PIN and an existing
GGML-only runtime closure. Outputs: OUT/runtime, build logs and provenance.
Experimental regrow/ntsnap patches are deliberately not part of this recipe.
"""
import argparse, hashlib, json, os, shutil, subprocess
from pathlib import Path

PIN = 'ddd4ec1428a6201e18975ea52b07c71e0f9aef26'
PATCHES = ['graph-slot','cuda-graph-ptr-update','sync-instr','rs-pin-cells',
           'topk-rows','parallel-copy','parallel-rows','rs-inplace','rs-multislot','cpu-flash-f32']
p=argparse.ArgumentParser(description=__doc__)
for k in ['engine-git','runtime','out']: p.add_argument('--'+k,type=Path,required=True)
p.add_argument('--jobs',type=int,default=6)
p.add_argument('--active-kv-extent',action='store_true',help='omit attention-cache tail cells owned only by other sessions')
p.add_argument('--cpu-avx512',action='store_true',help='measured AVX-512/BF16/VBMI/VNNI CPU profile; requires those guest CPU features')
a=p.parse_args();r=Path(__file__).resolve().parents[2];w=a.out.resolve()
if w.exists():p.error('output exists')
w.mkdir();src=w/'engine-src';src.mkdir();build=w/'engine-build';rt=w/'runtime'
def run(args,**kwargs):subprocess.run([str(x) for x in args],check=True,**kwargs)
def digest(f):
 with f.open('rb') as h:return hashlib.file_digest(h,'sha256').hexdigest()
# Archive a fixed commit, never the engine checkout's possibly experimental edits.
archive=w/'engine.tar'
with archive.open('wb') as f:run(['git','-C',a.engine_git,'archive',PIN],stdout=f)
run(['tar','-xf',archive,'-C',src]);archive.unlink()
patches={}
if a.active_kv_extent: PATCHES.append('kv-active-extent')
for n in PATCHES:
 f=r/'wasm'/('llamacpp-'+n+'.patch');patches[f.name]=digest(f);run(['git','apply',f],cwd=src)
flags=['CMAKE_BUILD_TYPE=Release','BUILD_SHARED_LIBS=ON','GGML_BACKEND_DL=ON',
 'GGML_NATIVE=OFF','GGML_AVX=ON','GGML_AVX2=ON','GGML_FMA=ON','GGML_F16C=ON',
 'GGML_CUDA=OFF','GGML_BUILD_TESTS=OFF','LLAMA_BUILD_TESTS=OFF','LLAMA_BUILD_EXAMPLES=OFF',
 'LLAMA_BUILD_TOOLS=OFF','LLAMA_BUILD_SERVER=OFF','LLAMA_CURL=OFF',
 'CMAKE_C_FLAGS=-DGGML_MAX_NAME=128','CMAKE_CXX_FLAGS=-DGGML_MAX_NAME=128']
if a.cpu_avx512: flags += ['GGML_AVX512=ON','GGML_AVX512_BF16=ON','GGML_AVX512_VBMI=ON','GGML_AVX512_VNNI=ON']
run(['cmake','-S',src,'-B',build]+['-D'+f for f in flags])
run(['cmake','--build',build,'--target','llama','ggml-cpu','-j',a.jobs])
shutil.copytree(a.runtime,rt)
for n in ['libggml-base.so.0','libggml.so.0','libllama.so.0']:shutil.copyfile(build/'bin'/n,rt/n)
shutil.copyfile(build/'bin/libggml-cpu.so',rt/'backends/libggml-cpu.so')
run(['cc','-shared','-fPIC','-O2','-Wl,-soname,libenclave_llama.so','-DGGML_MAX_NAME=128',
 '-I',src/'include','-I',src/'ggml/include','-I',src/'tools/mtmd',r/'wasm/llama-shim/enclave_llama.c',
 '-L',build/'bin','-L',rt,'-lllama','-lggml','-l:libmtmd.so.0','-o',rt/'libenclave_llama.so'])
backend=w/'backend-src';backend.mkdir()
tracked=subprocess.check_output(['git','ls-files','wasm/ggml-shielded'],cwd=r,text=True).splitlines()
for n in tracked:
 f=r/n;dest=backend/f.relative_to(r/'wasm/ggml-shielded');dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(f,dest)
run(['make','-C',backend,'-j',a.jobs,'libggml-shielded.so','GGML_SRC='+str(src),'GGML_LIB='+str(build/'bin'),'CXXFLAGS=-O2 -std=c++17 -Wall -Wextra -fPIC -fno-math-errno -DGGML_MAX_NAME=128'])
shutil.copyfile(backend/'libggml-shielded.so',rt/'backends/libggml-shielded.so')
run(['cc','-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',r/'wasm/ggml-shielded/shielded-omp-affinity.c','-pthread','-ldl','-Wl,-z,noexecstack','-o',rt/'libshielded-omp-affinity.so'])
env={**os.environ,'LD_LIBRARY_PATH':str(rt)+':'+str(rt/'backends'),'LD_PRELOAD':str(rt/'libggml.so.0')}
# ggml loads plugins after its own symbols are global; mirror that when checking.
check=subprocess.check_output(['ldd','-r',str(rt/'libenclave_llama.so'),str(rt/'backends/libggml-shielded.so')],env=env,text=True,stderr=subprocess.STDOUT)
(w/'link-check.txt').write_text(check)
if 'undefined symbol' in check or 'not found' in check:raise SystemExit('runtime link check failed')
for f in rt.rglob('*.so*'):
 text=subprocess.check_output(['readelf','-W','-l',str(f)],text=True)
 if any('GNU_STACK' in l and 'RWE' in l for l in text.splitlines()):raise SystemExit('executable stack: '+str(f))
(w/'provenance.json').write_text(json.dumps({'engineCommit':PIN,'patches':patches,'cmake':flags,
 'runtime':{str(f.relative_to(rt)):digest(f) for f in sorted(rt.rglob('*')) if f.is_file()}},indent=2)+'\n')
print(rt)
