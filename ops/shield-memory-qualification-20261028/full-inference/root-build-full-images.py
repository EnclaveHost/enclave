"""Pinned offline image construction only. Never starts a guest, GPU worker or chain process."""
from pathlib import Path
import subprocess,sys,os,hashlib,json
m=Path(__file__).resolve().parent
out=m/'full-images-build-r1'
iso=Path('/home/steven/enclave-prod/iso-sdshield-1c3cdbb8')
rel=Path('/home/steven/enclave-prod/release-5cab66e4')
probe=m/'full-probe-build-r2';tools=m/'full-tools-build-r1'
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
if json.loads((probe/'SOURCE.json').read_text())['source_sha256']!=sha(m/'full-bench-prep/probe-bench/src/lib.rs'):raise SystemExit('probe source changed since build')
wasms=list((probe/'target/wasm32-wasip1/release').glob('*.wasm'))
if len(wasms)!=1:raise SystemExit('expected exactly one probe component')
for p,want in json.loads((tools/'BUILD.json').read_text()).items():
 if sha(p)!=want:raise SystemExit('build-tool input drift')
r=json.loads((rel/'release.json').read_text())
for name in ['kernel','firmware.fd']:
 if sha(rel/name)!=r['files'][name]['sha256']:raise SystemExit('release pin mismatch')
out.mkdir(exist_ok=False)
env=dict(os.environ,BUNDLETOOL=str(tools/'bundletool'),TMPDIR=str(out))
bundle=out/'public-probe.bundle'
subprocess.run([str(tools/'bundletool'),'build','-label','Shield RAM public canary','-world','wasi:http','-kind','wasm-component','-cpu','1600','-mem','57344','-vcpus','16','-inference-model','qwen3.8-27b-mtp-q4-vl-gguf','-gpu-milli','500',str(wasms[0]),str(bundle)],check=True,env=env)
sys.path.insert(0,str(m/'full-bench-prep'))
import fullbench
stage=fullbench.stage(str(rel),str(m/'bench-build-r1/shieldmodel'),str(out/'templates'))
record={'scope':'build only, no execution','guest_mib':57344,'vcpus':16,'app_sha256':sha(bundle),'probe_source_sha256':sha(probe/'src/lib.rs'),'candidate_loader_sha256':sha(m/'bench-build-r1/shieldmodel'),'stage_manifest_sha256':sha(out/'templates/stage-manifest.json'),'arms':{}}
for arm in ['A','B','A1']:
 image=out/f'{arm}.cpio.gz'
 subprocess.run([str(iso/'isolation/m4/assemble-app-image.sh'),str(out/'templates'/arm),str(bundle),str(image)],env=env,check=True)
 measure=subprocess.check_output(['/home/steven/.local/bin/sev-snp-measure','--mode','snp','--vcpus','16','--vcpu-family','26','--vcpu-model','2','--vcpu-stepping','1','--vmm-type','QEMU','--ovmf',str(rel/'firmware.fd'),'--kernel',str(rel/'kernel'),'--initrd',str(image),'--append',r['cmdline']],text=True).strip()
 if len(measure)!=96 or any(c not in '0123456789abcdef' for c in measure):raise SystemExit('unexpected measurement output')
 record['arms'][arm]={'image':str(image),'sha256':sha(image),'measurement':measure}
 (out/'BUILD.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
