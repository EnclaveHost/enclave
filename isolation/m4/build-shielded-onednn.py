#!/usr/bin/env python3
"""Build pinned oneDNN with W^X JIT publication for Enclave's compact provider."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
PIN='74d04752d9eaefff6a9ff62466c4d20b155e5bca' # upstream v3.11.3
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--source',type=Path,required=True)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--jobs',type=int,default=2)
a=p.parse_args();src=a.source.resolve();out=a.out.resolve()
if out.exists() or not 1<=a.jobs<=16:p.error('fresh output directory and jobs 1..16 required')
if subprocess.check_output(['git','rev-parse','HEAD'],cwd=src,text=True).strip()!=PIN:p.error('unexpected source revision')
subprocess.run(['git','diff','--exit-code','HEAD','--'],cwd=src,check=True)
out.mkdir();patched=out/'source';patched.mkdir()
# Copy only tracked, checked files, excluding ignored build products as well
# as untracked files that could otherwise alter the pinned dependency build.
for name in subprocess.check_output(['git','ls-files','-z'],cwd=src).decode().split('\0'):
 if not name:continue
 dest=patched/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src/name,dest)
h=patched/'src/cpu/x64/jit_generator.hpp';s=h.read_text()
if s.count('this->ready();')!=1:p.error('unexpected JIT publication site')
h.write_text(s.replace('this->ready();','this->readyRE(); // Enclave: publish RX, never RWX'))
build=out/'build';install=out/'install'
args=['cmake','-S',str(patched),'-B',str(build),'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX='+str(install/'usr'),'-DCMAKE_INSTALL_LIBDIR=lib','-DDNNL_CPU_RUNTIME=OMP','-DDNNL_GPU_RUNTIME=NONE','-DDNNL_BUILD_TESTS=OFF','-DDNNL_BUILD_EXAMPLES=OFF','-DONEDNN_BUILD_GRAPH=OFF','-DDNNL_ENABLE_WORKLOAD=INFERENCE','-DDNNL_ENABLE_PRIMITIVE=MATMUL','-DDNNL_ENABLE_PRIMITIVE_CPU_ISA=AVX512','-DONEDNN_ENABLE_GEMM_KERNELS_ISA=AVX512']
subprocess.run(args,check=True)
subprocess.run(['cmake','--build',str(build),'-j',str(a.jobs)],check=True)
subprocess.run(['cmake','--install',str(build)],check=True)
licenses=install/'usr/share/doc/dnnl';licenses.mkdir(parents=True,exist_ok=True)
for n in ['LICENSE','THIRD-PARTY-PROGRAMS']:shutil.copyfile(patched/n,licenses/n)
def digest(f):return hashlib.sha256(f.read_bytes()).hexdigest()
(out/'provenance.json').write_text(json.dumps({'upstream':'https://github.com/uxlfoundation/oneDNN','commit':PIN,'jitSourceSha256':digest(h),'patch':'jit_generator_t::getCode ready() -> readyRE()','cmake':args,'librarySha256':digest(install/'usr/lib/libdnnl.so.3')},indent=2)+'\n')
print(install)
