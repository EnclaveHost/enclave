#!/usr/bin/env python3
"""Build an opt-in compact-weight runtime from an ABI-matching production closure.
No deployment/admission is performed. Keep the matching engine and shim intact.
"""
import argparse,hashlib,json,os,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for name in ['runtime','engine-src','engine-lib','onednn-root','out']:
 p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--jobs',type=int,default=2)
p.add_argument('--incremental-source-reclaim',action='store_true')
p.add_argument('--streamed-weights',action='store_true',help='authenticated public scratch disk, exact 256-pad batches; requires updated guest launcher')
p.add_argument('--base-release',type=Path,help='also compose and verify a domain release with rebuilt measured init')
a=p.parse_args();root=Path(__file__).resolve().parents[2];out=a.out.resolve()
if out.exists():p.error('output already exists')
if not 1<=a.jobs<=16:p.error('jobs must be 1..16')
for f in [a.runtime/'backends/libggml-shielded.so',a.engine_src/'ggml/include/ggml.h',a.onednn_root/'usr/lib/libdnnl.so.3']:
 if not f.is_file():p.error('missing input '+str(f))
out.mkdir();rt=out/'runtime';shutil.copytree(a.runtime,rt);(rt/'shield-compact-weights.enabled').unlink(missing_ok=True);src=out/'backend-src';src.mkdir()
tracked=subprocess.check_output(['git','ls-files','wasm/ggml-shielded'],cwd=root,text=True).splitlines()
for name in tracked:
 f=root/name;dest=src/f.relative_to(root/'wasm/ggml-shielded');dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(f,dest)
for name in ['shielded-compact.cpp','shielded-compact.h']:
 if not (src/name).is_file():p.error('compact sources must be tracked before building')
def run(args):subprocess.run([str(x) for x in args],check=True)
run(['make','-C',src,'-j',a.jobs,'libggml-shielded.so','GGML_SRC='+str(a.engine_src.resolve()),'GGML_LIB='+str(a.engine_lib.resolve()),'SHIELDED_COMPACT_ROOT='+str(a.onednn_root.resolve()),'CXXFLAGS=-O2 -std=c++17 -Wall -Wextra -fPIC -fno-math-errno -DGGML_MAX_NAME=128'])
shutil.copyfile(src/'libggml-shielded.so',rt/'backends/libggml-shielded.so')
shutil.copyfile(a.onednn_root/'usr/lib/libdnnl.so.3',rt/'libdnnl.so.3')
(out/'licenses/onednn').mkdir(parents=True)
for name in ['LICENSE','THIRD-PARTY-PROGRAMS']:
 shutil.copyfile(a.onednn_root/'usr/share/doc/dnnl'/name,out/'licenses/onednn'/name)
run(['python3',root/'isolation/m4/runtime-closure.py',rt,'--complete-library','libdnnl.so.3'])
# Unlike Wasmtime's dependency list, this also exercises the dlopened backend.
run(['bwrap','--unshare-all','--ro-bind',rt,'/rt','--proc','/proc','--dev','/dev','--setenv','LD_PRELOAD','/rt/libggml.so.0','/rt/ld-linux-x86-64.so.2','--library-path','/rt:/rt/backends','--list','/rt/backends/libggml-shielded.so'])
for f in rt.rglob('*.so*'):
 text=subprocess.check_output(['readelf','-W','-l',str(f)],text=True)
 if any('GNU_STACK' in l and 'RWE' in l for l in text.splitlines()):raise RuntimeError('executable stack: '+str(f))
# Loader checks alone cannot catch default RWX JIT pages. Exercise integer
# GEMM in the bundled closure before creating an enabled runtime or release.
probe=out/'onednn-wx-probe'
run(['c++','-O2',root/'shielded/bench/onednn-wx-probe.cpp','-I'+str(a.onednn_root/'usr/include'),'-L'+str(rt),'-l:libdnnl.so.3','-Wl,-rpath-link,'+str(rt),'-o',probe])
run(['bwrap','--unshare-all','--ro-bind',rt,'/rt','--ro-bind',probe,'/probe','--proc','/proc','--dev','/dev','--setenv','OMP_NUM_THREADS','1','/rt/ld-linux-x86-64.so.2','--library-path','/rt','/probe'])
# Exercise the actual provider's blocked matmul plans as well as legacy GEMM.
# Use the copied build sources, not a potentially changed working tree, and
# resolve all dynamic dependencies exclusively from the staged closure.
fixture=out/'compact-release-check.cpp'
fixture.write_text((root/'test/fixtures/shielded-compact-runtime.cpp').read_text().replace(
 '#include "../../wasm/ggml-shielded/shielded-compact.cpp"',
 '#include "'+str(src/'shielded-compact.cpp')+'"'))
simd=['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni']
for name in ['shielded-simd','shielded-field']:
 run(['cc','-O2',*simd,'-DSH_SIMD_AVX512','-c',src/(name+'.c'),'-o',out/(name+'-check.o')])
layout_probe=out/'compact-release-check'
run(['c++','-O2',*simd,'-std=c++17','-pthread','-I'+str(a.onednn_root/'usr/include'),fixture,
 out/'shielded-simd-check.o',out/'shielded-field-check.o','-L'+str(rt),'-l:libdnnl.so.3',
 '-lgomp','-lcrypto','-Wl,-rpath-link,'+str(rt),'-o',layout_probe])
run(['bwrap','--unshare-all','--ro-bind',rt,'/rt','--ro-bind',layout_probe,'/probe',
 '--proc','/proc','--dev','/dev','--setenv','OMP_NUM_THREADS','1','--setenv','OMP_DYNAMIC','FALSE',
 '/rt/ld-linux-x86-64.so.2','--library-path','/rt','/probe'])
(rt/'shield-compact-weights.enabled').write_text('1\n')
for name,enabled in [('shield-incremental-source-reclaim.enabled',a.incremental_source_reclaim or a.streamed_weights),('shield-streamed-weights.enabled',a.streamed_weights)]:
 if enabled:
  if not (rt/'shield-original-source-reclaim.enabled').is_file():raise RuntimeError('requires original source reclamation')
  (rt/name).write_text('1\n')
 else:(rt/name).unlink(missing_ok=True)
def digest(f):return hashlib.sha256(f.read_bytes()).hexdigest()
(out/'provenance.json').write_text(json.dumps({'baseRuntime':str(a.runtime.resolve()),'oneDNN':digest(rt/'libdnnl.so.3'),'runtime':{str(f.relative_to(rt)):digest(f) for f in sorted(rt.rglob('*')) if f.is_file()},'sources':{str(f.relative_to(src)):digest(f) for f in sorted(src.rglob('*')) if f.is_file() and f.suffix in ['.c','.cpp','.h','.inc']}},indent=2)+'\n')
print(rt)

if a.base_release:
 base=a.base_release.resolve()
 run(['python3',root/'isolation/m4/release-manifest.py','verify',base])
 release=out/'release';shutil.copytree(base,release);(release/'release.json').unlink()
 shutil.rmtree(release/'template/rt');shutil.copytree(rt,release/'template/rt')
 musl=Path(os.environ.get('MUSL_PREFIX',str(Path.home()/'.cache/enclave-isolation/musl-1.2.6')))
 env={k:v for k,v in os.environ.items() if k not in ('CPATH','C_INCLUDE_PATH','LIBRARY_PATH','GCC_EXEC_PREFIX','COMPILER_PATH')}
 subprocess.run(['/usr/bin/gcc','-specs',str(musl/'lib/musl-gcc.specs'),'-static','-O2','-o',str(release/'template/init'),str(root/'isolation/m2/dominit.c')],env=env,check=True)
 (release/'template/rt/shield-ram-admission.enabled').write_text('1\n')
 run(['python3',root/'isolation/m4/release-manifest.py','write',release,'--cmdline',json.loads((base/'release.json').read_text())['cmdline']])
 run(['python3',root/'isolation/m4/release-manifest.py','verify',release,'--expect',digest(release/'release.json')])
 print(release)
