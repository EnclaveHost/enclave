from pathlib import Path
import subprocess,hashlib,json,shutil
p=Path(__file__).parent
r=Path('/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov')
w=Path('/home/steven/enclave-bench/shield-original-reclaim-20260929')
src=w/'build/engine-src'; libs=w/'build/engine-build/bin'
rt=Path('/home/steven/enclave-prod/release-af50d526/template/rt')
b=p/'candidate-build';b.mkdir(exist_ok=False)
inputs={}
def digest(f):
 with f.open('rb') as h:return hashlib.file_digest(h,'sha256').hexdigest()
old=json.loads((w/'build-deferred/provenance.json').read_text())
for n in ['enclave_llama.c','enclave_shield_loader.cpp','shield-original-source.hpp']:
 f=r/'wasm/llama-shim'/n; key='wasm/llama-shim/'+n
 expected=old.get('scratchSources',{}).get(key,old['sourceReclamation'][key])
 if digest(f)!=expected:raise SystemExit('baseline source mismatch: '+n)
 selected=p/'candidate'/n if n!='enclave_llama.c' else f
 shutil.copyfile(selected,b/n);inputs[key]=digest(selected)
commands=[['c++','-c','-fPIC','-O2','-std=c++17','-DGGML_MAX_NAME=128','-Wno-deprecated-declarations','-I',src/'include','-I',src/'src','-I',src/'ggml/include','-I',r/'wasm/ggml-shielded',b/'enclave_shield_loader.cpp','-o',b/'shield-loader.o'],['cc','-shared','-fPIC','-O2','-Wl,-soname,libenclave_llama.so','-DGGML_MAX_NAME=128','-DELL_SHIELD_SOURCE_LOADER','-I',r/'wasm/llama-shim','-I',src/'include','-I',src/'ggml/include','-I',src/'tools/mtmd',b/'enclave_llama.c','-L',libs,'-L',rt,'-lllama','-lggml','-l:libmtmd.so.0',b/'shield-loader.o','-lstdc++','-lcrypto','-o',b/'libenclave_llama.so']]
with (b/'build.log').open('w') as out:
 for cmd in commands:subprocess.run([str(x) for x in cmd],check=True,stdout=out,stderr=subprocess.STDOUT,timeout=180)
actual=digest(b/'libenclave_llama.so');installed=digest(rt/'libenclave_llama.so')
result={'sourceHashes':inputs,'commands':[[str(x) for x in cmd] for cmd in commands],'baselineBuiltSha256':actual,'installedSha256':installed,'exactMatch':actual==installed,'compiler':subprocess.check_output(['c++','--version'],text=True).splitlines()[0]}
(b/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
