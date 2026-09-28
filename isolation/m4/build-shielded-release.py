#!/usr/bin/env python3
"""Compose a quiet measured Qwen Shield release from pinned runtime/model inputs.
The host supplies no per-app engine settings. GPU reservations are written only
by assemble-app-image.sh from a validated V4 bundle, reproduced by the verifier.
"""
import argparse,hashlib,json,os,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for name in ['base','runtime','model','tokenizer','model27','tokenizer27','haltpoll-module','out']: p.add_argument('--'+name,required=True,type=Path)
a=p.parse_args();repo=Path(__file__).resolve().parents[2];out=a.out.resolve()
if out.exists():p.error('release output already exists')
if not (a.runtime/'libshielded-omp-affinity.so').is_file():p.error('runtime needs the measured OpenMP affinity helper (build-shielded-engine.py)')
wasmtime = (a.runtime/'wasmtime').read_bytes()
if any(marker not in wasmtime for marker in [b'ENCLAVE_GGML_PARK_SLOTS', b'[prefix_warming]']):
 p.error('runtime lacks prompt caching; rebuild with build-shielded-wasmtime.py')
for f,h in [(a.model,'f81d63cf49568f78154f6ddc8b114f603579360c7c878831a7f95a51dc284d24'),(a.tokenizer,'c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539'),(a.model27,'3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e'),(a.tokenizer27,'0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3')]:
 if hashlib.file_digest(f.open('rb'),'sha256').hexdigest()!=h:p.error('model/tokenizer digest mismatch')
for f in a.runtime.rglob('*.so*'):
 text=subprocess.check_output(['readelf','-W','-l',str(f)],text=True)
 if any('GNU_STACK' in l and 'RWE' in l for l in text.splitlines()):p.error('executable stack: '+str(f))
shutil.copytree(a.base,out);(out/'release.json').unlink()
t=out/'template';shutil.rmtree(t/'rt');shutil.copytree(a.runtime,t/'rt')
shutil.copy2(a.haltpoll_module,t/'cpuidle-haltpoll.ko.zst')
# The inference profile doesn't advertise unprobed optional app ABIs.
for n in ['set.enabled','mem64.enabled']:(t/'rt'/n).unlink(missing_ok=True)
(t/'rt/shield-model').write_text('qwen2.5-0.5b-q8-gguf\nqwen3.8-27b-mtp-q4-vl-gguf\n')
(t/'rt/calib').mkdir(exist_ok=True)
shutil.copy2(repo/'metal/shielded-overlay/calib/qwen2.5-0.5b-q8-gguf.calib',t/'rt/calib/qwen2.5-0.5b-q8-gguf.calib')
model=t/'models/qwen2.5-0.5b-q8-gguf';model.mkdir(parents=True)
shutil.copy2(a.model,model/'model.gguf');shutil.copy2(a.tokenizer,model/'tokenizer.json')
large=t/'models/qwen3.8-27b-mtp-q4-vl-gguf';large.mkdir(parents=True)
shutil.copy2(a.tokenizer27,large/'tokenizer.json')
shutil.copy2(repo/'metal/shielded-overlay/calib/qwen3.8-27b-mtp-q4-vl-gguf.calib',t/'rt/calib/qwen3.8-27b-mtp-q4-vl-gguf.calib')
(t/'run').mkdir(exist_ok=True)
env={k:v for k,v in os.environ.items() if k not in ('CPATH','C_INCLUDE_PATH','LIBRARY_PATH','GCC_EXEC_PREFIX','COMPILER_PATH')}
env.update(CGO_ENABLED='0',GOFLAGS='')
for name in ['front','shieldbroker','shieldmodel']:
 subprocess.run(['go','build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',str(t/name),'./'+name],cwd=repo/'isolation/m2',env=env,check=True)
musl=Path(os.environ.get('MUSL_PREFIX',str(Path.home()/'.cache/enclave-isolation/musl-1.2.6')))
subprocess.run(['/usr/bin/gcc','-specs',str(musl/'lib/musl-gcc.specs'),'-static','-O2','-o',str(t/'init'),str(repo/'isolation/m2/dominit.c')],env=env,check=True)
cmdline=json.loads((a.base/'release.json').read_text())['cmdline']
subprocess.run(['python3',str(repo/'isolation/m4/release-manifest.py'),'write',str(out),'--cmdline',cmdline],check=True)
